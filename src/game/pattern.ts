import type { Color } from '../core/colors';
import type { Rng } from '../core/rng';
import { PORTS } from './board';

/**
 * Regra oculta de um regime. O MVP usa uma única peça por regime
 * (documento conceitual: "Gerador de padrões").
 */
export type Regime =
  | { kind: 'ciclo'; cycle: Color[] }
  | { kind: 'porta'; map: Record<number, Color> };

export function colorFor(regime: Regime, seq: number, porta: number): Color {
  if (regime.kind === 'ciclo') return regime.cycle[seq % regime.cycle.length];
  return regime.map[porta];
}

export function describeRegime(regime: Regime): string {
  if (regime.kind === 'ciclo') {
    return `Ciclo de ${regime.cycle.length}: ${regime.cycle.join(', ')} (cor = ciclo[seq % ${regime.cycle.length}])`;
  }
  const pairs = PORTS.map((porta) => `${porta}→${regime.map[porta]}`).join(', ');
  return `Por porta: ${pairs}`;
}

export interface RegimeOptions {
  palette: readonly Color[];
  maxCycleLength: number;
  previous: Regime | null;
}

/** Sorteia uma regra nova, garantindo que ela difira da anterior. */
export function generateRegime(rng: Rng, options: RegimeOptions): Regime {
  const previous = options.previous ? describeRegime(options.previous) : null;
  for (;;) {
    const regime = rng.chance(0.5) ? cycleRegime(rng, options) : portRegime(rng, options.palette);
    if (describeRegime(regime) !== previous) return regime;
  }
}

function cycleRegime(rng: Rng, options: RegimeOptions): Regime {
  const length = rng.int(2, Math.max(2, options.maxCycleLength));
  return { kind: 'ciclo', cycle: distinctColors(rng, options.palette, length) };
}

function portRegime(rng: Rng, palette: readonly Color[]): Regime {
  const colors = distinctColors(rng, palette, PORTS.length);
  return { kind: 'porta', map: Object.fromEntries(PORTS.map((porta, i) => [porta, colors[i]])) };
}

/** Sequência de cores com pelo menos duas cores diferentes, para o padrão ter o que descobrir. */
function distinctColors(rng: Rng, palette: readonly Color[], length: number): Color[] {
  for (;;) {
    const colors = Array.from({ length }, () => rng.pick(palette));
    if (new Set(colors).size >= 2) return colors;
  }
}
