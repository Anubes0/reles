import { COLORS, SHAPES } from '../core/colors';
import type { BoxDef, Expr, Pos, Stmt } from './ast';
import { DslError, lockedMessage, NO_FEATURES, type Features, type LockedFeature } from './errors';
import { parseBox } from './parser';
import {
  color,
  dir,
  isTruthy,
  MANUAL,
  shape,
  symbol,
  TERRA,
  typeName,
  valuesEqual,
  type BuiltinValue,
  type LambdaValue,
  type Value,
} from './values';

/** Teto de operações por chamada de caixa (documento conceitual: "Freios à automação"). */
export const MAX_OPS_PER_CALL = 120;
const MAX_RANGE = 100;
const LIST_METHODS = ['filter', 'map', 'some'];

/**
 * Função fornecida pelo jogo para uma caixa (ex.: `ocupado` no Roteador).
 * `spend(n)` cobra operações extras de funções caras, como os sensores avançados.
 */
export type HostFunction = (args: Value[], at: Pos, spend: (ops: number) => void) => Value;

export interface BoxSignature {
  name: string;
  params: string[];
  /** Funções do jogo disponíveis nesta caixa. */
  host?: string[];
  /** Nomes que existem no design mas ainda estão bloqueados (usar é erro de compilação). */
  locked?: Record<string, LockedFeature>;
  /** Globais extras desta caixa (ex.: `mem`). */
  globals?: string[];
  /** Caixas que só registram (Aprendiz) não precisam de `return`. */
  returns?: boolean;
}

export type CompileResult = { ok: true; box: BoxDef } | { ok: false; error: DslError };

export type RunResult =
  | { ok: true; value: Value; ops: number }
  | { ok: false; error: DslError; ops: number; limitHit: boolean };

export interface RunEnv {
  host?: Record<string, HostFunction>;
  globals?: Record<string, Value>;
  features?: Features;
  requireReturn?: boolean;
}

const BUILTINS = ['saida', 'len', 'range'];
const SYMBOLS = ['ENTREGA', 'COLISAO', 'QUEIMOU', 'ALERTA'];

const GLOBALS: Record<string, Value> = {
  ...Object.fromEntries([...COLORS, 'GRAY' as const].map((c) => [c, color(c)])),
  ...Object.fromEntries(SHAPES.map((f) => [f, shape(f)])),
  ...Object.fromEntries(SYMBOLS.map((s) => [s, symbol(s)])),
  NORTE: dir('NORTE'),
  LESTE: dir('LESTE'),
  SUL: dir('SUL'),
  ESPERAR: dir('ESPERAR'),
  MANTER: dir('MANTER'),
  TERRA,
  MANUAL,
  ...Object.fromEntries(BUILTINS.map((name) => [name, { t: 'funcao', name } as BuiltinValue])),
};

/** Nomes que nunca podem virar variável, estejam liberados ou não. */
const ALWAYS_RESERVED = ['mem', 'ocupado', 'vizinhos', 'dist'];

/** Nomes que o jogador não pode usar para variáveis. */
export function isReservedName(name: string): boolean {
  return name in GLOBALS || ALWAYS_RESERVED.includes(name);
}

/** Compila o script e confere a assinatura fixa da caixa e os recursos bloqueados. */
export function compileBox(source: string, signature: BoxSignature, features: Features = NO_FEATURES): CompileResult {
  try {
    const box = parseBox(source, features);
    if (box.name !== signature.name) {
      throw new DslError(`esta caixa se chama "${signature.name}", não "${box.name}"`, box.line, box.col);
    }
    if (box.params.length !== signature.params.length) {
      const expected = `${signature.name}(${signature.params.join(', ')})`;
      throw new DslError(`a assinatura é fixa: ${expected}`, box.line, box.col);
    }
    for (const param of box.params) {
      if (isReservedName(param)) throw new DslError(`"${param}" é um nome reservado`, box.line, box.col);
    }
    checkLockedNames(box.body, signature.locked ?? {});
    return { ok: true, box };
  } catch (e) {
    if (e instanceof DslError) return { ok: false, error: e };
    throw e;
  }
}

