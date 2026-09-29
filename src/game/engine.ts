import { COLOR_LABEL } from '../core/colors';
import { Rng } from '../core/rng';
import type { BoxDef } from '../dsl/ast';
import type { DslError } from '../dsl/errors';
import { MAX_OPS_PER_CALL } from '../dsl/interpreter';
import { advance, isAssignable, PORTS, portRow } from './board';
import { classify, compileClassifier } from './classifier';
import { FACIL, levelParams, nextLevel, type ModeConfig, type WaveStats } from './mode';
import { colorFor, describeRegime, generateRegime, type Regime } from './pattern';
import type {
  DeliveredPulse,
  DeliveryOutcome,
  Destination,
  LogEntry,
  LogKind,
  Pulse,
  QueuedPulse,
  TurnEvent,
} from './types';

export const MAX_INTEGRITY = 10;
export const QUEUE_SIZE = 3;
const STREAK_FOR_REPAIR = 20;
const DELIVERED_KEPT = 40;
const POINTS_DELIVERY = 10;
const POINTS_NOISE = 5;

export interface Totals {
  acertos: number;
  erros: number;
  perdidos: number;
}

export interface InstalledScript {
  source: string;
  box: BoxDef;
  version: number;
}

export type ActionResult = { ok: true } | { ok: false; reason: string };

/** Estado e regras de uma partida. Tudo é determinístico a partir da semente. */
export class Game {
  readonly mode: ModeConfig;
  private readonly rng: Rng;

  turn = 1;
  level = 0;
  score = 0;
  integrity = MAX_INTEGRITY;
  actionsLeft: number;
  energyUsed = 0;
  over = false;

  pulses: Pulse[] = [];
  queue: QueuedPulse[] = [];
  delivered: DeliveredPulse[] = [];
  log: LogEntry[] = [];
  script: InstalledScript | null = null;

  regime: Regime;
  readonly regimesSeen: Regime[] = [];
  /** `seq` do primeiro pulso de cada regime depois do primeiro. */
  readonly regimeBoundaries: number[] = [];
  /** Eventos do último `endTurn()`. */
  lastEvents: TurnEvent[] = [];
  readonly totals: Totals = { acertos: 0, erros: 0, perdidos: 0 };
  maxLevel = 0;

  private regimeWavesLeft: number;
  private waveStats: WaveStats = emptyWave();
  private streak = 0;
  private nextSeq = 0;
  private nextId = 1;
  private nextSpawnTurn = 1;
  private scriptVersion = 0;

  /** `baggage`: script trazido da partida anterior, instalado antes do primeiro pulso entrar. */
  constructor(seed: number, mode: ModeConfig = FACIL, baggage: string | null = null) {
    this.mode = mode;
    this.rng = new Rng(seed);
    this.actionsLeft = mode.actionsPerTurn;
    this.regime = this.newRegime(null);
    this.regimeWavesLeft = this.rng.int(...mode.regimeWaves);
    if (baggage) this.installScript(baggage);
    this.fillQueue();
    this.spawnDue();
  }

  get wave(): number {
    return Math.floor((this.turn - 1) / this.mode.waveLength) + 1;
  }

  get turnInWave(): number {
    return ((this.turn - 1) % this.mode.waveLength) + 1;
  }

  get multiplier(): number {
    return this.mode.multiplier(this.level);
  }

  get energyLeft(): number {
    return Math.max(0, this.mode.energyPerTurn - this.energyUsed);
  }

  get precision(): number | null {
    const total = this.totals.acertos + this.totals.erros + this.totals.perdidos;
    return total === 0 ? null : this.totals.acertos / total;
  }

  /** Compila e instala o Classificador. No fácil, vale a partir do próximo pulso. */
  installScript(source: string): { ok: true } | { ok: false; error: DslError } {
    const compiled = compileClassifier(source);
    if (!compiled.ok) return compiled;
    this.scriptVersion++;
    this.script = { source, box: compiled.box, version: this.scriptVersion };
    this.addLog('script', `Classificador v${this.scriptVersion} aplicado.`);
    return { ok: true };
  }

  removeScript(): void {
    if (!this.script) return;
    this.script = null;
    this.addLog('script', 'Classificador removido: todos os pulsos ficam por sua conta.');
  }

