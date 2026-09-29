import { COLORS, type Color } from '../core/colors';

export type ModeId = 'facil';

/** Regras fixas de um modo (documento conceitual: "Diretor e modos"). O MVP só tem o fácil. */
export interface ModeConfig {
  id: ModeId;
  label: string;
  energyPerTurn: number;
  actionsPerTurn: number;
  logSize: number;
  waveLength: number;
  maxLevel: number;
  /** Quantas ondas um regime dura, sorteado neste intervalo. */
  regimeWaves: [number, number];
  /** No fácil, a mudança de regime é anunciada. */
  announceRegime: boolean;
  multiplier: (level: number) => number;
}

export const FACIL: ModeConfig = {
  id: 'facil',
  label: 'Fácil',
  energyPerTurn: 60,
  actionsPerTurn: 2,
  logSize: 10,
  waveLength: 25,
  maxLevel: 5,
  regimeWaves: [1, 3],
  announceRegime: true,
  multiplier: (level) => 1 + level * 0.2,
};

/** Parâmetros que o diretor ajusta, derivados do nível atual. */
export interface LevelParams {
  spawnGap: [number, number];
  veiledChance: number;
  noiseChance: number;
  palette: readonly Color[];
  maxCycleLength: number;
}

export function levelParams(level: number): LevelParams {
  return {
    spawnGap: [level >= 2 ? 1 : 2, Math.max(1, 3 - Math.floor(level / 2))],
    veiledChance: Math.min(0.6, 0.25 + level * 0.07),
    noiseChance: 0.08 + level * 0.02,
    palette: level < 3 ? COLORS.slice(0, 3) : COLORS,
    maxCycleLength: 2 + Math.floor(level / 2),
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
