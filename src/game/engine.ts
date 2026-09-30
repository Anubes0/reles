import { COLOR_LABEL, SHAPES, type Dir, type RouteAction } from '../core/colors';
import { Rng } from '../core/rng';
import type { BoxDef } from '../dsl/ast';
import { DslError, type Features } from '../dsl/errors';
import { MAX_OPS_PER_CALL } from '../dsl/interpreter';
import type { Value } from '../dsl/values';
import { cellKey, COLS, DEADLINE_COL, generateLayout, Grid, LAST_RELAY_COL, TERRA_ROW, type Cell } from './board';
import {
  BOX_IDS,
  BOX_INFO,
  classify,
  compileFor,
  HIST_SIZE,
  learn,
  MEM_SIZE,
  predict,
  route,
  watch,
  type BoxContext,
  type BoxFailure,
  type BoxId,
} from './boxes';
import { FACIL, levelParams, MODES, nextLevel, type LevelParams, type ModeConfig, type ModeId, type WaveStats } from './mode';
import { colorFor, describeRule, generateRule, type Rule, type Traits } from './pattern';
import { featuresFrom, type ResearchId } from './research';
import type {
  DeliveredPulse,
  DeliveryOutcome,
  Destination,
  EventView,
  LogEntry,
  LogKind,
  Pulse,
  PulseView,
  QueuedPulse,
  TurnEvent,
} from './types';

export const MAX_INTEGRITY = 10;
export const QUEUE_SIZE = 5;
const STREAK_FOR_REPAIR = 20;
const DELIVERED_KEPT = 60;
const ENTERED_KEPT = 200;
const POINTS_DELIVERY = 10;
const POINTS_NOISE = 5;
/** Custo de energia, por turno, de cada posição ocupada do `mem`. */
const MEM_COST_PER_SLOT = 2;
/** Bônus de eficiência: até esta fração dos pontos da onda, pela energia que sobrou. */
const EFFICIENCY_SHARE = 0.25;

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

/** Como a partida começou. Com os comandos do diário, basta para refazê-la igual. */
export interface MatchStart {
  seed: number;
  mode: ModeId;
  baggage: Partial<Record<BoxId, string>>;
  unlocked: ResearchId[];
}

/** Tudo o que muda uma partida por fora do gerador. Turnos seguidos viram um só comando. */
export type Command =
  | { c: 'destino'; id: number; dest: Destination }
  | { c: 'segurar'; id: number }
  | { c: 'girar'; row: number; col: number; step: 1 | -1 }
  | { c: 'aplicar'; box: BoxId; source: string }
  | { c: 'remover'; box: BoxId }
  | { c: 'liberar'; id: ResearchId }
  | { c: 'turno'; n: number };

export const BOX_LABEL: Record<BoxId, string> = Object.fromEntries(BOX_IDS.map((b) => [b, BOX_INFO[b].label])) as Record<BoxId, string>;

interface Move {
  pulse: Pulse;
  from: Cell;
  to: Cell;
  stay: boolean;
  exits: boolean;
  dir: Dir;
}

/** Estado e regras de uma partida. Tudo é determinístico a partir da semente. */
export class Game {
  readonly mode: ModeConfig;
  readonly grid: Grid;
  private readonly rng: Rng;
  readonly start: MatchStart;
  /** Comandos desde o início, em ordem: é o que se salva para retomar a partida. */
  readonly journal: Command[] = [];
  private recording = false;

  turn = 1;
  level = 0;
  score = 0;
  integrity = MAX_INTEGRITY;
  actionsLeft: number;
  energyUsed = 0;
  /** Energia gasta no turno que acabou de passar (a do Roteador só aparece aí). */
  lastTurnEnergy = 0;
  over = false;

  pulses: Pulse[] = [];
  queue: QueuedPulse[] = [];
  delivered: DeliveredPulse[] = [];
  /** Tudo o que entrou, como era visível na entrada (fonte do `hist`). */
  entered: PulseView[] = [];
  /** Últimos eventos que o Vigia recebeu (fonte do `hist` dele). */
  events: EventView[] = [];
  log: LogEntry[] = [];
  scripts: Partial<Record<BoxId, InstalledScript>> = {};

  /** Pesquisa liberada neste modo (recursos da linguagem e caixas). */
  readonly unlocked: Set<ResearchId>;
  features: Features;
  /** Memória compartilhada entre as caixas; `null` até a Memória ser liberada. */
  mem: Value[] | null = null;

