import type { PulseColor, RouteAction, Shape } from '../core/colors';
import type { Expr } from './ast';

export interface ColorValue {
  t: 'cor';
  c: PulseColor;
}
export interface ExitValue {
  t: 'saida';
  c: PulseColor;
}
export interface TerraValue {
  t: 'terra';
}
export interface ManualValue {
  t: 'manual';
}
/** Direção de um relé ou ação do Roteador: NORTE, LESTE, SUL, ESPERAR, MANTER. */
export interface DirValue {
  t: 'dir';
  d: RouteAction;
}
export interface ShapeValue {
  t: 'forma';
  f: Shape;
}
export interface RecordValue {
  t: 'registro';
  tipo: string;
  fields: Record<string, Value>;
}
export interface BuiltinValue {
  t: 'funcao';
  name: string;
}
/** Função anônima `x => expressão` (recurso Funcional). */
export interface LambdaValue {
  t: 'lambda';
  param: string;
  body: Expr;
}
/** Método de lista já ligado à lista: `hist.filter`, `hist.map`, `hist.some`. */
export interface MethodValue {
  t: 'metodo';
  name: string;
  receiver: Value[];
}
/** Constante sem valor numérico: tipos de evento (`ENTREGA`…) e `ALERTA`. */
export interface SymbolValue {
  t: 'simbolo';
  s: string;
}

export type Value =
  | number
  | boolean
  | null
  | Value[]
  | ColorValue
  | ExitValue
  | TerraValue
  | ManualValue
  | DirValue
  | ShapeValue
  | RecordValue
  | BuiltinValue
  | LambdaValue
  | MethodValue
  | SymbolValue;

export const TERRA: TerraValue = { t: 'terra' };
export const MANUAL: ManualValue = { t: 'manual' };

export function color(c: PulseColor): ColorValue {
  return { t: 'cor', c };
}

export function dir(d: RouteAction): DirValue {
  return { t: 'dir', d };
}

export function shape(f: Shape): ShapeValue {
  return { t: 'forma', f };
}

export function record(tipo: string, fields: Record<string, Value>): RecordValue {
  return { t: 'registro', tipo, fields };
}

export function symbol(s: string): SymbolValue {
  return { t: 'simbolo', s };
}

export function typeName(v: Value): string {
  if (v === null) return 'None';
  if (typeof v === 'number') return 'número';
  if (typeof v === 'boolean') return 'booleano';
  if (Array.isArray(v)) return 'lista';
  switch (v.t) {
    case 'cor':
      return 'Cor';
    case 'saida':
      return 'Saida';
    case 'terra':
      return 'TERRA';
    case 'manual':
      return 'MANUAL';
    case 'dir':
      return 'Direção';
    case 'forma':
      return 'Forma';
    case 'registro':
      return v.tipo;
    case 'funcao':
    case 'lambda':
    case 'metodo':
      return 'função';
    case 'simbolo':
      return 'Símbolo';
  }
}

/** Representação curta para mensagens e para a bancada de testes. */
export function formatValue(v: Value): string {
  if (v === null) return 'None';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  switch (v.t) {
    case 'cor':
      return v.c;
    case 'saida':
      return `saida(${v.c})`;
    case 'terra':
      return 'TERRA';
    case 'manual':
      return 'MANUAL';
    case 'dir':
      return v.d;
    case 'forma':
      return v.f;
    case 'registro':
      return `${v.tipo}(${Object.entries(v.fields)
        .map(([k, f]) => `${k}=${formatValue(f)}`)
        .join(', ')})`;
    case 'funcao':
      return `${v.name}()`;
    case 'lambda':
      return `${v.param} => …`;
    case 'metodo':
      return `.${v.name}()`;
    case 'simbolo':
      return v.s;
  }
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'cor':
    case 'saida':
      return a.c === (b as ColorValue | ExitValue).c;
    case 'dir':
      return a.d === (b as DirValue).d;
    case 'forma':
      return a.f === (b as ShapeValue).f;
    case 'simbolo':
      return a.s === (b as SymbolValue).s;
    case 'terra':
    case 'manual':
      return true;
    case 'registro':
    case 'funcao':
    case 'lambda':
    case 'metodo':
      return false;
  }
}

/** Verdade ao estilo Python: None, False, 0 e lista vazia são falsos. */
export function isTruthy(v: Value): boolean {
  if (v === null || v === false || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
