import { COLORS } from '../core/colors';
import type { BoxDef, Expr, Pos, Stmt } from './ast';
import { DslError, lockedMessage } from './errors';
import { parseBox } from './parser';
import {
  color,
  isTruthy,
  MANUAL,
  TERRA,
  typeName,
  valuesEqual,
  type BuiltinValue,
  type Value,
} from './values';

/** Teto de operações por chamada de caixa (documento conceitual: "Freios à automação"). */
export const MAX_OPS_PER_CALL = 50;

export interface BoxSignature {
  name: string;
  params: string[];
}

export type CompileResult = { ok: true; box: BoxDef } | { ok: false; error: DslError };

export type RunResult =
  | { ok: true; value: Value; ops: number }
  | { ok: false; error: DslError; ops: number; limitHit: boolean };

const GLOBALS: Record<string, Value> = {
  ...Object.fromEntries([...COLORS, 'GRAY' as const].map((c) => [c, color(c)])),
  TERRA,
  MANUAL,
  saida: { t: 'funcao', name: 'saida' },
  len: { t: 'funcao', name: 'len' },
};

/** Compila o script e confere se ele respeita a assinatura fixa da caixa. */
export function compileBox(source: string, signature: BoxSignature): CompileResult {
  try {
    const box = parseBox(source);
    if (box.name !== signature.name) {
      throw new DslError(`esta caixa se chama "${signature.name}", não "${box.name}"`, box.line, box.col);
    }
    if (box.params.length !== signature.params.length) {
      const expected = `${signature.name}(${signature.params.join(', ')})`;
      throw new DslError(`a assinatura é fixa: ${expected}`, box.line, box.col);
    }
    for (const param of box.params) {
      if (param in GLOBALS) throw new DslError(`"${param}" é um nome reservado`, box.line, box.col);
    }
    return { ok: true, box };
  } catch (e) {
    if (e instanceof DslError) return { ok: false, error: e };
    throw e;
  }
}

class OpLimitError extends DslError {}

/** Resultado de `return`, propagado como exceção para sair de blocos aninhados. */
class ReturnSignal {
  constructor(readonly value: Value) {}
}

interface Binding {
  value: Value;
  mutable: boolean;
}

/**
 * Executa uma caixa compilada. `opLimit` limita as operações desta chamada
 * (o menor entre o teto por chamada e a energia restante no turno).
 */
export function runBox(box: BoxDef, args: Value[], opLimit = MAX_OPS_PER_CALL): RunResult {
  const run = new Execution(opLimit);
  box.params.forEach((name, i) => run.scope.set(name, { value: args[i] ?? null, mutable: false }));
  try {
    run.execBlock(box.body);
    throw new DslError('a caixa terminou sem "return"', box.line, box.col);
  } catch (e) {
    if (e instanceof ReturnSignal) return { ok: true, value: e.value, ops: run.ops };
    if (e instanceof DslError) {
      return { ok: false, error: e, ops: run.ops, limitHit: e instanceof OpLimitError };
    }
    throw e;
  }
}

class Execution {
  ops = 0;
  readonly scope = new Map<string, Binding>();

  constructor(private readonly opLimit: number) {}

  private tick(at: Pos): void {
    this.ops++;
    if (this.ops > this.opLimit) {
      this.ops = this.opLimit;
      throw new OpLimitError(`limite de ${this.opLimit} operações atingido`, at.line, at.col);
    }
  }

  execBlock(stmts: Stmt[]): void {
    for (const stmt of stmts) this.exec(stmt);
  }

  private exec(stmt: Stmt): void {
    this.tick(stmt);
    switch (stmt.kind) {
      case 'pass':
        return;
      case 'return':
        throw new ReturnSignal(this.eval(stmt.value));
      case 'declare': {
        if (stmt.name in GLOBALS) throw this.error(`"${stmt.name}" é um nome reservado`, stmt);
        if (this.scope.has(stmt.name)) throw this.error(`"${stmt.name}" já foi declarada`, stmt);
        this.scope.set(stmt.name, { value: this.eval(stmt.value), mutable: stmt.mutable });
        return;
      }
      case 'assign': {
        const binding = this.scope.get(stmt.name);
        if (!binding) {
          if (stmt.name in GLOBALS) throw this.error(`"${stmt.name}" é um nome reservado`, stmt);
          throw this.error(`"${stmt.name}" não foi declarada: use "let ${stmt.name} = ..."`, stmt);
        }
        if (!binding.mutable) throw this.error(`"${stmt.name}" não pode ser alterada (é const ou parâmetro)`, stmt);
        binding.value = this.eval(stmt.value);
        return;
      }
      case 'if': {
        for (const branch of stmt.branches) {
          if (this.truthy(this.eval(branch.test), branch.test)) {
            this.execBlock(branch.body);
            return;
          }
        }
        if (stmt.orElse) this.execBlock(stmt.orElse);
        return;
      }
    }
  }

