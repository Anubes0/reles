import { COLOR_LABEL } from '../core/colors';
import { LAST_RELAY_COL } from '../game/board';
import { formatDecision, runBench, verifyRouter, type BenchResult, type RouteBenchResult } from '../game/bench';
import { BOX_IDS, BOX_INFO, type BoxId } from '../game/boxes';
import { BOX_LABEL, Game, MAX_INTEGRITY } from '../game/engine';
import { MODE_IDS, MODES, type ModeId } from '../game/mode';
import { researchPointsFor, RESEARCH, type ResearchId } from '../game/research';
import { TimeBank } from '../game/timebank';
import type { Destination } from '../game/types';
import { DEFAULT_SCRIPTS } from './defaults';
import { helpContent, historyContent, modeContent, overContent, pauseContent, researchContent, type PauseNote } from './dialogs';
import { byId, el } from './dom';
import { CodeEditor } from './editor';
import { BoardRenderer, destLabel, outputSlots } from './render';
import { storage, type SavedMatch } from './storage';
import { PULSE_FILL } from './theme';
import { PatternTimeline, timelineItems, type RowKey } from './timeline';

const BENCH_SIZE = 20;
const AUTO_TURN_MS = 650;
const BANK_TICK_MS = 100;
/** Turnos que o ícone de regime pisca no médio (aviso sutil). */
const REGIME_ICON_TURNS = 3;
const DEFAULT_HINT = 'Clique num pulso (ou Tab) e escolha a saída (clique ou 1–9, 0, T). Clique num relé para girá-lo.';

const BOX_HELP: Record<BoxId, string> = {
  classificar: 'decide o destino de cada pulso que entra',
  rotear: 'decide a seta de um relé quando há pulso nele',
  prever: 'aposta na cor do próximo pulso; acertou, ele vale o dobro',
  vigiar: 'recebe cada evento e pode dar ALERTA, que pausa o jogo',
  aprender: 'recebe cada pulso que sai, com a cor real, e grava no mem',
};

type Dialog = 'help' | 'pause' | 'over' | 'mode' | 'research' | 'history' | null;
type Tab = 'signals' | 'log' | 'bench' | 'ref';

export class App {
  private mode: ModeId;
  private game: Game;
  private bank: TimeBank | null = null;
  private selectedId: number | null = null;
  private dialog: Dialog = null;
  private box: BoxId = 'classificar';
  private drafts: Record<BoxId, string>;
  private readonly renderer: BoardRenderer;
  private readonly editor: CodeEditor;
  private readonly timeline: PatternTimeline;
  private saveTimer = 0;
  private matchTimer = 0;
  private autoTimer = 0;
  private lastTick = performance.now();
  private turnStartedAt = performance.now();
  private turnTime = { total: 0, count: 0 };
  private regimeIconTurns = 0;
  private shown = { score: 0, integrity: MAX_INTEGRITY };

  private readonly ui = {
    mode: byId('hud-mode'),
    regime: byId('hud-regime'),
    bank: byId('hud-bank'),
    bankValue: byId('hud-bank-value'),
    bankFill: byId('hud-bank-fill'),
    pp: byId('hud-pp'),
    turn: byId('hud-turn'),
    wave: byId('hud-wave'),
    waveFill: byId('hud-wave-fill'),
    level: byId('hud-level'),
    score: byId('hud-score'),
    record: byId('hud-record'),
    integrity: byId('hud-integrity'),
    queue: byId('queue'),
    boardStats: byId('board-stats'),
    actions: byId('actions'),
    energyMeter: byId('energy-meter'),
    energyFill: byId('energy-fill'),
    energyValue: byId('energy-value'),
    autoBadge: byId('auto-badge'),
    hint: byId('hint'),
    signature: byId('box-signature'),
    bench: byId('bench'),
    log: byId('log'),
    overlay: byId('overlay'),
    dialog: byId('dialog'),
    canvas: byId<HTMLCanvasElement>('board'),
    hold: byId<HTMLButtonElement>('btn-hold'),
    end: byId<HTMLButtonElement>('btn-end'),
    test: byId<HTMLButtonElement>('btn-test'),
    apply: byId<HTMLButtonElement>('btn-apply'),
  };

