import { PALETTE_ORDER, type Color } from '../core/colors';
import { MAX_PORTS } from './board';
import type { Base, Key } from './pattern';

export type ModeId = 'facil';

/** Regras fixas de um modo (documento conceitual: "Diretor e modos"). Por ora só o fácil. */
export interface ModeConfig {
  id: ModeId;
  label: string;
  energyPerTurn: number;
  actionsPerTurn: number;
  logSize: number;
  waveLength: number;
  maxLevel: number;
  /** Turnos de vida de um pulso na grade antes de queimar. */
  pulseLifetime: number;
  /** Quantas ondas um regime dura, sorteado neste intervalo. */
  regimeWaves: [number, number];
  /** No fácil, a mudança de regime é anunciada. */
  announceRegime: boolean;
  multiplier: (level: number) => number;
}

export const FACIL: ModeConfig = {
  id: 'facil',
  label: 'Fácil',
  energyPerTurn: 1000,
  actionsPerTurn: 2,
  logSize: 12,
  waveLength: 20,
  maxLevel: 10,
  pulseLifetime: 60,
  regimeWaves: [1, 3],
  announceRegime: true,
  multiplier: (level) => 1 + level * 0.25,
};

/** Parâmetros que o diretor ajusta, derivados do nível atual. */
export interface LevelParams {
  ports: number;
  palette: readonly Color[];
  /** Pulsos que entram por turno, em média. */
  spawnRate: number;
  veiledChance: number;
  /** Ruído aleatório, fora da regra (sempre visível). */
  anomalyChance: number;
  maxCycleLength: number;
  bases: Base['kind'][];
  keys: Key[];
  maxMods: number;
  brokenWires: number;
  outputSwaps: number;
}

export function levelParams(level: number): LevelParams {
  const grow = Math.min(MAX_PORTS, 3 + Math.floor(level * 0.7));
  const bases: Base['kind'][] = ['ciclo', 'mapa'];
  if (level >= 3) bases.push('tabela');
  if (level >= 4) bases.push('anterior');
  return {
    ports: grow,
    palette: PALETTE_ORDER.slice(0, grow),
    spawnRate: 0.4 + level * 0.1,
    veiledChance: Math.min(0.65, 0.25 + level * 0.04),
    anomalyChance: 0.05 + level * 0.01,
    maxCycleLength: Math.min(5, 2 + Math.floor(level / 2)),
    bases,
    keys: level >= 1 ? ['porta', 'carga', 'forma'] : ['porta'],
    maxMods: level < 3 ? 0 : level < 6 ? 1 : 2,
    brokenWires: level < 2 ? 0 : Math.min(20, 2 * (level - 1)),
    outputSwaps: level < 5 ? 0 : level < 8 ? 1 : 2,
  };
}

export interface WaveStats {
  acertos: number;
  erros: number;
  perdidos: number;
  integrityLost: number;
}

/**
 * Diretor adaptativo: mira ~80% de precisão. Acima de 85% sobe um nível;
 * abaixo de 70% ou com perda de 3+ de integridade, desce um.
 */
export function nextLevel(level: number, wave: WaveStats, maxLevel: number): number {
  const total = wave.acertos + wave.erros + wave.perdidos;
  if (total === 0) return level;
  const precision = wave.acertos / total;
  if (precision < 0.7 || wave.integrityLost >= 3) return Math.max(0, level - 1);
  if (precision > 0.85) return Math.min(maxLevel, level + 1);
  return level;
}
