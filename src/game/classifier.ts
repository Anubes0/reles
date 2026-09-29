import type { BoxDef } from '../dsl/ast';
import type { DslError } from '../dsl/errors';
import { compileBox, runBox, type BoxSignature, type CompileResult } from '../dsl/interpreter';
import { color, formatValue, type Value } from '../dsl/values';
import type { Destination, PulseView } from './types';

export const CLASSIFIER_SIGNATURE: BoxSignature = { name: 'classificar', params: ['p', 'hist'] };

export type Decision = Destination | { kind: 'manual' };

export type ClassifyResult =
  | { ok: true; decision: Decision; ops: number }
  | { ok: false; message: string; line: number; ops: number; limitHit: boolean };

export function compileClassifier(source: string): CompileResult {
  return compileBox(source, CLASSIFIER_SIGNATURE);
}

export function pulseRecord(p: PulseView): Value {
  return {
    t: 'registro',
    tipo: 'Pulso',
    fields: {
      cor: p.cor === null ? null : color(p.cor),
      porta: p.porta,
      seq: p.seq,
      turno: p.turno,
    },
  };
}

/** `hist` faz parte da assinatura, mas o recurso Histórico ainda está bloqueado no MVP. */
const LOCKED_HIST: Value = { t: 'bloqueado', feature: 'historico' };

export function classify(box: BoxDef, pulse: PulseView, opLimit: number): ClassifyResult {
  const result = runBox(box, [pulseRecord(pulse), LOCKED_HIST], opLimit);
  if (!result.ok) return failure(result.error, result.ops, result.limitHit);
  const decision = toDecision(result.value);
  if (!decision) {
    const v = result.value;
    const hint =
      v !== null && typeof v === 'object' && !Array.isArray(v) && v.t === 'cor'
        ? `retorne saida(${v.c}), não a cor sozinha`
        : `retorno inválido: ${formatValue(v)} (esperado saida(COR), TERRA ou MANUAL)`;
    return {
      ok: false,
      message: hint,
      line: box.line,
      ops: result.ops,
      limitHit: false,
    };
  }
  return { ok: true, decision, ops: result.ops };
}

function toDecision(v: Value): Decision | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.t === 'terra') return { kind: 'terra' };
  if (v.t === 'manual') return { kind: 'manual' };
  if (v.t === 'saida' && v.c !== 'GRAY') return { kind: 'saida', cor: v.c };
  return null;
}

function failure(error: DslError, ops: number, limitHit: boolean): ClassifyResult {
  return { ok: false, message: error.message, line: error.line, ops, limitHit };
}
