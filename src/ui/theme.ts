import type { PulseColor } from '../core/colors';

/** Paleta do tabuleiro (o Canvas não lê variáveis CSS, então as cores ficam aqui). */
export const PULSE_FILL: Record<PulseColor, string> = {
  RED: '#ff5a5a',
  ORANGE: '#ff9f43',
  YELLOW: '#ffe14d',
  LIME: '#c3f53c',
  GREEN: '#2fd67b',
  CYAN: '#3ee0f0',
  BLUE: '#4d8dff',
  VIOLET: '#a77bff',
  PINK: '#ff7ac8',
  WHITE: '#f2f5fa',
  GRAY: '#6f7889',
};

/** Cores da interface: evitam os tons dos pulsos para não confundir sinal com aviso. */
export const BOARD = {
  background: '#070b10',
  panel: '#0e141c',
  relayBand: 'rgba(148, 163, 184, 0.035)',
  relay: '#111a25',
  relayHover: '#1c2a3b',
  relayEdge: '#2c3a4f',
  arrowQuiet: '#6b7c95',
  arrowTurn: '#e2e8f0',
  trace: '#243246',
  traceDead: '#1a2230',
  brokenTrace: '#5b2a33',
  pin: '#4a5d78',
  text: '#e2e8f0',
  textMuted: '#7a8699',
  veiledFill: '#121a26',
  veiledStroke: '#b8c2d3',
  selection: '#ffffff',
  inactive: '#2a3444',
  good: '#4ade80',
  bad: '#ff4d6d',
  warning: '#e2e8f0',
  regime: '#e2e8f0',
  accent: '#93c5fd',
} as const;

export const FONT_MONO = "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace";
