import type { PulseColor } from '../core/colors';
import type { LockedFeature } from './errors';

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
export interface RecordValue {
  t: 'registro';
  tipo: string;
  fields: Record<string, Value>;
}
/** Valor de um recurso ainda bloqueado (ex.: `hist`): qualquer uso gera erro. */
export interface LockedValue {
  t: 'bloqueado';
  feature: LockedFeature;
}
export interface BuiltinValue {
  t: 'funcao';
  name: string;
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
  | RecordValue
  | LockedValue
  | BuiltinValue;

export const TERRA: TerraValue = { t: 'terra' };
export const MANUAL: ManualValue = { t: 'manual' };

export function color(c: PulseColor): ColorValue {
  return { t: 'cor', c };
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
    case 'registro':
      return v.tipo;
    case 'bloqueado':
      return 'recurso bloqueado';
    case 'funcao':
      return 'função';
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
    case 'registro':
      return `${v.tipo}(${Object.entries(v.fields)
        .map(([k, f]) => `${k}=${formatValue(f)}`)
        .join(', ')})`;
    case 'bloqueado':
      return '<bloqueado>';
    case 'funcao':
      return `${v.name}()`;
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
  if ((a.t === 'cor' || a.t === 'saida') && (b.t === 'cor' || b.t === 'saida')) return a.c === b.c;
  return a.t === 'terra' || a.t === 'manual';
}

/** Verdade ao estilo Python: None, False, 0 e lista vazia são falsos. */
export function isTruthy(v: Value): boolean {
  if (v === null || v === false || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
