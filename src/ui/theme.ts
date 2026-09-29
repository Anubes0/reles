import type { PulseColor } from '../core/colors';

/** Paleta do tabuleiro (o Canvas não lê variáveis CSS, então as cores ficam aqui). */
export const PULSE_FILL: Record<PulseColor, string> = {
  RED: '#ff6b6b',
  GREEN: '#4ade80',
  BLUE: '#60a5fa',
  YELLOW: '#facc15',
  GRAY: '#8b93a3',
};

export const BOARD = {
  background: '#0d1117',
  cell: '#131a24',
  decisionBand: 'rgba(96, 165, 250, 0.06)',
  wire: '#2a3547',
  text: '#d8dee9',
  textMuted: '#7d889a',
  veiledFill: '#1a2130',
  veiledStroke: '#a3adbf',
  selection: '#ffffff',
  warning: '#fb923c',
  inactive: '#3a4354',
} as const;

export const FONT_MONO = "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace";
