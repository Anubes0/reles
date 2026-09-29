import type { Color, PulseColor } from '../core/colors';

export type Destination = { kind: 'saida'; cor: Color } | { kind: 'terra' };

/** O que o jogador (e o script) pode ver de um pulso. */
export interface PulseView {
  seq: number;
  porta: number;
  /** `null` quando o pulso é velado. */
  cor: PulseColor | null;
  turno: number;
}

export interface Pulse {
  id: number;
  seq: number;
  porta: number;
  cor: PulseColor;
  velado: boolean;
  spawnTurn: number;
  row: number;
  col: number;
  dest: Destination | null;
  destBy: 'script' | 'manual' | 'auto' | null;
}

/** Pulso ainda na fila de entrada. */
export interface QueuedPulse {
  seq: number;
  porta: number;
  cor: PulseColor;
  velado: boolean;
  turn: number;
}

export type DeliveryOutcome = 'acerto' | 'erro' | 'perdido';

/** Pulso já entregue, com a cor revelada: vira caso de teste na bancada. */
export interface DeliveredPulse {
  seq: number;
  porta: number;
  cor: PulseColor;
  velado: boolean;
  turno: number;
  dest: Destination;
  outcome: DeliveryOutcome;
}

export type LogKind = 'acerto' | 'erro' | 'perdido' | 'script' | 'regime' | 'diretor' | 'info';

export interface LogEntry {
  turn: number;
  kind: LogKind;
  text: string;
}