  rule: Rule;
  readonly rulesSeen: string[] = [];
  /** `seq` do primeiro pulso de cada regime depois do primeiro. */
  readonly regimeBoundaries: number[] = [];
  /** Eventos do último `endTurn()`. */
  lastEvents: TurnEvent[] = [];
  readonly totals: Totals = { acertos: 0, erros: 0, perdidos: 0 };
  maxLevel = 0;
  /** Previsões feitas e acertadas pelo Previsor. */
  predictions = { feitas: 0, acertos: 0 };
  efficiencyPoints = 0;

  private regimeWavesLeft: number;
  private waveStats: WaveStats = emptyWave();
  private wavePoints = 0;
  private waveEfficiency = 0;
  private streak = 0;
  private nextSeq = 0;
  private nextId = 1;
  private nextGenTurn = 1;
  private lastGenerated: Traits | null = null;
  /** Turno da última entrega em cada linha de saída (para as saídas que apagam). */
  private readonly seenAt = new Map<number, number>();
  private readonly versions: Record<BoxId, number> = { classificar: 0, rotear: 0, prever: 0, vigiar: 0, aprender: 0 };
  private readonly issues = new Map<BoxId, { count: number; first: string }>();
  private alertedThisTurn = false;

  /**
   * `baggage`: scripts trazidos da partida anterior, instalados antes do primeiro pulso entrar.
   * `unlocked`: pesquisa já comprada neste modo.
   */
  constructor(
    seed: number,
    mode: ModeConfig = FACIL,
    baggage: Partial<Record<BoxId, string>> = {},
    unlocked: Iterable<ResearchId> = [],
  ) {
    this.mode = mode;
    this.rng = new Rng(seed);
    this.grid = new Grid(generateLayout(this.rng));
    this.actionsLeft = mode.actionsPerTurn;
    this.unlocked = new Set(unlocked);
    this.start = { seed, mode: mode.id, baggage: { ...baggage }, unlocked: [...this.unlocked] };
    this.features = featuresFrom(this.unlocked);
    if (this.features.memoria) this.mem = Array.from({ length: MEM_SIZE }, () => null);
    for (const o of this.grid.layout.outputs) this.seenAt.set(o.row, 1);
    this.rule = this.newRule(null);
    this.regimeWavesLeft = this.rng.int(...mode.regimeWaves);
    for (const box of BOX_IDS) {
      const source = baggage[box];
      if (source && this.isBoxAvailable(box)) this.installScript(box, source);
    }
    this.fillQueue();
    this.spawnDue();
    this.runPredictor();
    this.flushIssues();
    this.recording = true;
  }

  /**
   * Refaz uma partida salva a partir do início e do diário. Retorna `null` se algum
   * comando não se repete (uma versão nova do jogo que muda as regras, por exemplo).
   */
  static replay(start: MatchStart, journal: readonly Command[]): Game | null {
    const mode = MODES[start.mode];
    if (!mode) return null;
    const game = new Game(start.seed, mode, start.baggage, start.unlocked);
    for (const cmd of journal) if (!game.execute(cmd)) return null;
    return game;
  }

  private execute(cmd: Command): boolean {
    switch (cmd.c) {
      case 'destino':
        return this.assign(cmd.id, cmd.dest).ok;
      case 'segurar':
        return this.hold(cmd.id).ok;
      case 'girar':
        return this.rotateRelay(cmd.row, cmd.col, cmd.step).ok;
      case 'aplicar':
        return this.installScript(cmd.box, cmd.source).ok;
      case 'remover':
        if (!this.scripts[cmd.box]) return false;
        this.removeScript(cmd.box);
        return true;
      case 'liberar':
        this.unlock(cmd.id);
        return true;
      case 'turno':
        for (let i = 0; i < cmd.n; i++) {
          if (this.over) return false;
          this.endTurn();
        }
        return true;
      default:
        return false;
    }
  }

  private writeJournal(cmd: Command): void {
    if (!this.recording) return;
    const last = this.journal[this.journal.length - 1];
    if (cmd.c === 'turno' && last?.c === 'turno') last.n += cmd.n;
    else this.journal.push(cmd);
  }

  // ---- Leitura ----

