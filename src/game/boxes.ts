import type { Dir, PulseColor, RouteAction } from '../core/colors';
import type { BoxDef } from '../dsl/ast';
import { DslError, NO_FEATURES, type Features, type LockedFeature } from '../dsl/errors';
import { compileBox, runBox, type BoxSignature, type CompileResult, type HostFunction, type RunEnv } from '../dsl/interpreter';
import { color, dir, formatValue, record, shape, symbol, typeName, type RecordValue, type Value } from '../dsl/values';
import type { Grid } from './board';
import type { ResearchId } from './research';
import type { Destination, EventView, PulseView } from './types';

export type BoxId = 'classificar' | 'rotear' | 'prever' | 'vigiar' | 'aprender';
export const BOX_IDS: BoxId[] = ['classificar', 'rotear', 'prever', 'vigiar', 'aprender'];

export interface BoxInfo {
  label: string;
  signature: string;
  /** Item de pesquisa que libera a caixa (Classificador e Roteador vêm liberados). */
  research?: ResearchId;
}

export const BOX_INFO: Record<BoxId, BoxInfo> = {
  classificar: { label: 'Classificador', signature: 'classificar(p, hist)' },
  rotear: { label: 'Roteador', signature: 'rotear(j, p, destino)' },
  prever: { label: 'Previsor', signature: 'prever(hist)', research: 'prever' },
  vigiar: { label: 'Vigia', signature: 'vigiar(evento, hist)', research: 'vigiar' },
  aprender: { label: 'Aprendiz', signature: 'ao_entregar(p, ok)', research: 'aprender' },
};

/** Quantos itens anteriores as caixas recebem em `hist`. */
export const HIST_SIZE = 10;
/** Posições da memória compartilhada (recurso Memória). */
export const MEM_SIZE = 8;
/** Operações extras cobradas pelos sensores avançados. */
const COST_NEIGHBORS = 4;
const COST_DISTANCE = 12;

/** Assinatura de cada caixa, com os nomes ainda bloqueados para quem está jogando. */
export function signatureFor(box: BoxId, features: Features = NO_FEATURES): BoxSignature {
  const locked: Record<string, LockedFeature> = {};
  if (!features.memoria) locked.mem = 'memoria';
  const globals = features.memoria ? ['mem'] : [];
  switch (box) {
    case 'classificar':
      return { name: 'classificar', params: ['p', 'hist'], locked, globals };
    case 'rotear': {
      const host = ['ocupado'];
      if (features.sensores) host.push('vizinhos', 'dist');
      else Object.assign(locked, { vizinhos: 'sensores', dist: 'sensores' });
      return { name: 'rotear', params: ['j', 'p', 'destino'], host, locked, globals };
    }
    case 'prever':
      return { name: 'prever', params: ['hist'], locked, globals };
    case 'vigiar':
      return { name: 'vigiar', params: ['evento', 'hist'], locked, globals };
    case 'aprender':
      return { name: 'ao_entregar', params: ['p', 'ok'], locked, globals, returns: false };
  }
}

export function compileFor(box: BoxId, source: string, features: Features = NO_FEATURES): CompileResult {
  return compileBox(source, signatureFor(box, features), features);
}

/** O que toda execução de caixa recebe do jogo. */
export interface BoxContext {
  features: Features;
  /** Memória compartilhada; `null` enquanto Memória não foi liberada. */
  mem: Value[] | null;
}

export const DEFAULT_CONTEXT: BoxContext = { features: NO_FEATURES, mem: null };

function envFor(ctx: BoxContext, host: Record<string, HostFunction> = {}, requireReturn = true): RunEnv {
  return { features: ctx.features, globals: ctx.mem ? { mem: ctx.mem } : {}, host, requireReturn };
}

// ---- Registros que as caixas enxergam ----

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

