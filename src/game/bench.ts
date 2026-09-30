import { COLOR_LABEL, type Color, type Dir } from '../core/colors';
import { MAX_OPS_PER_CALL } from '../dsl/interpreter';
import { COLS, type Grid } from './board';
import { classify, compileFor, DEFAULT_CONTEXT, HIST_SIZE, route, type BoxContext, type Decision } from './boxes';
import type { Value } from '../dsl/values';
import type { DeliveredPulse, Destination, PulseView } from './types';

/** Cópia do contexto com um `mem` próprio (listas dentro dele inclusive): o teste não altera a partida. */
function isolated(ctx: BoxContext): BoxContext {
  return { ...ctx, mem: ctx.mem && ctx.mem.map(copyLists) };
}

function copyLists(value: Value): Value {
  return Array.isArray(value) ? value.map(copyLists) : value;
}

// ---- Classificador: roda contra pulsos que já saíram, com a cor revelada ----

export interface BenchCase {
  pulse: DeliveredPulse;
  expected: Decision;
  got: Decision | null;
  error: string | null;
  pass: boolean;
}

export type BenchResult =
  | { ok: true; cases: BenchCase[]; passed: number; manual: number }
  | { ok: false; message: string; line: number };

/** Destino correto de um pulso já revelado. */
export function expectedDecision(pulse: DeliveredPulse): Decision {
  return pulse.cor === 'GRAY' ? { kind: 'terra' } : { kind: 'saida', cor: pulse.cor };
}

/**
 * Roda o Classificador contra pulsos que já saíram. Os velados continuam velados no teste
 * e `hist` é o mesmo que o pulso teve ao entrar. Não gasta energia (modo fácil).
 */
export function runBench(source: string, cases: DeliveredPulse[], entered: PulseView[], ctx: BoxContext = DEFAULT_CONTEXT): BenchResult {
  const compiled = compileFor('classificar', source, ctx.features);
  if (!compiled.ok) return { ok: false, message: compiled.error.message, line: compiled.error.line };

  const results = cases.map((pulse): BenchCase => {
    const expected = expectedDecision(pulse);
    const view: PulseView = {
      seq: pulse.seq,
      porta: pulse.porta,
      cor: pulse.velado ? null : pulse.cor,
      turno: pulse.turno,
      carga: pulse.carga,
      forma: pulse.forma,
    };
    const hist = entered.filter((e) => e.seq < pulse.seq).slice(-HIST_SIZE);
    const result = classify(compiled.box, view, hist, MAX_OPS_PER_CALL, isolated(ctx));
    if (!result.ok) {
      return { pulse, expected, got: null, error: `linha ${result.line}: ${result.message}`, pass: false };
    }
    return { pulse, expected, got: result.decision, error: null, pass: sameDecision(expected, result.decision) };
  });

  return {
    ok: true,
    cases: results,
    passed: results.filter((c) => c.pass).length,
    manual: results.filter((c) => c.got?.kind === 'manual').length,
  };
}

export function sameDecision(a: Decision, b: Decision): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'saida' || (b.kind === 'saida' && a.cor === b.cor);
}

export function formatDecision(d: Decision | null): string {
  if (!d) return '—';
  if (d.kind === 'saida') return `saida(${d.cor})`;
  return d.kind === 'terra' ? 'TERRA' : 'MANUAL';
}

// ---- Roteador: simula uma rota de cada porta ativa para cada saída ativa ----

export interface RouteCheck {
  porta: number;
  target: Destination;
  ok: boolean;
  reason: string | null;
  steps: number;
}

export type RouteBenchResult =
  | { ok: true; checks: RouteCheck[]; passed: number }
  | { ok: false; message: string; line: number };

const MAX_WAITS_IN_A_ROW = 3;

/**
 * Verifica o Roteador na grade atual, um pulso por vez (sem outros pulsos no caminho,
 * então `ocupado` responde sempre False). Os relés começam como estão agora.
 */
export function verifyRouter(
  source: string,
  grid: Grid,
  ports: number[],
  palette: readonly Color[],
  lifetime: number,
  ctx: BoxContext = DEFAULT_CONTEXT,
): RouteBenchResult {
  const compiled = compileFor('rotear', source, ctx.features);
  if (!compiled.ok) return { ok: false, message: compiled.error.message, line: compiled.error.line };

  const targets: Destination[] = [...palette.map((cor): Destination => ({ kind: 'saida', cor })), { kind: 'terra' }];
  const checks: RouteCheck[] = [];
  for (const porta of ports) {
    for (const target of targets) {
      checks.push(simulate(compiled.box, grid.clone(), porta, target, lifetime, isolated(ctx)));
    }
  }
  return { ok: true, checks, passed: checks.filter((c) => c.ok).length };
}

function simulate(
  box: Parameters<typeof route>[0],
  grid: Grid,
  porta: number,
  target: Destination,
  lifetime: number,
  ctx: BoxContext,
): RouteCheck {
  const view: PulseView = {
    seq: 0,
    porta,
    cor: target.kind === 'saida' ? target.cor : 'GRAY',
    turno: 1,
    carga: 1,
    forma: 'CIRCULO',
  };
  let row = grid.portRow(porta);
  let col = 0;
  let waits = 0;
  let heading: Dir = 'LESTE';
  const fail = (reason: string, steps: number): RouteCheck => ({ porta, target, ok: false, reason, steps });

  for (let steps = 1; steps <= lifetime; steps++) {
    let stay = false;
    if (grid.isRelay(row, col)) {
      const result = route(box, grid, row, col, view, heading, target, () => false, MAX_OPS_PER_CALL, ctx);
      if (!result.ok) return fail(`erro na linha ${result.line}: ${result.message}`, steps);
      if (result.action === 'ESPERAR') {
        stay = true;
        waits++;
        if (waits > MAX_WAITS_IN_A_ROW) return fail(`esperou ${waits} vezes seguidas no relé (${row}, ${col})`, steps);
      } else {
        waits = 0;
        if (result.action !== 'MANTER' && !grid.setDir(row, col, result.action)) {
          return fail(`${result.action} está bloqueado no relé (${row}, ${col})`, steps);
        }
      }
    }
    if (stay) continue;
    heading = grid.isRelay(row, col) ? grid.dir(row, col) : 'LESTE';
    const next = grid.step(row, col, heading);
    if (next.col >= COLS) {
      const exit = grid.exitAt(row);
      if (!exit) return fail(`saiu pela linha ${row}, que não tem saída`, steps);
      const arrived = exit.kind === target.kind && (exit.kind === 'terra' || (target.kind === 'saida' && exit.cor === target.cor));
      if (arrived) return { porta, target, ok: true, reason: null, steps };
      return fail(`chegou em ${exit.kind === 'terra' ? 'TERRA' : `${exit.cor} (${COLOR_LABEL[exit.cor]})`}`, steps);
    }
    row = next.row;
    col = next.col;
  }
  return fail(`não chegou em ${lifetime} passos (laço entre relés?)`, lifetime);
}