  /** Ação manual: define o destino de um pulso. Custa 1 das ações do turno. */
  assign(pulseId: number, dest: Destination): ActionResult {
    if (this.over) return { ok: false, reason: 'a partida acabou' };
    const pulse = this.pulses.find((p) => p.id === pulseId);
    if (!pulse) return { ok: false, reason: 'pulso não encontrado' };
    if (!isAssignable(pulse)) return { ok: false, reason: 'o pulso já passou da coluna de decisão' };
    if (this.actionsLeft <= 0) return { ok: false, reason: 'sem ações neste turno: encerre o turno' };
    pulse.dest = dest;
    pulse.destBy = 'manual';
    this.actionsLeft--;
    return { ok: true };
  }

  /** Executa a etapa do mundo: pulsos andam, entregas são resolvidas e novos pulsos entram. */
  endTurn(): void {
    if (this.over) return;
    this.lastEvents = [];

    for (const pulse of [...this.pulses]) {
      if (advance(pulse)) this.deliver(pulse);
      if (this.over) return;
    }

    this.turn++;
    this.actionsLeft = this.mode.actionsPerTurn;
    this.energyUsed = this.script ? 1 : 0; // custo fixo do chip instalado

    if (this.turnInWave === 1) this.endWave();
    this.spawnDue();
  }

  private deliver(pulse: Pulse): void {
    this.pulses = this.pulses.filter((p) => p !== pulse);
    const dest = pulse.dest ?? { kind: 'terra' };
    const scoreBefore = this.score;
    const integrityBefore = this.integrity;
    const outcome = this.resolve(pulse, dest);
    this.lastEvents.push({
      kind: 'entrega',
      seq: pulse.seq,
      cor: pulse.cor,
      dest,
      outcome,
      points: this.score - scoreBefore,
      integrity: this.integrity - integrityBefore,
    });

    this.delivered.push({
      seq: pulse.seq,
      porta: pulse.porta,
      cor: pulse.cor,
      velado: pulse.velado,
      turno: pulse.spawnTurn,
      dest,
      outcome,
    });
    if (this.delivered.length > DELIVERED_KEPT) this.delivered.shift();

    if (this.integrity <= 0) {
      this.integrity = 0;
      this.over = true;
      this.addLog('erro', 'Integridade zerada: fim da partida.');
    }
  }

  private resolve(pulse: Pulse, dest: Destination): DeliveryOutcome {
    const label = pulseLabel(pulse);
    const mult = this.multiplier;

    if (dest.kind === 'terra') {
      if (pulse.cor === 'GRAY') {
        const pts = Math.round(POINTS_NOISE * mult);
        this.hit(pts);
        this.addLog('acerto', `${label} → terra ✓ +${pts}`);
        return 'acerto';
      }
      this.miss('perdidos');
      const why = pulse.destBy === 'auto' ? 'sem destino, caiu no terra' : 'enviado ao terra';
      this.addLog('perdido', `${label} ${why}: perdido`);
      return 'perdido';
    }

    const exit = COLOR_LABEL[dest.cor];
    if (pulse.cor === 'GRAY') {
      this.damage(2);
      this.addLog('erro', `${label} → saída ${exit} ✗ ruído numa saída, −2 integridade`);
      return 'erro';
    }
    if (pulse.cor !== dest.cor) {
      this.damage(1);
      this.addLog('erro', `${label} → saída ${exit} ✗ −1 integridade`);
      return 'erro';
    }
    const pts = Math.round(POINTS_DELIVERY * mult);
    this.hit(pts);
    this.addLog('acerto', `${label} → saída ${exit} ✓ +${pts}`);
    return 'acerto';
  }

  private hit(points: number): void {
    this.score += points;
    this.totals.acertos++;
    this.waveStats.acertos++;
    this.streak++;
    if (this.streak % STREAK_FOR_REPAIR === 0 && this.integrity < MAX_INTEGRITY) {
      this.integrity++;
      this.addLog('info', `${STREAK_FOR_REPAIR} acertos seguidos: +1 integridade.`);
    }
  }

  private miss(kind: 'erros' | 'perdidos'): void {
    this.totals[kind]++;
    this.waveStats[kind]++;
    this.streak = 0;
  }

  private damage(amount: number): void {
    this.miss('erros');
    this.integrity -= amount;
    this.waveStats.integrityLost += amount;
  }

