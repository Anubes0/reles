import { MAX_OPS_PER_CALL } from '../dsl/interpreter';
import { classify, compileClassifier, type Decision } from './classifier';
import type { DeliveredPulse } from './types';

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
 * Roda o script contra pulsos já entregues. Pulsos que eram velados continuam
 * velados no teste, como estavam quando entraram. Não gasta energia (modo fácil).
 */
export function runBench(source: string, cases: DeliveredPulse[]): BenchResult {
  const compiled = compileClassifier(source);
  if (!compiled.ok) return { ok: false, message: compiled.error.message, line: compiled.error.line };

  const results = cases.map((pulse): BenchCase => {
    const expected = expectedDecision(pulse);
    const view = { seq: pulse.seq, porta: pulse.porta, cor: pulse.velado ? null : pulse.cor, turno: pulse.turno };
    const result = classify(compiled.box, view, MAX_OPS_PER_CALL);
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