  private eval(expr: Expr): Value {
    switch (expr.kind) {
      case 'number':
        return expr.value;
      case 'bool':
        return expr.value;
      case 'none':
        return null;
      case 'name': {
        const binding = this.scope.get(expr.name);
        if (binding) return binding.value;
        if (expr.name in GLOBALS) return GLOBALS[expr.name];
        throw this.error(`"${expr.name}" não existe`, expr);
      }
      case 'list':
        this.tick(expr);
        return expr.items.map((item) => this.eval(item));
      case 'unary': {
        this.tick(expr);
        const operand = this.eval(expr.operand);
        if (expr.op === 'not') return !this.truthy(operand, expr.operand);
        return -this.number(operand, expr.operand, '-');
      }
      case 'binary':
        this.tick(expr);
        return this.evalBinary(expr);
      case 'member': {
        this.tick(expr);
        const object = this.usable(this.eval(expr.object), expr.object);
        if (object === null || typeof object !== 'object' || Array.isArray(object) || object.t !== 'registro') {
          throw this.error(`${typeName(object)} não tem campos`, expr);
        }
        if (!(expr.property in object.fields)) {
          const fields = Object.keys(object.fields).join(', ');
          throw this.error(`${object.tipo} não tem o campo "${expr.property}" (campos: ${fields})`, expr);
        }
        return object.fields[expr.property];
      }
      case 'index': {
        this.tick(expr);
        const object = this.usable(this.eval(expr.object), expr.object);
        if (!Array.isArray(object)) throw this.error(`${typeName(object)} não pode ser indexado`, expr);
        const index = this.number(this.eval(expr.index), expr.index, '[]');
        if (!Number.isInteger(index)) throw this.error('o índice deve ser inteiro', expr.index);
        const i = index < 0 ? object.length + index : index;
        if (i < 0 || i >= object.length) {
          throw this.error(`índice ${index} fora da lista de tamanho ${object.length}`, expr.index);
        }
        return object[i];
      }
      case 'call': {
        this.tick(expr);
        const callee = this.eval(expr.callee);
        if (callee === null || typeof callee !== 'object' || Array.isArray(callee) || callee.t !== 'funcao') {
          throw this.error(`${typeName(callee)} não é uma função`, expr);
        }
        return this.callBuiltin(callee, expr.args.map((arg) => this.eval(arg)), expr);
      }
    }
  }

  private evalBinary(expr: Extract<Expr, { kind: 'binary' }>): Value {
    const { op } = expr;
    if (op === 'and') {
      const left = this.eval(expr.left);
      return this.truthy(left, expr.left) ? this.eval(expr.right) : left;
    }
    if (op === 'or') {
      const left = this.eval(expr.left);
      return this.truthy(left, expr.left) ? left : this.eval(expr.right);
    }
    if (op === '??') {
      const left = this.eval(expr.left);
      return left === null ? this.eval(expr.right) : left;
    }

    const left = this.usable(this.eval(expr.left), expr.left);
    const right = this.usable(this.eval(expr.right), expr.right);
    if (op === '==') return valuesEqual(left, right);
    if (op === '!=') return !valuesEqual(left, right);

    const a = this.number(left, expr.left, op);
    const b = this.number(right, expr.right, op);
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '//':
        if (b === 0) throw this.error('divisão por zero', expr);
        return Math.floor(a / b);
      case '%':
        if (b === 0) throw this.error('módulo por zero', expr);
        return ((a % b) + b) % b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      case '>=':
        return a >= b;
    }
  }

  private callBuiltin(fn: BuiltinValue, args: Value[], at: Pos): Value {
    switch (fn.name) {
      case 'saida': {
        if (args.length !== 1) throw this.error('saida() recebe exatamente uma cor', at);
        const c = this.usable(args[0], at);
        if (c === null) throw this.error('saida(None): a cor é None (pulso velado?)', at);
        if (typeof c !== 'object' || Array.isArray(c) || c.t !== 'cor') {
          throw this.error(`saida() espera uma Cor, recebeu ${typeName(c)}`, at);
        }
        if (c.c === 'GRAY') throw this.error('não existe saída cinza: ruído vai para TERRA', at);
        return { t: 'saida', c: c.c };
      }
      case 'len': {
        if (args.length !== 1) throw this.error('len() recebe exatamente uma lista', at);
        const list = this.usable(args[0], at);
        if (!Array.isArray(list)) throw this.error(`len() espera uma lista, recebeu ${typeName(list)}`, at);
        return list.length;
      }
      default:
        throw this.error(`função desconhecida: ${fn.name}`, at);
    }
  }

  private usable(v: Value, at: Pos): Value {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && v.t === 'bloqueado') {
      throw this.error(lockedMessage(v.feature), at);
    }
    return v;
  }

  private truthy(v: Value, at: Pos): boolean {
    return isTruthy(this.usable(v, at));
  }

  private number(v: Value, at: Pos, op: string): number {
    const usable = this.usable(v, at);
    if (typeof usable !== 'number') {
      const hint = usable === null ? ' (pulso velado? use "??")' : '';
      throw this.error(`"${op}" espera número, recebeu ${typeName(usable)}${hint}`, at);
    }
    return usable;
  }

  private error(message: string, at: Pos): DslError {
    return new DslError(message, at.line, at.col);
  }
}
