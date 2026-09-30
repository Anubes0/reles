import type { Color, Dir, PulseColor, Shape } from '../core/colors';

export type Destination = { kind: 'saida'; cor: Color } | { kind: 'terra' };

/** O que o jogador (e o script) pode ver de um pulso. */
export interface PulseView {
  seq: number;
  porta: number;
  /** `null` quando o pulso é velado. */
  cor: PulseColor | null;
  turno: number;
  carga: number;
  forma: Shape;
}

export interface Pulse {
  id: number;
  seq: number;
  porta: number;
  cor: PulseColor;
  velado: boolean;
  carga: number;
  forma: Shape;
  spawnTurn: number;
  row: number;
  col: number;
  dest: Destination | null;
  destBy: 'script' | 'manual' | 'auto' | null;
  /** Segurado à mão: não anda no próximo passo. */
  held: boolean;
  /** Ficou parado no último passo (esperou, foi segurado ou pegou fila). */
  stalled: boolean;
  /** Direção do último movimento: o Roteador vê como `p.direcao`. */
  heading: Dir;
  /** O Previsor acertou a cor deste pulso antes de ele entrar: vale o dobro na entrega certa. */
  sintonizado: boolean;
}

/** Pulso ainda na fila de entrada. */
export interface QueuedPulse {
  seq: number;
  porta: number;
  cor: PulseColor;
  velado: boolean;
  carga: number;
  forma: Shape;
  turn: number;
  /** Ruído aleatório, fora da regra: nunca muda de cor numa troca de regime. */
  anomalia: boolean;
  /** Cor que o Previsor apostou para este pulso (`undefined`: ainda não previu). */
  previsto?: PulseColor | null;
}

export type DeliveryOutcome = 'acerto' | 'erro' | 'perdido';

/** Pulso que saiu do jogo, com a cor revelada: vira caso de teste na bancada. */
export interface DeliveredPulse {
  seq: number;
  porta: number;
  cor: PulseColor;
  velado: boolean;
  carga: number;
  forma: Shape;
  turno: number;
  /** Onde o pulso saiu; `null` quando se perdeu antes (colisão ou tempo esgotado). */
  dest: Destination | null;
  outcome: DeliveryOutcome;
  motivo?: 'colisao' | 'queimou';
}

/** O que o Vigia recebe a cada pulso que sai, colide ou queima. */
export interface EventView {
  tipo: 'ENTREGA' | 'COLISAO' | 'QUEIMOU';
  /** O pulso com a cor real já revelada. */
  pulso: PulseView;
  ok: boolean;
  /** Cor da saída por onde saiu (`null`: terra ou não saiu). */
  saida: Color | null;
  terra: boolean;
  /** Cor do destino que o pulso tinha (`null`: sem destino ou terra). */
  destino: Color | null;
}

export type LogKind = 'acerto' | 'erro' | 'perdido' | 'script' | 'regime' | 'diretor' | 'grade' | 'alerta' | 'info';

export interface LogEntry {
  turn: number;
  kind: LogKind;
  text: string;
}

/** O que aconteceu no último turno: a interface usa para animar entregas e avisos. */
export type TurnEvent =
  | { kind: 'entrega'; seq: number; cor: PulseColor; dest: Destination; outcome: DeliveryOutcome; points: number; integrity: number }
  | { kind: 'colisao'; row: number; col: number; count: number }
  | { kind: 'queimado'; row: number; col: number }
  | { kind: 'regime' }
  | { kind: 'grade'; broken: number }
  | { kind: 'deriva'; swaps: number }
  | { kind: 'nivel'; from: number; to: number }
  | { kind: 'alerta'; seq: number; text: string }
  | { kind: 'previsao'; seq: number; acertou: boolean }
  | { kind: 'eficiencia'; points: number };
