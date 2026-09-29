import type { Color } from '../core/colors';
import type { Destination, Pulse } from './types';

/**
 * Grade 5 × 5 do MVP. Os pulsos entram pela esquerda (portas 1–3, linhas 1–3),
 * seguem até a coluna de decisão, sobem ou descem até a linha do destino e saem pela direita.
 */
export const ROWS = 5;
export const COLS = 5;
export const DECISION_COL = 2;
export const PORTS = [1, 2, 3] as const;

/** Linha de cada saída na borda direita; a do meio é o terra. */
export const OUTPUT_ROW: Record<Color | 'TERRA', number> = {
  RED: 0,
  GREEN: 1,
  TERRA: 2,
  BLUE: 3,
  YELLOW: 4,
};

export function portRow(porta: number): number {
  return porta;
}

export function destRow(dest: Destination): number {
  return dest.kind === 'terra' ? OUTPUT_ROW.TERRA : OUTPUT_ROW[dest.cor];
}

/** Um pulso só pode ter o destino trocado até sair da coluna de decisão. */
export function isAssignable(pulse: Pulse): boolean {
  return pulse.col <= DECISION_COL;
}

/**
 * Avança o pulso uma casa. Quem chega à coluna de decisão sem destino segue para o terra.
 * Retorna `true` quando o pulso sai da grade (foi entregue).
 */
export function advance(pulse: Pulse): boolean {
  if (pulse.col < DECISION_COL) {
    pulse.col++;
    return false;
  }
  if (pulse.col === DECISION_COL) {
    if (!pulse.dest) {
      pulse.dest = { kind: 'terra' };
      pulse.destBy = 'auto';
    }
    const target = destRow(pulse.dest);
    if (pulse.row !== target) {
      pulse.row += Math.sign(target - pulse.row);
      return false;
    }
  }
  pulse.col++;
  return pulse.col >= COLS;
}
