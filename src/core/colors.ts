/** As 10 cores que uma saída pode aceitar. */
export const COLORS = ['RED', 'ORANGE', 'YELLOW', 'LIME', 'GREEN', 'CYAN', 'BLUE', 'VIOLET', 'PINK', 'WHITE'] as const;
export type Color = (typeof COLORS)[number];

/** Cor de um pulso: uma das cores de saída ou cinza (ruído). */
export type PulseColor = Color | 'GRAY';

/** Ordem em que o diretor libera as cores: as mais fáceis de distinguir entram primeiro. */
export const PALETTE_ORDER: readonly Color[] = ['RED', 'BLUE', 'YELLOW', 'GREEN', 'VIOLET', 'ORANGE', 'CYAN', 'PINK', 'WHITE', 'LIME'];

export const COLOR_LABEL: Record<PulseColor, string> = {
  RED: 'vermelho',
  ORANGE: 'laranja',
  YELLOW: 'amarelo',
  LIME: 'lima',
  GREEN: 'verde',
  CYAN: 'ciano',
  BLUE: 'azul',
  VIOLET: 'violeta',
  PINK: 'rosa',
  WHITE: 'branco',
  GRAY: 'cinza',
};

export const SHAPES = ['CIRCULO', 'QUADRADO', 'TRIANGULO'] as const;
export type Shape = (typeof SHAPES)[number];

export const SHAPE_LABEL: Record<Shape, string> = {
  CIRCULO: 'círculo',
  QUADRADO: 'quadrado',
  TRIANGULO: 'triângulo',
};

/** Direções de um relé. */
export const DIRS = ['NORTE', 'LESTE', 'SUL'] as const;
export type Dir = (typeof DIRS)[number];

/** O que o Roteador pode devolver: uma direção ou uma ação sobre o pulso. */
export type RouteAction = Dir | 'ESPERAR' | 'MANTER';
