import type { Dir, RouteAction } from '../core/colors';
import type { BoxDef } from '../dsl/ast';
import { DslError } from '../dsl/errors';
import { compileBox, runBox, type BoxSignature, type CompileResult, type HostFunction } from '../dsl/interpreter';
import { color, dir, formatValue, record, shape, typeName, type RecordValue, type Value } from '../dsl/values';
import type { Grid } from './board';
import type { Destination, PulseView } from './types';

export type BoxId = 'classificar' | 'rotear';

export const SIGNATURES: Record<BoxId, BoxSignature> = {
  classificar: { name: 'classificar', params: ['p', 'hist'] },
  rotear: { name: 'rotear', params: ['j', 'p', 'destino'], host: ['ocupado'] },
};

/** Quantos pulsos anteriores o Classificador recebe em `hist`. */
export const HIST_SIZE = 10;

export function compileFor(box: BoxId, source: string): CompileResult {
  return compileBox(source, SIGNATURES[box]);
}

export function pulseRecord(p: PulseView): Value {
  return record('Pulso', {
    cor: p.cor === null ? null : color(p.cor),
    porta: p.porta,
    seq: p.seq,
    turno: p.turno,
    carga: p.carga,
    forma: shape(p.forma),
  });
}

export function relayRecord(grid: Grid, row: number, col: number): Value {
  return record('Rele', {
    linha: row,
    coluna: col,
    norte: grid.canGo(row, col, 'NORTE'),
    leste: grid.canGo(row, col, 'LESTE'),
    sul: grid.canGo(row, col, 'SUL'),
    direcao: dir(grid.dir(row, col)),
  });
}

export function destRecord(grid: Grid, dest: Destination | null): Value {
  if (!dest) return null;
  return record('Destino', {
    linha: grid.rowOf(dest),
    cor: dest.kind === 'saida' ? color(dest.cor) : null,
    terra: dest.kind === 'terra',
  });
}

// ---- Classificador ----

export type Decision = Destination | { kind: 'manual' };

export type BoxFailure = { ok: false; message: string; line: number; ops: number; limitHit: boolean };

export type ClassifyResult = { ok: true; decision: Decision; ops: number } | BoxFailure;

export function classify(box: BoxDef, pulse: PulseView, hist: PulseView[], opLimit: number): ClassifyResult {
  const result = runBox(box, [pulseRecord(pulse), hist.map(pulseRecord)], opLimit);
  if (!result.ok) return failure(result.error, result.ops, result.limitHit);
  const v = result.value;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (v.t === 'terra') return { ok: true, decision: { kind: 'terra' }, ops: result.ops };
    if (v.t === 'manual') return { ok: true, decision: { kind: 'manual' }, ops: result.ops };
    if (v.t === 'saida' && v.c !== 'GRAY') return { ok: true, decision: { kind: 'saida', cor: v.c }, ops: result.ops };
  }
  const hint =
    v !== null && typeof v === 'object' && !Array.isArray(v) && v.t === 'cor'
      ? `retorne saida(${v.c}), não a cor sozinha`
      : `retorno inválido: ${formatValue(v)} (esperado saida(COR), TERRA ou MANUAL)`;
  return { ok: false, message: hint, line: box.line, ops: result.ops, limitHit: false };
}

// ---- Roteador ----

export type RouteResult = { ok: true; action: RouteAction; ops: number } | BoxFailure;

/**
 * Roda o Roteador para um pulso parado num relé. `heading` é a direção em que ele vinha
 * (`p.direcao`); `occupied(d)` responde ao sensor `ocupado(j, DIR)`.
 */
export function route(
  box: BoxDef,
  grid: Grid,
  row: number,
  col: number,
  pulse: PulseView,
  heading: Dir,
  dest: Destination | null,
  occupied: (d: Dir) => boolean,
  opLimit: number,
): RouteResult {
  const ocupado: HostFunction = (args, at) => {
    if (args.length !== 2) throw new DslError('ocupado(j, DIR) recebe o relé e uma direção', at.line, at.col);
    const d = args[1];
    if (d === null || typeof d !== 'object' || Array.isArray(d) || d.t !== 'dir' || d.d === 'ESPERAR' || d.d === 'MANTER') {
      throw new DslError(`ocupado() espera NORTE, LESTE ou SUL, recebeu ${formatValue(d)}`, at.line, at.col);
    }
    return occupied(d.d);
  };
  const p = pulseRecord(pulse) as RecordValue;
  const moving = record('Pulso', { ...p.fields, direcao: dir(heading) });
  const result = runBox(box, [relayRecord(grid, row, col), moving, destRecord(grid, dest)], opLimit, { ocupado });
  if (!result.ok) return failure(result.error, result.ops, result.limitHit);
  const v = result.value;
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && v.t === 'dir') {
    return { ok: true, action: v.d, ops: result.ops };
  }
  return {
    ok: false,
    message: `retorno inválido: ${typeName(v)} (esperado NORTE, LESTE, SUL, ESPERAR ou MANTER)`,
    line: box.line,
    ops: result.ops,
    limitHit: false,
  };
}

function failure(error: DslError, ops: number, limitHit: boolean): BoxFailure {
  return { ok: false, message: error.message, line: error.line, ops, limitHit };
}