  get params(): LevelParams {
    return levelParams(this.level, this.mode);
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

  /** Portas ativas no nível atual, em ordem crescente. */
  get activePorts(): number[] {
    return this.grid.layout.portActivation.slice(0, this.params.ports).sort((a, b) => a - b);
  }

  get activeExitRows(): number[] {
    const colors = this.params.palette;
    return [TERRA_ROW, ...this.grid.layout.outputs.filter((o) => colors.includes(o.cor)).map((o) => o.row)];
  }

  /** Posições do `mem` ocupadas (cada uma custa energia por turno). */
  get memUsed(): number {
    return this.mem ? this.mem.filter((v) => v !== null).length : 0;
  }

  /** A saída desta linha mostra a cor? No médio e no difícil, ela apaga sem entregas recentes. */
  outputVisible(row: number): boolean {
    if (row === TERRA_ROW || this.mode.outputFade === null) return true;
    return this.turn - (this.seenAt.get(row) ?? 1) < this.mode.outputFade;
  }

  isBoxAvailable(box: BoxId): boolean {
    const research = BOX_INFO[box].research;
    return !research || this.unlocked.has(research);
  }

  private get ctx(): BoxContext {
    return { features: this.features, mem: this.mem };
  }

  // ---- Pesquisa e scripts ----

  /** Libera um item de pesquisa no meio da partida (a compra em si fica com a interface). */
  unlock(id: ResearchId): void {
    if (this.unlocked.has(id)) return;
    this.unlocked.add(id);
    this.features = featuresFrom(this.unlocked);
    if (this.features.memoria && !this.mem) this.mem = Array.from({ length: MEM_SIZE }, () => null);
    this.writeJournal({ c: 'liberar', id });
  }

  /** Compila e instala uma caixa. No fácil e no médio, vale a partir do próximo uso. */
  installScript(box: BoxId, source: string): { ok: true } | { ok: false; error: DslError } {
    if (!this.isBoxAvailable(box)) {
      return { ok: false, error: new DslError(`a caixa ${BOX_LABEL[box]} ainda não foi liberada na pesquisa`, 1, 1) };
    }
    const compiled = compileFor(box, source, this.features);
    if (!compiled.ok) return compiled;
    this.versions[box]++;
    this.scripts[box] = { source, box: compiled.box, version: this.versions[box] };
    this.addLog('script', `${BOX_LABEL[box]} v${this.versions[box]} aplicado.`);
    this.writeJournal({ c: 'aplicar', box, source });
    return { ok: true };
  }

  removeScript(box: BoxId): void {
    if (!this.scripts[box]) return;
    delete this.scripts[box];
    this.addLog('script', `${BOX_LABEL[box]} removido.`);
    this.writeJournal({ c: 'remover', box });
  }

  // ---- Ações manuais (cada uma custa 1 ação do turno) ----

  /** Define o destino de um pulso. Vale até ele passar da última coluna de relés. */
  assign(pulseId: number, dest: Destination): ActionResult {
    const pulse = this.pulses.find((p) => p.id === pulseId);
    const blocked = this.actionBlocked(pulse);
    if (blocked) return blocked;
    if (pulse!.col > LAST_RELAY_COL) return { ok: false, reason: 'o pulso já passou do último relé' };
    pulse!.dest = dest;
    pulse!.destBy = 'manual';
    this.actionsLeft--;
    this.writeJournal({ c: 'destino', id: pulseId, dest: { ...dest } });
    return { ok: true };
  }

  /** Segura um pulso: ele não anda no próximo passo. */
  hold(pulseId: number): ActionResult {
    const pulse = this.pulses.find((p) => p.id === pulseId);
    const blocked = this.actionBlocked(pulse);
    if (blocked) return blocked;
    if (pulse!.held) return { ok: false, reason: 'este pulso já está segurado' };
    pulse!.held = true;
    this.actionsLeft--;
    this.writeJournal({ c: 'segurar', id: pulseId });
    return { ok: true };
  }

  /** Gira um relé para a próxima direção válida. */
  rotateRelay(row: number, col: number, step: 1 | -1 = 1): ActionResult {
    if (this.over) return { ok: false, reason: 'a partida acabou' };
    if (!this.grid.isRelay(row, col)) return { ok: false, reason: 'isso não é um relé' };
    if (this.actionsLeft <= 0) return { ok: false, reason: 'sem ações neste turno: encerre o turno' };
    if (!this.grid.rotate(row, col, step)) return { ok: false, reason: 'este relé só tem uma direção possível' };
    this.actionsLeft--;
    this.writeJournal({ c: 'girar', row, col, step });
    return { ok: true };
  }

  private actionBlocked(pulse: Pulse | undefined): ActionResult | null {
    if (this.over) return { ok: false, reason: 'a partida acabou' };
    if (!pulse) return { ok: false, reason: 'pulso não encontrado' };
    if (this.actionsLeft <= 0) return { ok: false, reason: 'sem ações neste turno: encerre o turno' };
    return null;
  }

  // ---- Turno ----

  /** Etapa do mundo: pulsos andam, entregas e colisões são resolvidas e novos pulsos entram. */
  endTurn(): void {
    if (this.over) return;
    this.writeJournal({ c: 'turno', n: 1 });
    this.lastEvents = [];
    this.alertedThisTurn = false;

    this.stepWorld();
    this.lastTurnEnergy = this.energyUsed;
    this.trackEfficiency();
    if (this.over) {
      this.flushIssues();
      return;
    }

    this.turn++;
    this.actionsLeft = this.mode.actionsPerTurn;
    // Custo fixo: cada caixa instalada e cada posição ocupada do mem.
    this.energyUsed = Object.keys(this.scripts).length + MEM_COST_PER_SLOT * this.memUsed;

    if (this.turnInWave === 1) this.endWave();
    this.spawnDue();
    this.runPredictor();
    this.flushIssues();
  }

  private stepWorld(): void {
    const order = [...this.pulses].sort((a, b) => a.seq - b.seq);
    const moves: Move[] = [];
    const decided = new Set<Pulse>();

    /** Para onde um pulso que ainda não decidiu deve ir: pela seta atual, se nada mudar. */
    const predicted = (u: Pulse): Cell => {
      if (u.held) return { row: u.row, col: u.col };
      const d = this.grid.isRelay(u.row, u.col) ? this.grid.dir(u.row, u.col) : 'LESTE';
      return this.grid.canGo(u.row, u.col, d) ? this.grid.step(u.row, u.col, d) : { row: u.row, col: u.col };
    };

    /**
     * Sensor `ocupado`: a casa vai estar ocupada depois deste passo? Os mais antigos
     * decidem primeiro; os demais são previstos pela seta atual.
     */
    const willBeOccupied = (self: Pulse, target: Cell): boolean => {
      const same = (a: Cell, b: Cell) => a.row === b.row && a.col === b.col;
      for (const m of moves) {
        if (!m.exits && same(m.stay ? m.from : m.to, target)) return true;
      }
      for (const u of order) {
        if (u === self || decided.has(u)) continue;
        const next = predicted(u);
        if (next.col < COLS && same(next, target)) return true;
      }
      return false;
    };

    for (const pulse of order) {
      const from = { row: pulse.row, col: pulse.col };
      let stay = pulse.held;
      let d: Dir = 'LESTE';
      if (!stay && this.grid.isRelay(pulse.row, pulse.col)) {
        if (!pulse.dest && pulse.col >= DEADLINE_COL) {
          pulse.dest = { kind: 'terra' };
          pulse.destBy = 'auto';
        }
        stay = this.runRouter(pulse, willBeOccupied) === 'ESPERAR';
        d = this.grid.dir(pulse.row, pulse.col);
        if (!this.grid.canGo(pulse.row, pulse.col, d)) stay = true;
      }
      const to = stay ? from : this.grid.step(from.row, from.col, d);
      moves.push({ pulse, from, to, stay, exits: !stay && to.col >= COLS, dir: d });
      decided.add(pulse);
    }

    // Fila: quem vai para uma casa cujo ocupante fica parado também fica.
    for (let changed = true; changed; ) {
      changed = false;
      const staying = new Set(moves.filter((m) => m.stay).map((m) => cellKey(m.from.row, m.from.col)));
      for (const m of moves) {
        if (!m.stay && !m.exits && staying.has(cellKey(m.to.row, m.to.col))) {
          m.stay = true;
          m.to = m.from;
          changed = true;
        }
      }
    }

    // Colisões: dois pulsos entrando na mesma casa. (No barramento vertical, pulsos
    // em sentidos opostos passam um pelo outro: a via é de mão dupla.)
    const collided = new Map<Move, Cell>();
    const byTarget = new Map<string, Move[]>();
    for (const m of moves) {
      if (m.stay || m.exits) continue;
      const key = cellKey(m.to.row, m.to.col);
      byTarget.set(key, [...(byTarget.get(key) ?? []), m]);
    }
    for (const group of byTarget.values()) {
      if (group.length > 1) for (const m of group) collided.set(m, m.to);
    }

    const crashes = new Map<string, { cell: Cell; seqs: number[] }>();
    for (const m of moves) {
      const { pulse } = m;
      pulse.held = false;
      pulse.stalled = m.stay;
      const crashCell = collided.get(m);
      if (crashCell) {
        const key = cellKey(crashCell.row, crashCell.col);
        const crash = crashes.get(key) ?? { cell: crashCell, seqs: [] };
        crash.seqs.push(pulse.seq);
        crashes.set(key, crash);
        pulse.row = crashCell.row;
        pulse.col = crashCell.col;
        this.lose(pulse, 'colisao');
      } else if (m.exits) {
        this.deliver(pulse, m.from.row);
      } else if (!m.stay) {
        pulse.row = m.to.row;
        pulse.col = m.to.col;
        pulse.heading = m.dir;
      }
    }
    for (const { cell, seqs } of crashes.values()) {
      const list = seqs.map((s) => `#${s}`).join(' e ');
      this.addLog('erro', `Colisão na linha ${cell.row}, coluna ${cell.col}: ${list} se perderam, −${seqs.length} integridade`);
      this.lastEvents.push({ kind: 'colisao', row: cell.row, col: cell.col, count: seqs.length });
    }

    // Tempo de vida: quem roda demais pela grade queima.
    for (const pulse of [...this.pulses]) {
      if (this.turn + 1 - pulse.spawnTurn >= this.mode.pulseLifetime) {
        this.addLog('perdido', `${pulseLabel(pulse)} ficou ${this.mode.pulseLifetime} turnos na grade e queimou`);
        this.lastEvents.push({ kind: 'queimado', row: pulse.row, col: pulse.col });
        this.lose(pulse, 'queimou');
      }
    }

    if (this.integrity <= 0) {
      this.integrity = 0;
      this.over = true;
      this.addLog('erro', 'Integridade zerada: fim da partida.');
    }
  }

  // ---- Caixas: cada chamada gasta energia do turno ----

  /** Quantas operações a próxima chamada pode usar; `null` se a energia acabou. */
  private budget(box: BoxId): number | null {
    const remaining = this.energyLeft;
    if (remaining <= 0) {
      this.issue(box, 'a energia do turno acabou');
      return null;
    }
    return Math.min(MAX_OPS_PER_CALL, remaining);
  }

  /** Cobra a energia gasta e registra a falha, se houve. */
  private settle<T extends { ok: true; ops: number }>(box: BoxId, limit: number, result: T | BoxFailure): result is T {
    this.energyUsed += result.ops;
    if (result.ok) return true;
    const cause = result.limitHit && limit < MAX_OPS_PER_CALL ? 'a energia do turno acabou' : `linha ${result.line}: ${result.message}`;
    this.issue(box, cause);
    return false;
  }

  private runRouter(pulse: Pulse, willBeOccupied: (self: Pulse, target: Cell) => boolean): RouteAction {
    const script = this.scripts.rotear;
    if (!script) return 'MANTER';
    const limit = this.budget('rotear');
    if (limit === null) return 'MANTER';
    const { row, col } = pulse;
    const occupied = (d: Dir) => {
      const target = this.grid.step(row, col, d);
      return target.col < COLS && willBeOccupied(pulse, target);
    };
    const result = route(script.box, this.grid, row, col, viewOf(pulse), pulse.heading, pulse.dest, occupied, limit, this.ctx);
    if (!this.settle('rotear', limit, result)) return 'MANTER';
    const action = result.action;
    if (action !== 'ESPERAR' && action !== 'MANTER' && !this.grid.setDir(row, col, action)) {
      this.issue('rotear', `${action} bloqueado no relé da linha ${row}, coluna ${col}`);
    }
    return action;
  }

  private runClassifier(pulse: Pulse, view: PulseView, hist: PulseView[]): void {
    const script = this.scripts.classificar;
    if (!script) return;
    const limit = this.budget('classificar');
    if (limit === null) return;
    const result = classify(script.box, view, hist, limit, this.ctx);
    if (!this.settle('classificar', limit, result)) return;
    if (result.decision.kind === 'manual') return;
    pulse.dest = result.decision;
    pulse.destBy = 'script';
  }

  /** O Previsor aposta na cor do próximo pulso da fila, só com o histórico. */
  private runPredictor(): void {
    const script = this.scripts.prever;
    const next = this.queue[0];
    if (!script || !next || next.previsto !== undefined) return;
    const limit = this.budget('prever');
    if (limit === null) return;
    const result = predict(script.box, this.entered.slice(-HIST_SIZE), limit, this.ctx);
    if (!this.settle('prever', limit, result)) return;
    next.previsto = result.cor;
  }

  /** O Vigia recebe cada evento e pode disparar um alerta (a interface pausa o jogo). */
  private runWatcher(event: EventView): void {
    const script = this.scripts.vigiar;
    const hist = this.events.slice(-HIST_SIZE);
    this.events.push(event);
    if (this.events.length > HIST_SIZE * 3) this.events.shift();
    if (!script) return;
    const limit = this.budget('vigiar');
    if (limit === null) return;
    const result = watch(script.box, event, hist, limit, this.ctx);
    if (!this.settle('vigiar', limit, result) || !result.alert) return;
    const what = event.tipo === 'ENTREGA' ? (event.ok ? 'entrega certa' : 'entrega errada') : event.tipo === 'COLISAO' ? 'colisão' : 'pulso queimado';
    const text = `Vigia: alerta no pulso #${event.pulso.seq} (${what})`;
    this.addLog('alerta', text);
    if (!this.alertedThisTurn) this.lastEvents.push({ kind: 'alerta', seq: event.pulso.seq, text });
    this.alertedThisTurn = true;
  }

  /** O Aprendiz vê cada pulso que sai, com a cor revelada, e pode gravar no `mem`. */
  private runLearner(pulse: Pulse, ok: boolean): void {
    const script = this.scripts.aprender;
    if (!script) return;
    const limit = this.budget('aprender');
    if (limit === null) return;
    this.settle('aprender', limit, learn(script.box, revealedView(pulse), ok, limit, this.ctx));
  }

  // ---- Saídas da grade ----

  private deliver(pulse: Pulse, row: number): void {
    this.pulses = this.pulses.filter((p) => p !== pulse);
    const dest = this.grid.exitAt(row);
    const scoreBefore = this.score;
    const integrityBefore = this.integrity;
    const outcome = dest ? this.resolve(pulse, dest) : this.lostAtDeadEnd(pulse);
    this.record(pulse, dest, outcome);
    if (!dest) return;
    this.seenAt.set(row, this.turn);
    this.lastEvents.push({
      kind: 'entrega',
      seq: pulse.seq,
      cor: pulse.cor,
      dest,
      outcome,
      points: this.score - scoreBefore,
      integrity: this.integrity - integrityBefore,
    });
    this.runLearner(pulse, outcome === 'acerto');
    this.runWatcher({
      tipo: 'ENTREGA',
      pulso: revealedView(pulse),
      ok: outcome === 'acerto',
      saida: dest.kind === 'saida' ? dest.cor : null,
      terra: dest.kind === 'terra',
      destino: pulse.dest?.kind === 'saida' ? pulse.dest.cor : null,
    });
  }

  private lostAtDeadEnd(pulse: Pulse): DeliveryOutcome {
    this.miss('perdidos');
    this.addLog('perdido', `${pulseLabel(pulse)} saiu por uma linha sem saída: perdido`);
    return 'perdido';
  }

  /** Pulso destruído antes de sair: colisão custa 1 de integridade, queimar não. */
  private lose(pulse: Pulse, motivo: 'colisao' | 'queimou'): void {
    this.pulses = this.pulses.filter((p) => p !== pulse);
    if (motivo === 'colisao') this.damage(1);
    else this.miss('perdidos');
    this.record(pulse, null, motivo === 'colisao' ? 'erro' : 'perdido', motivo);
    this.runWatcher({
      tipo: motivo === 'colisao' ? 'COLISAO' : 'QUEIMOU',
      pulso: revealedView(pulse),
      ok: false,
      saida: null,
      terra: false,
      destino: pulse.dest?.kind === 'saida' ? pulse.dest.cor : null,
    });
  }

  private record(pulse: Pulse, dest: Destination | null, outcome: DeliveryOutcome, motivo?: 'colisao' | 'queimou'): void {
    this.delivered.push({
      seq: pulse.seq,
      porta: pulse.porta,
      cor: pulse.cor,
      velado: pulse.velado,
      carga: pulse.carga,
      forma: pulse.forma,
      turno: pulse.spawnTurn,
      dest,
      outcome,
      motivo,
    });
    if (this.delivered.length > DELIVERED_KEPT) this.delivered.shift();
  }

  private resolve(pulse: Pulse, dest: Destination): DeliveryOutcome {
    const label = pulseLabel(pulse);
    const mult = this.multiplier * (pulse.sintonizado ? 2 : 1);
    const tuned = pulse.sintonizado ? ' (sintonizado ×2)' : '';

    if (dest.kind === 'terra') {
      if (pulse.cor === 'GRAY') {
        const pts = Math.round(POINTS_NOISE * mult);
        this.hit(pts);
        this.addLog('acerto', `${label} → terra ✓ +${pts}${tuned}`);
        return 'acerto';
      }
      this.miss('perdidos');
      const why = pulse.destBy === 'auto' ? 'sem destino, foi ao terra' : 'chegou ao terra';
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
    this.addLog('acerto', `${label} → saída ${exit} ✓ +${pts}${tuned}`);
    return 'acerto';
  }

  private hit(points: number): void {
    this.score += points;
    this.wavePoints += points;
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

  /** Fração de energia que sobrou no turno; só conta com alguma caixa instalada. */
  private trackEfficiency(): void {
    if (Object.keys(this.scripts).length === 0) return;
    this.waveEfficiency += this.energyLeft / this.mode.energyPerTurn;
  }

  // ---- Ondas: diretor, eficiência, grade e regime ----

  private endWave(): void {
    const efficiency = this.waveEfficiency / this.mode.waveLength;
    const bonus = Math.round(efficiency * this.wavePoints * EFFICIENCY_SHARE);
    if (bonus > 0) {
      this.score += bonus;
      this.efficiencyPoints += bonus;
      this.lastEvents.push({ kind: 'eficiencia', points: bonus });
      this.addLog('info', `Eficiência da onda: +${bonus} (sobrou ${Math.round(efficiency * 100)}% da energia).`);
    }
    this.wavePoints = 0;
    this.waveEfficiency = 0;

    const before = this.level;
    this.level = nextLevel(this.level, this.waveStats, this.mode.maxLevel);
    this.maxLevel = Math.max(this.maxLevel, this.level);
    if (this.level !== before) {
      this.lastEvents.push({ kind: 'nivel', from: before, to: this.level });
      const dir = this.level > before ? 'sobe' : 'desce';
      this.addLog('diretor', `Onda ${this.wave}: o diretor ${dir} para o nível ${this.level} (×${this.multiplier.toFixed(2)}).`);
    } else {
      this.addLog('diretor', `Onda ${this.wave} começou (nível ${this.level}).`);
    }
    this.waveStats = emptyWave();

    const params = this.params;
    if (params.brokenWires > 0 || this.grid.broken.size > 0) {
      const occupied = Grid.occupiedSegments(this.pulses);
      const portRows = this.activePorts.map((p) => this.grid.portRow(p));
      const broken = this.grid.mutate(this.rng, params.brokenWires, portRows, this.activeExitRows, occupied);
      this.lastEvents.push({ kind: 'grade', broken });
      this.addLog('grade', broken > 0 ? `A grade mudou: ${broken} fios rompidos.` : 'A grade foi consertada.');
    }
    if (params.outputSwaps > 0) {
      const committed = new Set(this.pulses.filter((p) => p.col > LAST_RELAY_COL).map((p) => p.row));
      const swaps = this.grid.driftOutputs(this.rng, params.palette, params.outputSwaps, committed);
      this.lastEvents.push({ kind: 'deriva', swaps });
      this.addLog('grade', `Deriva: ${swaps === 1 ? 'duas saídas trocaram' : `${swaps} pares de saídas trocaram`} de cor.`);
    }

    this.regimeWavesLeft--;
    if (this.regimeWavesLeft <= 0) {
      this.rule = this.newRule(this.rule);
      this.regimeWavesLeft = this.rng.int(...this.mode.regimeWaves);
      this.regimeBoundaries.push(this.queue[0]?.seq ?? this.nextSeq);
      this.recolorQueue();
      this.lastEvents.push({ kind: 'regime' });
      if (this.mode.regimeNotice === 'explicito') this.addLog('regime', 'Mudança de regime: a regra oculta mudou!');
    }
  }

  private newRule(previous: Rule | null): Rule {
    const p = this.params;
    const rule = generateRule(this.rng, {
      palette: p.palette,
      maxCycleLength: p.maxCycleLength,
      bases: p.bases,
      keys: p.keys,
      minMods: p.minMods,
      maxMods: p.maxMods,
      previous,
      activePorts: this.activePorts,
    });
    this.rulesSeen.push(describeRule(rule, this.activePorts));
    return rule;
  }

  /** Na troca de regime, a fila passa a seguir a regra nova (o ruído aleatório continua ruído). */
  private recolorQueue(): void {
    const last = this.entered[this.entered.length - 1];
    let prev: Traits | null = last ? traitsOf(last) : null;
    for (const q of this.queue) {
      if (!q.anomalia) q.cor = colorFor(this.rule, traitsOf(q), prev);
      prev = traitsOf(q);
    }
  }

  // ---- Entrada de pulsos ----

  private fillQueue(): void {
    while (this.queue.length < QUEUE_SIZE) {
      const p = this.params;
      const turn = this.nextGenTurn++;
      const count = Math.floor(p.spawnRate) + (this.rng.chance(p.spawnRate % 1) ? 1 : 0);
      const ports = shuffle(this.rng, this.activePorts).slice(0, count).sort((a, b) => a - b);
      for (const porta of ports) {
        const traits: Traits = { seq: this.nextSeq++, porta, carga: this.rng.int(1, 3), forma: this.rng.pick(SHAPES) };
        const anomalia = this.rng.chance(p.anomalyChance);
        this.queue.push({
          ...traits,
          cor: anomalia ? 'GRAY' : colorFor(this.rule, traits, this.lastGenerated),
          // Ruído aleatório nunca é velado: não teria como ser deduzido.
          velado: !anomalia && this.rng.chance(p.veiledChance),
          turn,
          anomalia,
        });
        this.lastGenerated = traits;
      }
    }
  }

  private spawnDue(): void {
    while (this.queue.length > 0 && this.queue[0].turn <= this.turn) {
      const q = this.queue[0];
      const row = this.grid.portRow(q.porta);
      // Entrada ocupada (pulso segurado na porta): a fila espera.
      if (this.pulses.some((p) => p.row === row && p.col === 0)) break;
      this.queue.shift();
      const sintonizado = q.previsto !== undefined && q.previsto !== null && q.previsto === q.cor;
      if (q.previsto !== undefined && q.previsto !== null) {
        this.predictions.feitas++;
        if (sintonizado) this.predictions.acertos++;
        this.lastEvents.push({ kind: 'previsao', seq: q.seq, acertou: sintonizado });
        if (sintonizado) this.addLog('info', `Previsor acertou #${q.seq}: pulso sintonizado, vale o dobro.`);
      }
      const pulse: Pulse = {
        id: this.nextId++,
        seq: q.seq,
        porta: q.porta,
        cor: q.cor,
        velado: q.velado,
        carga: q.carga,
        forma: q.forma,
        spawnTurn: this.turn,
        row,
        col: 0,
        dest: null,
        destBy: null,
        held: false,
        stalled: false,
        heading: 'LESTE',
        sintonizado,
      };
      const view = viewOf(pulse);
      this.runClassifier(pulse, view, this.entered.slice(-HIST_SIZE));
      this.entered.push(view);
      if (this.entered.length > ENTERED_KEPT) this.entered.shift();
      this.pulses.push(pulse);
      this.fillQueue();
    }
  }

  // ---- Registro ----

  /** Falhas de script são agrupadas por turno para não afogar o registro. */
  private issue(box: BoxId, message: string): void {
    const current = this.issues.get(box);
    if (current) current.count++;
    else this.issues.set(box, { count: 1, first: message });
  }

  private flushIssues(): void {
    for (const [box, { count, first }] of this.issues) {
      const times = count > 1 ? ` (${count}× neste turno)` : '';
      this.addLog('script', `${BOX_LABEL[box]} falhou${times}: ${first}.`);
    }
    this.issues.clear();
  }

  private addLog(kind: LogKind, text: string): void {
    this.log.push({ turn: this.turn, kind, text });
    if (this.log.length > 300) this.log.shift();
  }

  /** Resumo usado na tela de fim de partida e no histórico. */
  summary() {
    return {
      score: this.score,
      turns: this.turn,
      waves: this.wave,
      precision: this.precision,
      totals: { ...this.totals },
      maxLevel: this.maxLevel,
      regimes: [...this.rulesSeen],
      predictions: { ...this.predictions },
      efficiencyPoints: this.efficiencyPoints,
    };
  }
}

export function viewOf(pulse: Pulse): PulseView {
  return {
    seq: pulse.seq,
    porta: pulse.porta,
    cor: pulse.velado ? null : pulse.cor,
    turno: pulse.spawnTurn,
    carga: pulse.carga,
    forma: pulse.forma,
  };
}

/** O pulso com a cor real: é assim que o Aprendiz e o Vigia o veem depois que ele sai. */
function revealedView(pulse: Pulse): PulseView {
  return { ...viewOf(pulse), cor: pulse.cor };
}

function traitsOf(t: Traits): Traits {
  return { seq: t.seq, porta: t.porta, carga: t.carga, forma: t.forma };
}

function emptyWave(): WaveStats {
  return { acertos: 0, erros: 0, perdidos: 0, integrityLost: 0 };
}

function pulseLabel(pulse: Pulse): string {
  const veil = pulse.velado ? ', velado' : '';
  return `#${pulse.seq} (P${pulse.porta}, ${COLOR_LABEL[pulse.cor]}${veil})`;
}

function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
