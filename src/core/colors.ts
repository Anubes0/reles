/** Cores que uma saída pode aceitar. */
export const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW'] as const;
export type Color = (typeof COLORS)[number];

/** Cor de um pulso: uma das cores de saída ou cinza (ruído). */
export type PulseColor = Color | 'GRAY';

export const COLOR_LABEL: Record<PulseColor, string> = {
  RED: 'vermelho',
  GREEN: 'verde',
  BLUE: 'azul',
  YELLOW: 'amarelo',
  GRAY: 'cinza',
};
