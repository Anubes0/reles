import { COLORS, SHAPES } from '../core/colors';
import type { BoxDef, Expr, Pos, Stmt } from './ast';
import { DslError } from './errors';
import { parseBox } from './parser';
import {
  color,
  dir,
  isTruthy,
  MANUAL,
  shape,
  TERRA,
  typeName,
  valuesEqual,
  type BuiltinValue,
  type Value,
} from './values';

/** Teto de operações por chamada de caixa (documento conceitual: "Freios à automação"). */
export const MAX_OPS_PER_CALL = 120;
const MAX_RANGE = 100;

/** Função fornecida pelo jogo para uma caixa específica (ex.: `ocupado` no Roteador). */
export type HostFunction = (args: Value[], at: Pos) => Value;

export interface BoxSignature {
  name: string;
  params: string[];
  /** Funções do jogo disponíveis só nesta caixa. */
  host?: string[];
}

export type CompileResult = { ok: true; box: BoxDef } | { ok: false; error: DslError };

export type RunResult =
  | { ok: true; value: Value; ops: number }
  | { ok: false; error: DslError; ops: number; limitHit: boolean };

const BUILTINS = ['saida', 'len', 'range'];

const GLOBALS: Record<string, Value> = {
  ...Object.fromEntries([...COLORS, 'GRAY' as const].map((c) => [c, color(c)])),
  ...Object.fromEntries(SHAPES.map((f) => [f, shape(f)])),
  NORTE: dir('NORTE'),
  LESTE: dir('LESTE'),
  SUL: dir('SUL'),
  ESPERAR: dir('ESPERAR'),
  MANTER: dir('MANTER'),
  TERRA,
  MANUAL,
  ...Object.fromEntries(BUILTINS.map((name) => [name, { t: 'funcao', name } as BuiltinValue])),
};

/** Nomes que o jogador não pode usar para variáveis. */
export function isReservedName(name: string): boolean {
  return name in GLOBALS;
}

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
      if (param in GLOBALS || signature.host?.includes(param)) {
        throw new DslError(`"${param}" é um nome reservado`, box.line, box.col);
      }
    }
    return { ok: true, box };
  } catch (e) {
    if (e instanceof DslError) return { ok: false, error: e };
    throw e;
  }
}

class OpLimitError extends DslError {}

/** Sinais de controle, propagados como exceções para sair de blocos aninhados. */
class ReturnSignal {
  constructor(readonly value: Value) {}
}
class BreakSignal {}
class ContinueSignal {}

interface Binding {
  value: Value;
  mutable: boolean;
}

/**
 * Executa uma caixa compilada. `opLimit` limita as operações desta chamada
 * (o menor entre o teto por chamada e a energia restante no turno).
 */