  private endWave(): void {
    const before = this.level;
    this.level = nextLevel(this.level, this.waveStats, this.mode.maxLevel);
    this.maxLevel = Math.max(this.maxLevel, this.level);
    if (this.level !== before) {
      this.lastEvents.push({ kind: 'nivel', from: before, to: this.level });
      const dir = this.level > before ? 'sobe' : 'desce';
      this.addLog('diretor', `Onda ${this.wave}: o diretor ${dir} para o nível ${this.level} (×${this.multiplier.toFixed(1)}).`);
    } else {
      this.addLog('diretor', `Onda ${this.wave} começou (nível ${this.level}).`);
    }
    this.waveStats = emptyWave();

    this.regimeWavesLeft--;
    if (this.regimeWavesLeft <= 0) {
      this.regime = this.newRegime(this.regime);
      this.regimeWavesLeft = this.rng.int(...this.mode.regimeWaves);
      this.regimeBoundaries.push(this.queue[0]?.seq ?? this.nextSeq);
      this.lastEvents.push({ kind: 'regime' });
      for (const q of this.queue) {
        if (q.cor !== 'GRAY') q.cor = colorFor(this.regime, q.seq, q.porta);
      }
      if (this.mode.announceRegime) this.addLog('regime', 'Mudança de regime: a regra oculta mudou!');
    }
  }

  private newRegime(previous: Regime | null): Regime {
    const params = levelParams(this.level);
    const regime = generateRegime(this.rng, {
      palette: params.palette,
      maxCycleLength: params.maxCycleLength,
      previous,
    });
    this.regimesSeen.push(regime);
    return regime;
  }

  private fillQueue(): void {
    while (this.queue.length < QUEUE_SIZE) {
      const params = levelParams(this.level);
      const seq = this.nextSeq++;
      const porta = this.rng.pick(PORTS);
      const noise = this.rng.chance(params.noiseChance);
      // Ruído nunca é velado: sua cor não segue a regra e não teria como ser deduzida.
      const velado = !noise && this.rng.chance(params.veiledChance);
      this.queue.push({
        seq,
        porta,
        cor: noise ? 'GRAY' : colorFor(this.regime, seq, porta),
        velado,
        turn: this.nextSpawnTurn,
      });
      this.nextSpawnTurn += this.rng.int(...params.spawnGap);
    }
  }

  private spawnDue(): void {
    while (this.queue.length > 0 && this.queue[0].turn <= this.turn) {
      const q = this.queue.shift()!;
      const pulse: Pulse = {
        id: this.nextId++,
        seq: q.seq,
        porta: q.porta,
        cor: q.cor,
        velado: q.velado,
        spawnTurn: this.turn,
        row: portRow(q.porta),
        col: 0,
        dest: null,
        destBy: null,
      };
      this.pulses.push(pulse);
      this.runClassifier(pulse);
      this.fillQueue();
    }
  }

  private runClassifier(pulse: Pulse): void {
    if (!this.script) return;
    const remaining = this.energyLeft;
    if (remaining <= 0) {
      this.addLog('script', `#${pulse.seq}: sem energia neste turno, o Classificador não rodou.`);
      return;
    }
    const limit = Math.min(MAX_OPS_PER_CALL, remaining);
    const result = classify(
      this.script.box,
      { seq: pulse.seq, porta: pulse.porta, cor: pulse.velado ? null : pulse.cor, turno: this.turn },
      limit,
    );
    this.energyUsed += result.ops;
    if (!result.ok) {
      const cause = result.limitHit && limit < MAX_OPS_PER_CALL ? 'a energia do turno acabou' : result.message;
      this.addLog('script', `#${pulse.seq}: Classificador falhou na linha ${result.line}: ${cause}.`);
      return;
    }
    if (result.decision.kind === 'manual') return;
    pulse.dest = result.decision;
    pulse.destBy = 'script';
  }

  private addLog(kind: LogKind, text: string): void {
    this.log.push({ turn: this.turn, kind, text });
    if (this.log.length > 200) this.log.shift();
  }

  /** Resumo usado na tela de fim de partida. */
  summary() {
    return {
      score: this.score,
      turns: this.turn,
      waves: this.wave,
      precision: this.precision,
      totals: { ...this.totals },
      maxLevel: this.maxLevel,
      regimes: this.regimesSeen.map(describeRegime),
    };
  }
}

function emptyWave(): WaveStats {
  return { acertos: 0, erros: 0, perdidos: 0, integrityLost: 0 };
}

function pulseLabel(pulse: Pulse): string {
  const veil = pulse.velado ? ', velado' : '';
  return `#${pulse.seq} (porta ${pulse.porta}, ${COLOR_LABEL[pulse.cor]}${veil})`;
}