/** Percorre o código atrás de nomes de recursos ainda bloqueados. */
function checkLockedNames(body: Stmt[], locked: Record<string, LockedFeature>): void {
  if (Object.keys(locked).length === 0) return;
  const visitExpr = (e: Expr | null): void => {
    if (!e) return;
    switch (e.kind) {
      case 'name':
        if (e.name in locked) throw new DslError(`"${e.name}": ${lockedMessage(locked[e.name])}`, e.line, e.col);
        return;
      case 'list':
        e.items.forEach(visitExpr);
        return;
      case 'unary':
        visitExpr(e.operand);
        return;
      case 'binary':
        visitExpr(e.left);
        visitExpr(e.right);
        return;
      case 'call':
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        return;
      case 'member':
        visitExpr(e.object);
        return;
      case 'index':
        visitExpr(e.object);
        visitExpr(e.index);
        return;
      case 'slice':
        visitExpr(e.object);
        visitExpr(e.start);
        visitExpr(e.end);
        return;
      case 'lambda':
        visitExpr(e.body);
        return;
      default:
        return;
    }
  };
  const visit = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      switch (s.kind) {
        case 'declare':
        case 'assign':
        case 'return':
          visitExpr(s.value);
          break;
        case 'assignIndex':
          if (s.name in locked) throw new DslError(`"${s.name}": ${lockedMessage(locked[s.name])}`, s.line, s.col);
          visitExpr(s.index);
          visitExpr(s.value);
          break;
        case 'if':
          for (const b of s.branches) {
            visitExpr(b.test);
            visit(b.body);
          }
          if (s.orElse) visit(s.orElse);
          break;
        case 'for':
          visitExpr(s.iterable);
          visit(s.body);
          break;
        case 'match':
          visitExpr(s.subject);
          for (const c of s.cases) {
            c.patterns?.forEach(visitExpr);
            visit(c.body);
          }
          break;
        default:
          break;
      }
    }
  };
  visit(body);
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
export function runBox(box: BoxDef, args: Value[], opLimit = MAX_OPS_PER_CALL, env: RunEnv = {}): RunResult {
  const run = new Execution(opLimit, env);
  box.params.forEach((name, i) => run.scope.set(name, { value: args[i] ?? null, mutable: false }));
  try {
    run.execBlock(box.body);
    if (env.requireReturn === false) return { ok: true, value: null, ops: run.ops };
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
  /** Escopo da caixa (parâmetros); cada bloco empilha o seu por cima, como no JavaScript. */
  readonly scope = new Map<string, Binding>();
  private readonly scopes: Map<string, Binding>[] = [this.scope];
  private readonly host: Record<string, HostFunction>;
  private readonly globals: Record<string, Value>;
  private readonly features: Features;

  constructor(
    private readonly opLimit: number,
    env: RunEnv,
  ) {
    this.host = env.host ?? {};
    this.globals = env.globals ?? {};
    this.features = env.features ?? NO_FEATURES;
  }

  private tick(at: Pos, count = 1): void {
    this.ops += count;
    if (this.ops > this.opLimit) {
      this.ops = this.opLimit;
      throw new OpLimitError(`limite de ${this.opLimit} operações atingido`, at.line, at.col);
    }
  }

  execBlock(stmts: Stmt[]): void {
    for (const stmt of stmts) this.exec(stmt);
  }

  /** Executa um bloco com escopo próprio: o que se declara nele some ao fim. */
  private execScoped(stmts: Stmt[], bindings: [string, Binding][] = []): void {
    this.scopes.push(new Map(bindings));
    try {
      this.execBlock(stmts);
    } finally {
      this.scopes.pop();
    }
  }

  private lookup(name: string): Binding | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const binding = this.scopes[i].get(name);
      if (binding) return binding;
    }
    return undefined;
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
        const current = this.scopes[this.scopes.length - 1];
        if (current.has(stmt.name)) throw this.error(`"${stmt.name}" já foi declarada neste bloco`, stmt);
        current.set(stmt.name, { value: this.eval(stmt.value), mutable: stmt.mutable });
        return;
      }
      case 'assign': {
        const binding = this.lookup(stmt.name);
        if (!binding) {
          this.checkAssignable(stmt.name, stmt);
          throw this.error(`"${stmt.name}" não foi declarada: use "let ${stmt.name} = ..."`, stmt);
        }
        if (!binding.mutable) throw this.error(`"${stmt.name}" não pode ser alterada (é const ou parâmetro)`, stmt);
        binding.value = this.eval(stmt.value);
        return;
      }
      case 'assignIndex': {
        const list = this.assignableList(stmt.name, stmt);
        const index = this.integer(this.eval(stmt.index), stmt.index, '[]');
        const i = index < 0 ? list.length + index : index;
        if (i < 0 || i >= list.length) {
          throw this.error(`índice ${index} fora da lista de tamanho ${list.length}`, stmt.index);
        }
        list[i] = this.eval(stmt.value);
        return;
      }
      case 'if': {
        for (const branch of stmt.branches) {
          if (isTruthy(this.eval(branch.test))) {
            this.execScoped(branch.body);
            return;
          }
        }
        if (stmt.orElse) this.execScoped(stmt.orElse);
        return;
      }
      case 'for': {
        const items = this.eval(stmt.iterable);
        if (!Array.isArray(items)) throw this.error(`"for" percorre listas, recebeu ${typeName(items)}`, stmt.iterable);
        this.checkAssignable(stmt.name, stmt);
        for (const item of [...items]) {
          this.tick(stmt);
          try {
            // Cada volta tem escopo próprio, com a variável do laço dentro dele.
            this.execScoped(stmt.body, [[stmt.name, { value: item, mutable: true }]]);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'match': {
        const subject = this.eval(stmt.subject);
        for (const c of stmt.cases) {
          if (c.patterns === null || c.patterns.some((p) => valuesEqual(subject, this.eval(p)))) {
            this.execScoped(c.body);
            return;
          }
        }
        return;
      }
    }
  }

  /** `mem[i] = ...` ou `lista[i] = ...` numa variável `let`. */
  private assignableList(name: string, at: Pos): Value[] {
    const binding = this.lookup(name);
    if (binding) {
      if (!binding.mutable) throw this.error(`"${name}" não pode ser alterada (é const ou parâmetro)`, at);
      if (!Array.isArray(binding.value)) throw this.error(`"${name}" não é uma lista`, at);
      return binding.value;
    }
    const global = this.globals[name];
    if (Array.isArray(global)) return global;
    if (name in GLOBALS) throw this.error(`"${name}" é um nome reservado`, at);
    throw this.error(`"${name}" não existe`, at);
  }

  private checkAssignable(name: string, at: Pos): void {
    if (isReservedName(name) || name in this.host || name in this.globals) {
      throw this.error(`"${name}" é um nome reservado`, at);
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
        const binding = this.lookup(expr.name);
        if (binding) return binding.value;
        if (expr.name in this.globals) return this.globals[expr.name];
        if (expr.name in GLOBALS) return GLOBALS[expr.name];
        if (expr.name in this.host) return { t: 'funcao', name: expr.name };
        throw this.error(`"${expr.name}" não existe`, expr);
      }
      case 'list':
        this.tick(expr);
        return expr.items.map((item) => this.eval(item));
      case 'lambda':
        return { t: 'lambda', param: expr.param, body: expr.body };
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
        if (Array.isArray(object) && LIST_METHODS.includes(expr.property)) {
          return { t: 'metodo', name: expr.property, receiver: object };
        }
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
        return this.callValue(callee, expr.args.map((arg) => this.eval(arg)), expr);
      }
    }
  }

  private callValue(callee: Value, args: Value[], at: Pos): Value {
    if (callee === null || typeof callee !== 'object' || Array.isArray(callee)) {
      throw this.error(`${typeName(callee)} não é uma função`, at);
    }
    switch (callee.t) {
      case 'funcao':
        return this.callBuiltin(callee, args, at);
      case 'lambda':
        return this.callLambda(callee, args, at);
      case 'metodo':
        return this.callMethod(callee.name, callee.receiver, args, at);
      default:
        throw this.error(`${typeName(callee)} não é uma função`, at);
    }
  }

  private callLambda(fn: LambdaValue, args: Value[], at: Pos): Value {
    if (args.length !== 1) throw this.error(`a função "${fn.param} => …" recebe exatamente um valor`, at);
    this.tick(at);
    this.scopes.push(new Map([[fn.param, { value: args[0], mutable: false }]]));
    try {
      return this.eval(fn.body);
    } finally {
      this.scopes.pop();
    }
  }

  private callMethod(name: string, list: Value[], args: Value[], at: Pos): Value {
    if (!this.features.funcional) throw this.error(`.${name}(): ${lockedMessage('funcional')}`, at);
    if (args.length !== 1) throw this.error(`.${name}() recebe exatamente uma função`, at);
    const fn = args[0];
    const apply = (item: Value) => this.callValue(fn, [item], at);
    switch (name) {
      case 'filter':
        return list.filter((item) => isTruthy(apply(item)));
      case 'map':
        return list.map(apply);
      default:
        return list.some((item) => isTruthy(apply(item)));
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

  private callBuiltin(fn: BuiltinValue, args: Value[], at: Pos): Value {
    const hostFn = this.host[fn.name];
    if (hostFn) return hostFn(args, at, (ops) => this.tick(at, ops));
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