export function runBox(
  box: BoxDef,
  args: Value[],
  opLimit = MAX_OPS_PER_CALL,
  host: Record<string, HostFunction> = {},
): RunResult {
  const run = new Execution(opLimit, host);
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

  constructor(
    private readonly opLimit: number,
    private readonly host: Record<string, HostFunction>,
  ) {}

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
      case 'break':
        throw new BreakSignal();
      case 'continue':
        throw new ContinueSignal();
      case 'declare': {
        this.checkAssignable(stmt.name, stmt);
        if (this.scope.has(stmt.name)) throw this.error(`"${stmt.name}" já foi declarada`, stmt);
        this.scope.set(stmt.name, { value: this.eval(stmt.value), mutable: stmt.mutable });
        return;
      }
      case 'assign': {
        const binding = this.scope.get(stmt.name);
        if (!binding) {
          this.checkAssignable(stmt.name, stmt);
          throw this.error(`"${stmt.name}" não foi declarada: use "let ${stmt.name} = ..."`, stmt);
        }
        if (!binding.mutable) throw this.error(`"${stmt.name}" não pode ser alterada (é const ou parâmetro)`, stmt);
        binding.value = this.eval(stmt.value);
        return;
      }
      case 'if': {
        for (const branch of stmt.branches) {
          if (isTruthy(this.eval(branch.test))) {
            this.execBlock(branch.body);
            return;
          }
        }
        if (stmt.orElse) this.execBlock(stmt.orElse);
        return;
      }
      case 'for': {
        const items = this.eval(stmt.iterable);
        if (!Array.isArray(items)) throw this.error(`"for" percorre listas, recebeu ${typeName(items)}`, stmt.iterable);
        this.checkAssignable(stmt.name, stmt);
        const existing = this.scope.get(stmt.name);
        if (existing && !existing.mutable) {
          throw this.error(`"${stmt.name}" não pode ser a variável do laço (é const ou parâmetro)`, stmt);
        }
        for (const item of [...items]) {
          this.tick(stmt);
          this.scope.set(stmt.name, { value: item, mutable: true });
          try {
            this.execBlock(stmt.body);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
    }
  }

  private checkAssignable(name: string, at: Pos): void {
    if (name in GLOBALS || name in this.host) throw this.error(`"${name}" é um nome reservado`, at);
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
        if (expr.name in this.host) return { t: 'funcao', name: expr.name };
        throw this.error(`"${expr.name}" não existe`, expr);
      }
      case 'list':
        this.tick(expr);
        return expr.items.map((item) => this.eval(item));
      case 'unary': {
        this.tick(expr);
        const operand = this.eval(expr.operand);
        if (expr.op === 'not') return !isTruthy(operand);
        return -this.number(operand, expr.operand, '-');
      }
      case 'binary':
        this.tick(expr);
        return this.evalBinary(expr);
      case 'member': {
        this.tick(expr);
        const object = this.eval(expr.object);
        if (object === null || typeof object !== 'object' || Array.isArray(object) || object.t !== 'registro') {
          const hint = object === null ? ' (o valor é None)' : '';
          throw this.error(`${typeName(object)} não tem campos${hint}`, expr);
        }
        if (!(expr.property in object.fields)) {
          const fields = Object.keys(object.fields).join(', ');
          throw this.error(`${object.tipo} não tem o campo "${expr.property}" (campos: ${fields})`, expr);
        }
        return object.fields[expr.property];
      }
      case 'index': {
        this.tick(expr);
        const object = this.eval(expr.object);
        if (!Array.isArray(object)) throw this.error(`${typeName(object)} não pode ser indexado`, expr);
        const index = this.integer(this.eval(expr.index), expr.index, '[]');
        const i = index < 0 ? object.length + index : index;
        if (i < 0 || i >= object.length) {
          throw this.error(`índice ${index} fora da lista de tamanho ${object.length}`, expr.index);
        }
        return object[i];
      }
      case 'slice': {
        this.tick(expr);
        const object = this.eval(expr.object);
        if (!Array.isArray(object)) throw this.error(`${typeName(object)} não pode ser fatiado`, expr);
        const bound = (e: Expr | null, fallback: number) => {
          if (!e) return fallback;
          const n = this.integer(this.eval(e), e, '[:]');
          return n < 0 ? Math.max(0, object.length + n) : Math.min(n, object.length);
        };
        return object.slice(bound(expr.start, 0), bound(expr.end, object.length));
      }
      case 'call': {
        this.tick(expr);
        const callee = this.eval(expr.callee);
        if (callee === null || typeof callee !== 'object' || Array.isArray(callee) || callee.t !== 'funcao') {
          throw this.error(`${typeName(callee)} não é uma função`, expr);
        }
        return this.call(callee, expr.args.map((arg) => this.eval(arg)), expr);
      }
    }
  }

  private evalBinary(expr: Extract<Expr, { kind: 'binary' }>): Value {
    const { op } = expr;
    if (op === 'and') {
      const left = this.eval(expr.left);
      return isTruthy(left) ? this.eval(expr.right) : left;
    }
    if (op === 'or') {
      const left = this.eval(expr.left);
      return isTruthy(left) ? left : this.eval(expr.right);
    }
    if (op === '??') {
      const left = this.eval(expr.left);
      return left === null ? this.eval(expr.right) : left;
    }

    const left = this.eval(expr.left);
    const right = this.eval(expr.right);
    if (op === '==') return valuesEqual(left, right);
    if (op === '!=') return !valuesEqual(left, right);
    if (op === '+' && Array.isArray(left) && Array.isArray(right)) return [...left, ...right];

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

  private call(fn: BuiltinValue, args: Value[], at: Pos): Value {
    const hostFn = this.host[fn.name];
    if (hostFn) return hostFn(args, at);
    switch (fn.name) {
      case 'saida': {
        if (args.length !== 1) throw this.error('saida() recebe exatamente uma cor', at);
        const c = args[0];
        if (c === null) throw this.error('saida(None): a cor é None (pulso velado?)', at);
        if (typeof c !== 'object' || Array.isArray(c) || c.t !== 'cor') {
          throw this.error(`saida() espera uma Cor, recebeu ${typeName(c)}`, at);
        }
        if (c.c === 'GRAY') throw this.error('não existe saída cinza: ruído vai para TERRA', at);
        return { t: 'saida', c: c.c };
      }
      case 'len': {
        if (args.length !== 1) throw this.error('len() recebe exatamente uma lista', at);
        const list = args[0];
        if (!Array.isArray(list)) throw this.error(`len() espera uma lista, recebeu ${typeName(list)}`, at);
        return list.length;
      }
      case 'range': {
        if (args.length !== 1) throw this.error('range() recebe um número: range(n) dá 0, 1, …, n−1', at);
        const n = this.integer(args[0], at, 'range()');
        if (n < 0 || n > MAX_RANGE) throw this.error(`range() aceita de 0 a ${MAX_RANGE}`, at);
        return Array.from({ length: n }, (_, i) => i);
      }
      default:
        throw this.error(`função desconhecida: ${fn.name}`, at);
    }
  }

  private number(v: Value, at: Pos, op: string): number {
    if (typeof v !== 'number') {
      const hint = v === null ? ' (pulso velado? use "??")' : '';
      throw this.error(`"${op}" espera número, recebeu ${typeName(v)}${hint}`, at);
    }
    return v;
  }

  private integer(v: Value, at: Pos, op: string): number {
    const n = this.number(v, at, op);
    if (!Number.isInteger(n)) throw this.error(`"${op}" espera um número inteiro`, at);
    return n;
  }

  private error(message: string, at: Pos): DslError {
    return new DslError(message, at.line, at.col);
  }
}