  constructor() {
    const saved = storage.match();
    const resumed = saved ? this.resume(saved) : null;
    this.mode = resumed?.start.mode ?? storage.lastMode();
    this.game = resumed ?? this.newGame(this.mode);
    this.drafts = this.loadDrafts();
    this.renderer = new BoardRenderer(this.ui.canvas, () => ({ game: this.game, selectedId: this.selectedId }));
    this.timeline = new PatternTimeline(byId('timeline'));
    this.editor = new CodeEditor(
      {
        textarea: byId('editor'),
        highlight: byId('highlight'),
        gutter: byId('gutter'),
        completions: byId('completions'),
        message: byId('editor-msg'),
      },
      {
        onChange: (source) => this.onEditorChange(source),
        onApply: () => this.applyScript(),
        onTest: () => this.testScript(),
      },
    );
    this.editor.features = this.game.features;
    this.editor.load(this.box, this.drafts[this.box]);

    this.ui.end.addEventListener('click', () => this.endTurn());
    this.ui.apply.addEventListener('click', () => this.applyScript());
    this.ui.test.addEventListener('click', () => this.testScript());
    byId('btn-remove').addEventListener('click', () => this.removeScript());
    byId('btn-new').addEventListener('click', () => this.openDialog('mode'));
    byId('btn-help').addEventListener('click', () => this.openDialog('help'));
    byId('btn-research').addEventListener('click', () => this.openDialog('research'));
    byId('btn-history').addEventListener('click', () => this.openDialog('history'));
    this.ui.hold.addEventListener('click', () => this.holdSelected());
    for (const box of BOX_IDS) byId(`box-${box}`).addEventListener('click', () => this.switchBox(box));
    for (const tab of ['signals', 'log', 'bench', 'ref'] as const) {
      byId(`tab-${tab}`).addEventListener('click', () => this.showTab(tab));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-group]')) {
      button.addEventListener('click', () => this.setGrouping(button.dataset.group ? Number(button.dataset.group) : null));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-rows]')) {
      button.addEventListener('click', () => this.setRows(button.dataset.rows as RowKey));
    }
    this.ui.canvas.addEventListener('click', (e) => this.onCanvasClick(e, 1));
    this.ui.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onCanvasClick(e, -1);
    });
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Trocar de janela pausa o jogo nos modos com banco de tempo (sem penalidade).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      this.autoPause();
      this.persist();
    });
    window.addEventListener('blur', () => this.autoPause());
    // Fechar ou recarregar a aba não perde a partida: ela é salva e retomada.
    window.addEventListener('pagehide', () => this.persist());
    window.setInterval(() => this.tickBank(), BANK_TICK_MS);

    this.setHint('');
    this.refresh();
    if (resumed) this.announceResume();
    else if (saved) this.setHint('A partida salva não pôde ser retomada nesta versão do jogo; ela entrou no histórico como abandonada.', true);
    if (!storage.helpSeen()) this.openDialog('help');
  }

  // ---- Partida ----

  private newGame(mode: ModeId): Game {
    const seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    const config = MODES[mode];
    const game = new Game(seed, config, storage.baggage(mode), storage.unlocked(mode));
    this.bank = config.timeBank ? new TimeBank(config.timeBank) : null;
    this.stopAuto();
    this.turnStartedAt = performance.now();
    this.turnTime = { total: 0, count: 0 };
    this.regimeIconTurns = 0;
    this.shown = { score: 0, integrity: game.integrity };
    return game;
  }

  /**
   * Refaz a partida salva comando a comando e confere o resultado. Se não bater
   * (uma versão nova do jogo mudou as regras), ela conta como abandonada.
   */
  private resume(saved: SavedMatch): Game | null {
    try {
      const game = Game.replay(saved.start, saved.journal);
      const c = saved.check;
      if (!game || game.over || game.turn !== c.turn || game.score !== c.score || game.integrity !== c.integrity) {
        storage.clearMatch();
        if (!game?.over) {
          storage.finishMatch(saved.start.mode, {
            score: c.score,
            turns: c.turn,
            precision: c.precision,
            abandoned: true,
            date: new Date().toISOString(),
            maxLevel: c.maxLevel,
            regimes: c.regimes,
            avgTurnSeconds: saved.turnTime.count ? saved.turnTime.total / saved.turnTime.count : undefined,
          });
        }
        return null;
      }
      const bank = MODES[saved.start.mode].timeBank;
      this.bank = bank ? new TimeBank(bank) : null;
      if (this.bank && saved.bank) {
        this.bank.remainingMs = saved.bank.remainingMs;
        this.bank.auto = saved.bank.auto;
      }
      this.turnTime = { ...saved.turnTime };
      this.shown = { score: game.score, integrity: game.integrity };
      return game;
    } catch {
      // Dado salvo ilegível: não há o que retomar nem o que registrar.
      storage.clearMatch();
      return null;
    }
  }

  /** Nos modos com banco, a partida retomada começa pausada: o tempo só corre quando você volta. */
  private announceResume(): void {
    const text = `Partida do ${MODES[this.mode].label.toLowerCase()} retomada no turno ${this.game.turn}.`;
    if (!this.bank) {
      this.setHint(text);
      return;
    }
    if (this.bank.auto) this.startAuto();
    this.openDialog('pause', { title: 'Partida retomada', text });
  }

  /** Salva a partida ativa logo depois de cada mudança (sem gravar a cada clique). */
  private persistSoon(): void {
    window.clearTimeout(this.matchTimer);
    this.matchTimer = window.setTimeout(() => this.persist(), 300);
  }

  private persist(): void {
    window.clearTimeout(this.matchTimer);
    const g = this.game;
    if (g.over) return;
    const s = g.summary();
    storage.saveMatch({
      start: g.start,
      journal: g.journal,
      check: { turn: g.turn, score: g.score, integrity: g.integrity, precision: s.precision, maxLevel: s.maxLevel, regimes: s.regimes.length },
      bank: this.bank ? { remainingMs: this.bank.remainingMs, auto: this.bank.auto } : null,
      turnTime: this.turnTime,
    });
  }

  private loadDrafts(): Record<BoxId, string> {
    return Object.fromEntries(
      BOX_IDS.map((box) => [box, storage.script(this.mode, box) ?? this.game.scripts[box]?.source ?? DEFAULT_SCRIPTS[box]]),
    ) as Record<BoxId, string>;
  }

  private startNewGame(mode: ModeId): void {
    this.mode = mode;
    storage.saveLastMode(mode);
    this.game = this.newGame(mode);
    this.drafts = this.loadDrafts();
    this.editor.features = this.game.features;
    if (!this.game.isBoxAvailable(this.box)) this.box = 'classificar';
    this.editor.load(this.box, this.drafts[this.box]);
    this.selectedId = null;
    this.renderer.clearEffects();
    this.closeDialog();
    const carried = BOX_IDS.filter((b) => this.game.scripts[b]).map((b) => BOX_LABEL[b]);
    this.setHint(
      carried.length
        ? `Nova partida no ${MODES[mode].label.toLowerCase()}: ${carried.join(', ')} ${carried.length > 1 ? 'vieram' : 'veio'} na bagagem.`
        : `Nova partida no ${MODES[mode].label.toLowerCase()}.`,
    );
    this.refresh();
  }

  private inProgress(): boolean {
    return !this.game.over && (this.game.turn > 1 || this.game.delivered.length > 0);
  }

  /** Só existe uma partida por vez: começar outra abandona a atual. */
  private abandonCurrent(): void {
    if (!this.inProgress()) return;
    const s = this.game.summary();
    storage.finishMatch(this.mode, {
      score: s.score,
      turns: s.turns,
      precision: s.precision,
      abandoned: true,
      date: new Date().toISOString(),
      maxLevel: s.maxLevel,
      regimes: s.regimes.length,
      avgTurnSeconds: this.averageTurnSeconds(),
    });
  }

  private endTurn(auto = false): void {
    if (this.game.over) return;
    if (!auto && (this.dialog || this.bank?.auto)) return;
    if (auto && this.dialog) return;
    const now = performance.now();
    if (!auto) {
      this.turnTime.total += (now - this.turnStartedAt) / 1000;
      this.turnTime.count++;
    }
    this.turnStartedAt = now;

    const before = this.renderer.snapshot();
    this.game.endTurn();
    this.renderer.animateFrom(before);
    this.renderer.playEvents(this.game.lastEvents, this.game.mode.regimeNotice === 'explicito');
    this.bank?.turnEnded();
    if (this.bank && !this.bank.auto) this.stopAuto();

    if (this.game.lastEvents.some((e) => e.kind === 'regime') && this.game.mode.regimeNotice === 'sutil') {
      this.regimeIconTurns = REGIME_ICON_TURNS;
    } else if (this.regimeIconTurns > 0) {
      this.regimeIconTurns--;
    }

    const selected = this.game.pulses.find((p) => p.id === this.selectedId);
    if (!selected) this.selectedId = null;
    if (!auto) this.setHint('');

    this.refresh();
    const alert = this.game.lastEvents.find((e) => e.kind === 'alerta');
    if (this.game.over) {
      this.stopAuto();
      const result = this.recordFinish();
      window.setTimeout(() => this.openDialog('over', null, result), 700);
    } else if (alert && alert.kind === 'alerta') {
      window.setTimeout(() => this.openDialog('pause', { title: 'O Vigia disparou', text: alert.text }), 450);
    }
  }

  /**
   * Fim de partida: registra na hora (recorde, histórico e PP) e já deixa salva a bagagem
   * padrão, a mesma que vem marcada na tela final, caso a aba feche antes da escolha.
   */
  private recordFinish(): { isRecord: boolean; pp: number } {
    const g = this.game;
    const s = g.summary();
    const pp = researchPointsFor(s.score);
    const isRecord = storage.finishMatch(this.mode, {
      score: s.score,
      turns: s.turns,
      precision: s.precision,
      abandoned: false,
      date: new Date().toISOString(),
      maxLevel: s.maxLevel,
      regimes: s.regimes.length,
      avgTurnSeconds: this.averageTurnSeconds(),
      pp,
    });
    storage.clearMatch();
    const installed = BOX_IDS.filter((b) => g.scripts[b]).slice(0, g.mode.baggageLimit);
    storage.saveBaggage(this.mode, Object.fromEntries(installed.map((b) => [b, g.scripts[b]!.source])));
    return { isRecord, pp };
  }

  /** Bagagem escolhida: segue o que foi marcado; o resto é apagado. */
  private carryBaggage(carry: BoxId[]): void {
    const baggage = Object.fromEntries(carry.map((b) => [b, this.game.scripts[b]!.source]));
    storage.saveBaggage(this.mode, baggage);
    for (const box of BOX_IDS) if (!carry.includes(box)) storage.eraseScript(this.mode, box);
    this.openDialog('mode');
  }

  private averageTurnSeconds(): number | undefined {
    const { total, count } = this.turnTime;
    return count === 0 ? undefined : total / count;
  }

  // ---- Banco de tempo ----

  private tickBank(): void {
    const now = performance.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    const bank = this.bank;
    if (!bank || this.game.over || this.dialog || document.visibilityState !== 'visible' || bank.auto) return;
    if (bank.spend(elapsed)) this.startAuto();
    this.renderBank();
  }

  /** Banco zerado: os turnos passam sozinhos, só com os scripts, até ele recarregar. */
  private startAuto(): void {
    if (this.autoTimer) return;
    this.setHint('O tempo acabou: os turnos passam sozinhos, só com os scripts, até o banco recarregar.', true);
    this.autoTimer = window.setInterval(() => this.endTurn(true), AUTO_TURN_MS);
    this.refresh();
  }

  private stopAuto(): void {
    if (!this.autoTimer) return;
    window.clearInterval(this.autoTimer);
    this.autoTimer = 0;
    this.setHint('O banco recarregou: é a sua vez de novo.');
  }

  private autoPause(): void {
    if (this.bank && !this.dialog && !this.game.over) this.openDialog('pause');
  }

  // ---- Ações manuais ----

  private manualBlocked(): boolean {
    if (!this.bank?.auto) return false;
    this.setHint('Sem ações manuais enquanto o banco de tempo recarrega.', true);
    return true;
  }

  private assignSelected(dest: Destination): void {
    if (this.manualBlocked()) return;
    if (this.selectedId === null) {
      this.setHint('Selecione um pulso primeiro (clique nele ou use Tab).', true);
      return;
    }
    const result = this.game.assign(this.selectedId, dest);
    if (!result.ok) {
      this.setHint(`Não foi possível: ${result.reason}.`, true);
      return;
    }
    this.setHint(`Destino definido: ${destLabel(dest)}.`);
    this.cycleSelection(1, true);
  }

  private holdSelected(): void {
    if (this.manualBlocked()) return;
    if (this.selectedId === null) {
      this.setHint('Selecione um pulso para segurar.', true);
      return;
    }
    const result = this.game.hold(this.selectedId);
    this.setHint(result.ok ? 'Pulso segurado: ele não anda no próximo turno.' : `Não foi possível: ${result.reason}.`, !result.ok);
    this.refresh();
  }

  private rotate(row: number, col: number, step: 1 | -1): void {
    if (this.manualBlocked()) return;
    const result = this.game.rotateRelay(row, col, step);
    if (!result.ok) {
      this.setHint(`Não foi possível: ${result.reason}.`, true);
      return;
    }
    const arrow = { NORTE: '▲', LESTE: '►', SUL: '▼' }[this.game.grid.dir(row, col)];
    this.setHint(`Relé da linha ${row}, coluna ${col} agora aponta ${arrow}.`);
    this.refresh();
  }

  /** Seleciona o próximo pulso que ainda aceita destino, do mais adiantado ao mais atrasado. */
  private cycleSelection(step: 1 | -1, skipAssigned = false): void {
    const candidates = this.game.pulses
      .filter((p) => p.col <= LAST_RELAY_COL)
      .filter((p) => !skipAssigned || !p.dest)
      .sort((a, b) => b.col - a.col || a.seq - b.seq);
    if (candidates.length === 0) {
      if (skipAssigned) this.selectedId = null;
      this.refresh();
      return;
    }
    const index = candidates.findIndex((p) => p.id === this.selectedId);
    const next = index === -1 ? 0 : (index + step + candidates.length) % candidates.length;
    this.selectedId = candidates[next].id;
    this.refresh();
  }

  // ---- Scripts ----

  private switchBox(box: BoxId): void {
    if (!this.game.isBoxAvailable(box)) {
      const item = RESEARCH.find((r) => r.id === BOX_INFO[box].research)!;
      this.setHint(`${BOX_LABEL[box]} sai na Pesquisa por ${item.preco} PP.`, true);
      this.openDialog('research');
      return;
    }
    if (box === this.box) return;
    this.drafts[this.box] = this.editor.value;
    this.box = box;
    this.editor.load(box, this.drafts[box]);
    this.refresh();
  }

  private onEditorChange(source: string): void {
    this.drafts[this.box] = source;
    const { box, mode } = this;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => storage.saveScript(mode, box, source), 400);
    this.renderScriptStatus();
  }

  private applyScript(): void {
    if (this.game.mode.applyEndsTurn && this.manualBlocked()) return;
    const result = this.game.installScript(this.box, this.editor.value);
    if (!result.ok) {
      this.editor.showError(result.error.message, result.error.line, result.error.col);
      this.setHint('O script tem erro e não foi aplicado.', true);
      return;
    }
    if (this.game.mode.applyEndsTurn) {
      this.endTurn();
      this.setHint(`${BOX_LABEL[this.box]} aplicado. No difícil, aplicar custa o turno.`);
      return;
    }
    this.setHint(`${BOX_LABEL[this.box]} aplicado.`);
    this.refresh();
  }

  private removeScript(): void {
    this.game.removeScript(this.box);
    this.refresh();
  }

  private testScript(): void {
    const mode = this.game.mode;
    if (mode.bench === 'nenhuma') {
      this.setHint('No difícil não há bancada de testes: aplique e observe.', true);
      return;
    }
    if (this.box !== 'classificar' && this.box !== 'rotear') {
      this.showTab('bench');
      this.ui.bench.replaceChildren(el('p', { class: 'empty' }, 'A bancada testa o Classificador e o Roteador. As outras caixas você acompanha pelo Registro.'));
      return;
    }
    if (mode.bench === 'banco' && this.bank) {
      if (this.bank.spend(mode.benchCostMs)) this.startAuto();
      this.setHint(`A bancada custou ${mode.benchCostMs / 1000} s do banco de tempo.`);
      this.renderBank();
    }
    this.showTab('bench');
    const g = this.game;
    const ctx = { features: g.features, mem: g.mem };
    if (this.box === 'rotear') {
      const result = verifyRouter(this.editor.value, g.grid, g.activePorts, g.params.palette, mode.pulseLifetime, ctx);
      if (!result.ok) this.editor.showError(result.message, result.line);
      this.renderRouteBench(result);
      return;
    }
    const cases = g.delivered.slice(-BENCH_SIZE);
    if (cases.length === 0) {
      this.ui.bench.replaceChildren(el('p', { class: 'empty' }, 'Ainda não há pulsos que saíram para testar. Jogue alguns turnos.'));
      return;
    }
    const result = runBench(this.editor.value, cases, g.entered, ctx);
    if (!result.ok) this.editor.showError(result.message, result.line);
    this.renderBench(result);
  }

  // ---- Pesquisa ----

  private buy(id: ResearchId, price: number): void {
    if (!storage.buy(this.mode, id, price)) return;
    this.game.unlock(id);
    this.editor.features = this.game.features;
    this.editor.load(this.box, this.editor.value);
    const item = RESEARCH.find((r) => r.id === id)!;
    this.setHint(`${item.nome} liberado no ${MODES[this.mode].label.toLowerCase()}.`);
    this.refresh();
    this.openDialog('research');
  }

  // ---- Entrada ----

  private onCanvasClick(e: MouseEvent, step: 1 | -1): void {
    if (this.game.over || this.dialog) return;
    const rect = this.ui.canvas.getBoundingClientRect();
    const target = this.renderer.targetAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!target) {
      this.selectedId = null;
      this.refresh();
      return;
    }
    if (target.kind === 'pulse') {
      if (step === -1) return;
      this.selectedId = this.selectedId === target.id ? null : target.id;
      const pulse = this.game.pulses.find((p) => p.id === target.id);
      if (pulse && pulse.col > LAST_RELAY_COL) this.setHint('Este pulso já passou do último relé: o destino não muda mais.', true);
      this.refresh();
    } else if (target.kind === 'relay') {
      this.rotate(target.row, target.col, e.shiftKey ? -1 : step);
    } else if (step === 1) {
      this.assignSelected(target.dest);
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.dialog) {
      // Com a partida encerrada, o fim e a escolha do modo só saem começando outra.
      const closable = this.dialog !== 'over' && !(this.dialog === 'mode' && this.game.over);
      if (e.key === 'Escape' && closable) {
        e.preventDefault();
        this.closeDialog();
      }
      return;
    }
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onControl = target instanceof HTMLButtonElement;
    const key = e.key.toLowerCase();

    if ((e.key === ' ' || e.key === 'Enter') && !onControl) {
      e.preventDefault();
      this.endTurn();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.openDialog('pause');
    } else if (e.key === 'Tab' && (target === document.body || target === this.ui.canvas)) {
      e.preventDefault();
      this.cycleSelection(e.shiftKey ? -1 : 1);
    } else if (/^[0-9]$/.test(e.key) || key === 't') {
      const slot = outputSlots(this.game.grid).find((s) => s.key.toLowerCase() === key);
      if (slot) this.assignSelected(slot.dest);
    } else if (key === 's') {
      this.holdSelected();
    } else if (key === 'h') {
      this.openDialog('help');
    } else if (key === 'p') {
      this.openDialog('research');
    } else if (key === 'e') {
      e.preventDefault();
      this.editor.focus();
    }
  }

  private showTab(tab: Tab): void {
    for (const t of ['signals', 'log', 'bench', 'ref'] as const) {
      byId(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
      byId(`panel-${t}`).hidden = t !== tab;
    }
  }

  private setGrouping(k: number | null): void {
    this.timeline.groupBy = k;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-group]')) {
      const value = button.dataset.group ? Number(button.dataset.group) : null;
      button.setAttribute('aria-pressed', String(value === k));
    }
    this.renderTimeline();
  }

  private setRows(rows: RowKey): void {
    this.timeline.rowKey = rows;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-rows]')) {
      button.setAttribute('aria-pressed', String(button.dataset.rows === rows));
    }
    this.renderTimeline();
  }

  // ---- Diálogos ----

  private openDialog(kind: Exclude<Dialog, null>, note: PauseNote | null = null, over?: { isRecord: boolean; pp: number }): void {
    this.dialog = kind;
    const d = this.ui.dialog;
    const close = () => this.closeDialog();
    let content;
    switch (kind) {
      case 'help':
        content = helpContent(close);
        break;
      case 'pause':
        content = pauseContent(note, this.bank !== null, close);
        break;
      case 'mode': {
        const info = Object.fromEntries(MODE_IDS.map((m) => [m, { record: storage.record(m), points: storage.points(m) }]));
        content = modeContent(this.mode, this.inProgress(), info as never, (mode) => {
          this.abandonCurrent();
          this.startNewGame(mode);
        }, this.game.over ? null : close);
        break;
      }
      case 'research':
        content = researchContent(this.mode, storage.points(this.mode), this.game.unlocked, (id, price) => this.buy(id, price), close);
        break;
      case 'history':
        content = historyContent(this.mode, storage.history(this.mode), close);
        break;
      case 'over': {
        const s = this.game.summary();
        const installed = BOX_IDS.filter((b) => this.game.scripts[b]);
        content = overContent(
          this.mode,
          {
            score: s.score,
            turns: s.turns,
            precision: s.precision,
            acertos: s.totals.acertos,
            maxLevel: s.maxLevel,
            regimes: s.regimes,
            pp: over?.pp ?? 0,
            efficiencyPoints: s.efficiencyPoints,
            predictions: s.predictions,
          },
          over?.isRecord ?? false,
          storage.record(this.mode),
          installed,
          (carry) => this.carryBaggage(carry),
        );
        break;
      }
    }
    d.replaceChildren(...content.filter((n): n is Node | string => n !== null && n !== false));
    this.ui.overlay.hidden = false;
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }

  private closeDialog(): void {
    if (this.dialog === 'help') storage.markHelpSeen();
    this.dialog = null;
    this.ui.overlay.hidden = true;
    this.lastTick = performance.now();
    (document.activeElement as HTMLElement | null)?.blur();
  }

  // ---- Renderização ----

  private setHint(text: string, isError = false): void {
    this.ui.hint.textContent = text || DEFAULT_HINT;
    this.ui.hint.classList.toggle('error', isError);
  }

  private refresh(): void {
    const g = this.game;
    this.ui.mode.textContent = g.mode.label;
    this.ui.regime.hidden = this.regimeIconTurns === 0;
    this.ui.pp.textContent = `${storage.points(this.mode)} PP`;
    this.ui.turn.textContent = String(g.turn);
    this.ui.wave.textContent = String(g.wave);
    this.ui.waveFill.style.width = `${(g.turnInWave / g.mode.waveLength) * 100}%`;
    this.ui.waveFill.parentElement!.title = `Turno ${g.turnInWave} de ${g.mode.waveLength} da onda`;
    this.ui.level.textContent = `${g.level} ×${g.multiplier.toFixed(2)}`;
    this.ui.score.textContent = String(g.score);
    this.ui.record.textContent = String(storage.record(this.mode));

    if (g.score > this.shown.score) restartAnimation(this.ui.score, 'bump');
    if (g.integrity < this.shown.integrity) restartAnimation(this.ui.integrity, 'hit');
    this.shown = { score: g.score, integrity: g.integrity };

    this.ui.integrity.replaceChildren(
      ...Array.from({ length: MAX_INTEGRITY }, (_, i) => el('i', { class: i < g.integrity ? '' : 'lost' })),
    );
    this.ui.integrity.classList.toggle('low', g.integrity <= 3);
    this.ui.integrity.setAttribute('aria-label', `${g.integrity} de ${MAX_INTEGRITY}`);

    this.ui.queue.replaceChildren(
      ...g.queue.map((q, i) => {
        const dot = el('span', { class: q.velado ? 'dot veiled' : 'dot' });
        if (!q.velado) dot.style.background = PULSE_FILL[q.cor];
        const inTurns = q.turn - g.turn;
        const guess = i === 0 && q.previsto ? el('span', { class: 'dot guess', title: `Previsor aposta em ${COLOR_LABEL[q.previsto]}` }) : null;
        if (guess && q.previsto) guess.style.borderColor = PULSE_FILL[q.previsto];
        return el('li', { title: q.velado ? 'velado' : COLOR_LABEL[q.cor] },
          dot,
          `#${q.seq} P${q.porta}`,
          guess,
          el('span', { class: 'when' }, inTurns <= 0 ? 'agora' : `+${inTurns}`),
        );
      }),
    );
    const p = g.params;
    this.ui.boardStats.textContent =
      `${g.pulses.length} na grade · portas ${p.ports} · cores ${p.palette.length} · ${g.grid.broken.size} fios rompidos`;

    const auto = this.bank?.auto ?? false;
    this.ui.actions.replaceChildren(
      ...Array.from({ length: g.mode.actionsPerTurn }, (_, i) => el('i', { class: i < g.actionsLeft && !auto ? '' : 'used' })),
    );
    // A energia do Roteador é gasta no passo do mundo: o medidor mostra o último turno inteiro.
    const used = g.lastTurnEnergy;
    this.ui.energyFill.style.width = `${Math.min(100, (used / g.mode.energyPerTurn) * 100)}%`;
    this.ui.energyValue.textContent = `${used}/${g.mode.energyPerTurn}`;
    this.ui.energyMeter.title = `Energia gasta no último turno. Neste turno: ${g.energyUsed} (caixas instaladas e mem incluídos).`;
    this.ui.energyMeter.classList.toggle('hot', used >= g.mode.energyPerTurn * 0.9);
    this.ui.hold.disabled = this.selectedId === null || g.actionsLeft <= 0 || auto;
    this.ui.end.disabled = auto;
    this.ui.autoBadge.hidden = !auto;
    this.ui.test.disabled = g.mode.bench === 'nenhuma';
    this.ui.test.title = g.mode.bench === 'nenhuma' ? 'Não há bancada no difícil' : g.mode.bench === 'banco' ? `Ctrl+Shift+Enter · custa ${g.mode.benchCostMs / 1000} s do banco` : 'Ctrl+Shift+Enter';
    this.ui.apply.title = g.mode.applyEndsTurn ? 'Ctrl+Enter · no difícil, aplicar custa o turno' : 'Ctrl+Enter';

    this.renderBank();
    this.renderBoxTabs();
    this.renderTimeline();
    this.renderLog();
    this.renderer.requestDraw();
    this.persistSoon();
  }

  private renderBank(): void {
    const bank = this.bank;
    this.ui.bank.hidden = !bank;
    if (!bank) return;
    const seconds = Math.ceil(bank.remainingMs / 1000);
    this.ui.bankValue.textContent = `${seconds} s`;
    this.ui.bankFill.style.width = `${bank.fraction * 100}%`;
    this.ui.bank.classList.toggle('low', bank.fraction < 0.25);
  }

  private renderBoxTabs(): void {
    for (const box of BOX_IDS) {
      const tab = byId(`box-${box}`);
      const available = this.game.isBoxAvailable(box);
      tab.classList.toggle('locked', !available);
      tab.setAttribute('aria-selected', String(box === this.box));
      tab.title = available ? BOX_HELP[box] : 'Liberado na Pesquisa';
    }
    this.renderScriptStatus();
    const info = BOX_INFO[this.box];
    this.ui.signature.replaceChildren(el('b', {}, info.signature), ` — ${BOX_HELP[this.box]}`);
  }

  private renderTimeline(): void {
    const g = this.game;
    this.timeline.render(timelineItems(g), g.mode.regimeNotice === 'explicito' ? g.regimeBoundaries : [], g.activePorts);
  }

  private renderScriptStatus(): void {
    for (const box of BOX_IDS) {
      const status = byId(`status-${box}`);
      if (!this.game.isBoxAvailable(box)) {
        status.className = 'status';
        status.textContent = '🔒';
        continue;
      }
      const script = this.game.scripts[box];
      const draft = box === this.box ? this.editor?.value : this.drafts?.[box];
      if (!script) {
        status.className = 'status';
        status.textContent = '';
      } else if (draft !== undefined && script.source !== draft) {
        status.className = 'status dirty';
        status.textContent = `v${script.version}*`;
      } else {
        status.className = 'status live';
        status.textContent = `v${script.version}`;
      }
    }
  }

  private renderLog(): void {
    const entries = this.game.log.slice(-this.game.mode.logSize).reverse();
    if (entries.length === 0) {
      this.ui.log.replaceChildren(el('li', { class: 'empty' }, 'Os eventos da partida aparecem aqui.'));
      return;
    }
    this.ui.log.replaceChildren(
      ...entries.map((entry) => el('li', {}, el('span', { class: 't' }, String(entry.turn)), el('span', { class: entry.kind }, entry.text))),
    );
  }

  private renderBench(result: BenchResult): void {
    const bench = this.ui.bench;
    if (!result.ok) {
      bench.replaceChildren(el('p', { class: 'fail' }, `O script não compila (linha ${result.line}): ${result.message}`));
      return;
    }
    const summary = el('p', { class: 'bench-summary' },
      el('strong', { class: result.passed === result.cases.length ? 'pass' : '' }, `${result.passed}/${result.cases.length} corretos`),
      result.manual > 0 ? ` · ${result.manual} MANUAL` : '',
      ' — Classificador contra os últimos pulsos que saíram, com o véu original.',
    );
    const rows = [...result.cases].reverse().map((c) => {
      const cls = c.pass ? 'pass' : c.got?.kind === 'manual' ? 'manual' : 'fail';
      return el('tr', {},
        el('td', {}, `#${c.pulse.seq}`),
        el('td', {}, `P${c.pulse.porta}`),
        el('td', {}, `c${c.pulse.carga} ${c.pulse.forma.slice(0, 3)}`),
        el('td', {}, c.pulse.velado ? `${c.pulse.cor}?` : c.pulse.cor),
        el('td', {}, formatDecision(c.expected)),
        el('td', { class: cls, title: c.error ?? '' }, c.error ? `erro: ${c.error}` : formatDecision(c.got)),
      );
    });
    bench.replaceChildren(
      summary,
      el('table', {},
        el('thead', {}, el('tr', {}, ...['seq', 'porta', 'carga/forma', 'cor', 'esperado', 'obtido'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...rows),
      ),
    );
  }

  private renderRouteBench(result: RouteBenchResult): void {
    const bench = this.ui.bench;
    if (!result.ok) {
      bench.replaceChildren(el('p', { class: 'fail' }, `O script não compila (linha ${result.line}): ${result.message}`));
      return;
    }
    const failures = result.checks.filter((c) => !c.ok);
    const summary = el('p', { class: 'bench-summary' },
      el('strong', { class: failures.length === 0 ? 'pass' : '' }, `${result.passed}/${result.checks.length} rotas chegam`),
      ' — Roteador na grade atual, um pulso por vez, de cada porta ativa a cada saída ativa.',
    );
    const label = (d: Destination) => (d.kind === 'terra' ? 'TERRA' : d.cor);
    const rows = (failures.length ? failures : result.checks.slice(0, 12)).map((c) =>
      el('tr', {},
        el('td', {}, `P${c.porta}`),
        el('td', {}, label(c.target)),
        el('td', { class: c.ok ? 'pass' : 'fail' }, c.ok ? `chegou em ${c.steps} passos` : c.reason ?? ''),
      ),
    );
    bench.replaceChildren(
      summary,
      failures.length ? el('p', { class: 'muted small' }, 'Rotas que falharam:') : el('p', { class: 'muted small' }, 'Todas chegaram. Algumas delas:'),
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'porta'), el('th', {}, 'destino'), el('th', {}, 'resultado'))),
        el('tbody', {}, ...rows),
      ),
    );
  }
}

/** Reinicia uma animação CSS mesmo que a classe já esteja aplicada. */
function restartAnimation(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}
