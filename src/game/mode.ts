import { PALETTE_ORDER, type Color } from '../core/colors';
import { MAX_PORTS } from './board';
import type { Base, Key } from './pattern';

export type ModeId = 'facil' | 'medio' | 'dificil';
export const MODE_IDS: ModeId[] = ['facil', 'medio', 'dificil'];

export interface TimeBankConfig {
  startMs: number;
  maxMs: number;
  /** Quanto volta ao banco a cada turno encerrado. */
  rechargeMs: number;
  /** Com o banco zerado, os turnos passam sozinhos até ele voltar a este valor. */
  resumeMs: number;
}

/** Regras fixas de um modo (documento conceitual: "Diretor e modos"). */
export interface ModeConfig {
  id: ModeId;
  label: string;
  summary: string;
  energyPerTurn: number;
  actionsPerTurn: number;
  logSize: number;
  waveLength: number;
  maxLevel: number;
  /** Turnos de vida de um pulso na grade antes de queimar. */
  pulseLifetime: number;
  /** Quantas ondas um regime dura, sorteado neste intervalo. */
  regimeWaves: [number, number];
  /** Como a mudança de regime é avisada. */
  regimeNotice: 'explicito' | 'sutil' | 'nenhum';
  /** Bancada de testes: livre, consome o banco de tempo, ou não existe. */
  bench: 'livre' | 'banco' | 'nenhuma';
  /** Milissegundos que a bancada consome do banco (quando `bench` é 'banco'). */
  benchCostMs: number;
  /** No difícil, aplicar um script encerra o turno. */
  applyEndsTurn: boolean;
  timeBank: TimeBankConfig | null;
  /** Turnos até uma saída apagar depois da última entrega nela (`null`: nunca apaga). */
  outputFade: number | null;
  /** Fração de velados no nível 0 e no nível máximo. */
  veiled: [number, number];
  /** Quantas funções vão na bagagem para a próxima partida. */
  baggageLimit: number;
  multiplier: (level: number) => number;
  /** Modificadores da regra oculta: mínimo e máximo, conforme o nível. */
  mods: (level: number) => [number, number];
  /** Carga e forma entram na regra desde o nível 0 (no fácil, só a partir do 1). */
  allKeysFromStart: boolean;
}

export const MODES: Record<ModeId, ModeConfig> = {
  facil: {
    id: 'facil',
    label: 'Fácil',
    summary: 'Sem banco de tempo, bancada livre, mudança de regime anunciada.',
    energyPerTurn: 1000,
    actionsPerTurn: 2,
    logSize: 12,
    waveLength: 20,
    maxLevel: 10,
    pulseLifetime: 60,
    regimeWaves: [1, 3],
    regimeNotice: 'explicito',
    bench: 'livre',
    benchCostMs: 0,
    applyEndsTurn: false,
    timeBank: null,
    outputFade: null,
    veiled: [0.25, 0.65],
    baggageLimit: 4,
    multiplier: (level) => 1 + level * 0.25,
    mods: (level) => (level < 3 ? [0, 0] : level < 6 ? [0, 1] : [0, 2]),
    allKeysFromStart: false,
  },
  medio: {
    id: 'medio',
    label: 'Médio',
    summary: 'Banco de 60 s, a bancada consome tempo, saídas apagam devagar, a troca de regime só pisca um ícone.',
    energyPerTurn: 800,
    actionsPerTurn: 2,
    logSize: 5,
    waveLength: 20,
    maxLevel: 10,
    pulseLifetime: 60,
    regimeWaves: [1, 3],
    regimeNotice: 'sutil',
    bench: 'banco',
    benchCostMs: 5000,
    applyEndsTurn: false,
    timeBank: { startMs: 60_000, maxMs: 60_000, rechargeMs: 5000, resumeMs: 10_000 },
    outputFade: 8,
    veiled: [0.45, 0.75],
    baggageLimit: 3,
    multiplier: (level) => 1.5 + level * 0.3,
    mods: (level) => (level < 4 ? [1, 1] : [1, 2]),
    allKeysFromStart: true,
  },
  dificil: {
    id: 'dificil',
    label: 'Difícil',
    summary: 'Banco de 30 s, sem bancada, aplicar custa o turno, saídas apagam rápido, regime muda sem aviso.',
    energyPerTurn: 600,
    actionsPerTurn: 2,
    logSize: 3,
    waveLength: 20,
    maxLevel: 10,
    pulseLifetime: 60,
    regimeWaves: [1, 3],
    regimeNotice: 'nenhum',
    bench: 'nenhuma',
    benchCostMs: 0,
    applyEndsTurn: true,
    timeBank: { startMs: 30_000, maxMs: 30_000, rechargeMs: 3000, resumeMs: 10_000 },
    outputFade: 3,
    veiled: [0.6, 0.9],
    baggageLimit: 2,
    multiplier: (level) => 2.5 + level * 0.35,
    mods: (level) => (level < 5 ? [2, 2] : [2, 3]),
    allKeysFromStart: true,
  },
};

/** O fácil, usado como padrão pelos testes e pelo código antigo. */
export const FACIL = MODES.facil;

/** Parâmetros que o diretor ajusta, derivados do nível atual e do modo. */
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
  minMods: number;
  maxMods: number;
  brokenWires: number;
  outputSwaps: number;
}

export function levelParams(level: number, mode: ModeConfig = FACIL): LevelParams {
  const grow = Math.min(MAX_PORTS, 3 + Math.floor(level * 0.7));
  const bases: Base['kind'][] = ['ciclo', 'mapa'];
  if (level >= 3) bases.push('tabela');
  if (level >= 4) bases.push('anterior');
  const [veiledLow, veiledHigh] = mode.veiled;
  const [minMods, maxMods] = mode.mods(level);
  return {
    ports: grow,
    palette: PALETTE_ORDER.slice(0, grow),
    spawnRate: 0.4 + level * 0.1,
    veiledChance: veiledLow + ((veiledHigh - veiledLow) * level) / mode.maxLevel,
    anomalyChance: 0.05 + level * 0.01,
    maxCycleLength: Math.min(5, 2 + Math.floor(level / 2)),
    bases,
    keys: level >= 1 || mode.allKeysFromStart ? ['porta', 'carga', 'forma'] : ['porta'],
    minMods,
    maxMods,
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
