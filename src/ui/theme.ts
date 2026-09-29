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
  background: '#070b10',
  panel: '#0e141c',
  decisionBand: 'rgba(96, 165, 250, 0.05)',
  decisionEdge: 'rgba(96, 165, 250, 0.25)',
  gridDot: '#1c2634',
  trace: '#223044',
  pad: '#0b1118',
  pin: '#3a4a60',
  text: '#dbe3ee',
  textMuted: '#7a8699',
  veiledFill: '#121a26',
  veiledStroke: '#a3adbf',
  selection: '#ffffff',
  warning: '#fb923c',
  inactive: '#2e3a4b',
  good: '#4ade80',
  bad: '#ff6b6b',
  regime: '#c084fc',
  accent: '#60a5fa',
} as const;

export const FONT_MONO = "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace";