export function relayRecord(grid: Grid, row: number, col: number): RecordValue {
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

export function eventRecord(e: EventView): Value {
  return record('Evento', {
    tipo: symbol(e.tipo),
    pulso: pulseRecord(e.pulso),
    ok: e.ok,
    saida: e.saida === null ? null : color(e.saida),
    terra: e.terra,
    destino: e.destino === null ? null : color(e.destino),
  });
}

// ---- Classificador ----

export type Decision = Destination | { kind: 'manual' };

export type BoxFailure = { ok: false; message: string; line: number; ops: number; limitHit: boolean };

export type ClassifyResult = { ok: true; decision: Decision; ops: number } | BoxFailure;

export function classify(
  box: BoxDef,
  pulse: PulseView,
  hist: PulseView[],
  opLimit: number,
  ctx: BoxContext = DEFAULT_CONTEXT,
): ClassifyResult {
  const result = runBox(box, [pulseRecord(pulse), hist.map(pulseRecord)], opLimit, envFor(ctx));
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
  ctx: BoxContext = DEFAULT_CONTEXT,
): RouteResult {
  const host: Record<string, HostFunction> = {
    ocupado: (args, at) => {
      if (args.length !== 2) throw new DslError('ocupado(j, DIR) recebe o relé e uma direção', at.line, at.col);
      return occupied(expectDir(args[1], 'ocupado', at));
    },
  };
  if (ctx.features.sensores) {
    host.vizinhos = (args, at, spend) => {
      spend(COST_NEIGHBORS);
      if (args.length !== 1) throw new DslError('vizinhos(j) recebe um relé', at.line, at.col);
      const { row: r, col: c } = relayPosition(args[0], 'vizinhos', at);
      return grid.neighborRelays(r, c).map((n) => {
        const rec = relayRecord(grid, n.row, n.col);
        return record('Rele', { ...rec.fields, via: dir(n.via) });
      });
    };
    host.dist = (args, at, spend) => {
      spend(COST_DISTANCE);
      if (args.length !== 2) throw new DslError('dist(j, destino) recebe um relé e um destino', at.line, at.col);
      const { row: r, col: c } = relayPosition(args[0], 'dist', at);
      return grid.distanceToExit(r, c, exitRowOf(grid, args[1], at));
    };
  }
  const p = pulseRecord(pulse) as RecordValue;
  const moving = record('Pulso', { ...p.fields, direcao: dir(heading) });
  const result = runBox(box, [relayRecord(grid, row, col), moving, destRecord(grid, dest)], opLimit, envFor(ctx, host));
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

function expectDir(v: Value, fn: string, at: { line: number; col: number }): Dir {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v.t !== 'dir' || v.d === 'ESPERAR' || v.d === 'MANTER') {
    throw new DslError(`${fn}() espera NORTE, LESTE ou SUL, recebeu ${formatValue(v)}`, at.line, at.col);
  }
  return v.d;
}

function relayPosition(v: Value, fn: string, at: { line: number; col: number }): { row: number; col: number } {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && v.t === 'registro' && v.tipo === 'Rele') {
    return { row: v.fields.linha as number, col: v.fields.coluna as number };
  }
  throw new DslError(`${fn}() espera um relé (j ou um item de vizinhos(j)), recebeu ${typeName(v)}`, at.line, at.col);
}

/** `dist` aceita o `destino` do Roteador ou uma cor. */
function exitRowOf(grid: Grid, v: Value, at: { line: number; col: number }): number {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (v.t === 'registro' && v.tipo === 'Destino') return v.fields.linha as number;
    if (v.t === 'cor' && v.c !== 'GRAY') return grid.rowOf({ kind: 'saida', cor: v.c });
  }
  throw new DslError(`dist() espera um destino ou uma cor, recebeu ${typeName(v)}`, at.line, at.col);
}

// ---- Previsor ----

export type PredictResult = { ok: true; cor: PulseColor | null; ops: number } | BoxFailure;

/** Prevê a cor do próximo pulso só pelo histórico: acertar dobra os pontos dele. */
export function predict(box: BoxDef, hist: PulseView[], opLimit: number, ctx: BoxContext = DEFAULT_CONTEXT): PredictResult {
  const result = runBox(box, [hist.map(pulseRecord)], opLimit, envFor(ctx));
  if (!result.ok) return failure(result.error, result.ops, result.limitHit);
  const v = result.value;
  if (v === null) return { ok: true, cor: null, ops: result.ops };
  if (typeof v === 'object' && !Array.isArray(v) && v.t === 'cor') return { ok: true, cor: v.c, ops: result.ops };
  return {
    ok: false,
    message: `retorno inválido: ${formatValue(v)} (esperado uma cor ou None)`,
    line: box.line,
    ops: result.ops,
    limitHit: false,
  };
}

// ---- Vigia ----

export type WatchResult = { ok: true; alert: boolean; ops: number } | BoxFailure;

/** Recebe cada evento da grade e decide se dispara um alerta (que pausa o jogo). */
export function watch(box: BoxDef, event: EventView, hist: EventView[], opLimit: number, ctx: BoxContext = DEFAULT_CONTEXT): WatchResult {
  const result = runBox(box, [eventRecord(event), hist.map(eventRecord)], opLimit, envFor(ctx));
  if (!result.ok) return failure(result.error, result.ops, result.limitHit);
  const v = result.value;
  if (v === null) return { ok: true, alert: false, ops: result.ops };
  if (typeof v === 'object' && !Array.isArray(v) && v.t === 'simbolo' && v.s === 'ALERTA') {
    return { ok: true, alert: true, ops: result.ops };
  }
  return {
    ok: false,
    message: `retorno inválido: ${formatValue(v)} (esperado ALERTA ou None)`,
    line: box.line,
    ops: result.ops,
    limitHit: false,
  };
}

// ---- Aprendiz ----

export type LearnResult = { ok: true; ops: number } | BoxFailure;

/** Chamado a cada pulso que sai, já com a cor revelada; só pode gravar no `mem`. */
export function learn(box: BoxDef, pulse: PulseView, ok: boolean, opLimit: number, ctx: BoxContext = DEFAULT_CONTEXT): LearnResult {
  const result = runBox(box, [pulseRecord(pulse), ok], opLimit, envFor(ctx, {}, false));
  if (!result.ok) return failure(result.error, result.ops, result.limitHit);
  return { ok: true, ops: result.ops };
}

function failure(error: DslError, ops: number, limitHit: boolean): BoxFailure {
  return { ok: false, message: error.message, line: error.line, ops, limitHit };
}
