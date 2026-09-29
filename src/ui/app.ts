import { COLOR_LABEL } from '../core/colors';
import { LAST_RELAY_COL } from '../game/board';
import { formatDecision, runBench, verifyRouter, type BenchResult, type RouteBenchResult } from '../game/bench';
import type { BoxId } from '../game/boxes';
import { BOX_LABEL, Game, MAX_INTEGRITY } from '../game/engine';
import { FACIL } from '../game/mode';
import type { Destination } from '../game/types';
import { byId, el } from './dom';
import { DEFAULT_SCRIPTS } from './defaults';
import { CodeEditor } from './editor';
import { BoardRenderer, destLabel, outputSlots } from './render';
import { storage, type Baggage } from './storage';
import { PULSE_FILL } from './theme';
import { PatternTimeline, timelineItems, type RowKey } from './timeline';


const BOXES: BoxId[] = ['classificar', 'rotear'];
const BENCH_SIZE = 20;
const DEFAULT_HINT = 'Clique num pulso (ou Tab) e escolha a saída (clique ou 1–9, 0, T). Clique num relé para girá-lo.';

type Dialog = 'help' | 'pause' | 'over' | 'abandon' | null;
type Tab = 'signals' | 'log' | 'bench' | 'ref';

export class App {
  private game: Game;
  private selectedId: number | null = null;
  private dialog: Dialog = null;
  private box: BoxId = 'classificar';
  private readonly drafts: Record<BoxId, string>;
  private readonly renderer: BoardRenderer;
  private readonly editor: CodeEditor;
  private readonly timeline: PatternTimeline;
  private saveTimer = 0;
  private shown = { score: 0, integrity: MAX_INTEGRITY };

  private readonly ui = {
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
    energyFill: byId('energy-fill'),
    energyValue: byId('energy-value'),
    hint: byId('hint'),
    bench: byId('bench'),
    log: byId('log'),
    overlay: byId('overlay'),
    dialog: byId('dialog'),
    canvas: byId<HTMLCanvasElement>('board'),
    hold: byId<HTMLButtonElement>('btn-hold'),
  };

  constructor() {
    this.game = this.newGame();
    this.drafts = {
      classificar: storage.script('classificar') ?? this.game.scripts.classificar?.source ?? DEFAULT_SCRIPTS.classificar,
      rotear: storage.script('rotear') ?? this.game.scripts.rotear?.source ?? DEFAULT_SCRIPTS.rotear,
    };
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
    this.editor.load(this.box, this.drafts[this.box]);

    byId('btn-end').addEventListener('click', () => this.endTurn());
    byId('btn-apply').addEventListener('click', () => this.applyScript());
    byId('btn-test').addEventListener('click', () => this.testScript());
    byId('btn-remove').addEventListener('click', () => this.removeScript());
    byId('btn-new').addEventListener('click', () => this.requestNewGame());
    byId('btn-help').addEventListener('click', () => this.openDialog('help'));
    this.ui.hold.addEventListener('click', () => this.holdSelected());
    for (const box of BOXES) byId(`box-${box}`).addEventListener('click', () => this.switchBox(box));
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

    this.setHint('');
    this.refresh();
    if (!storage.helpSeen()) this.openDialog('help');
  }

  // ---- Partida ----

  private newGame(): Game {
    const seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    const game = new Game(seed, FACIL, storage.baggage(FACIL.id));
    this.shown = { score: 0, integrity: game.integrity };
    return game;
  }

  private startNewGame(): void {
    this.game = this.newGame();
    this.selectedId = null;
    this.renderer.clearEffects();
    this.closeDialog();
    const carried = BOXES.filter((b) => this.game.scripts[b]).map((b) => BOX_LABEL[b]);
    this.setHint(carried.length ? `Nova partida: ${carried.join(' e ')} vieram na bagagem.` : 'Nova partida.');
    this.refresh();
  }

  private requestNewGame(): void {
    const inProgress = !this.game.over && (this.game.turn > 1 || this.game.delivered.length > 0);
    if (inProgress) this.openDialog('abandon');
    else this.startNewGame();
  }

  private abandonAndRestart(): void {
    const s = this.game.summary();
    storage.finishMatch(this.game.mode.id, {
      score: s.score,
      turns: s.turns,
      precision: s.precision,
      abandoned: true,
      date: new Date().toISOString(),
    });
    this.startNewGame();
  }

  private endTurn(): void {
    if (this.game.over || this.dialog) return;
    const before = this.renderer.snapshot();
    this.game.endTurn();
    this.renderer.animateFrom(before);
    this.renderer.playEvents(this.game.lastEvents);

    const selected = this.game.pulses.find((p) => p.id === this.selectedId);
    if (!selected) this.selectedId = null;
    this.setHint('');

    this.refresh();
    if (this.game.over) window.setTimeout(() => this.finishGame(), 700);
  }

  private finishGame(): void {
    const s = this.game.summary();
    const isRecord = storage.finishMatch(this.game.mode.id, {
      score: s.score,
      turns: s.turns,
      precision: s.precision,
      abandoned: false,
      date: new Date().toISOString(),
    });
    storage.saveBaggage(this.game.mode.id, this.baggageNow());
    this.openDialog('over', isRecord);
  }

  private baggageNow(): Baggage {
    return Object.fromEntries(BOXES.filter((b) => this.game.scripts[b]).map((b) => [b, this.game.scripts[b]!.source]));
  }

  // ---- Ações manuais ----

  private assignSelected(dest: Destination): void {
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
    if (this.selectedId === null) {
      this.setHint('Selecione um pulso para segurar.', true);
      return;
    }
    const result = this.game.hold(this.selectedId);
    this.setHint(result.ok ? 'Pulso segurado: ele não anda no próximo turno.' : `Não foi possível: ${result.reason}.`, !result.ok);
    this.refresh();
  }

  private rotate(row: number, col: number, step: 1 | -1): void {
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
    if (box === this.box) return;
    this.drafts[this.box] = this.editor.value;
    this.box = box;
    for (const b of BOXES) byId(`box-${b}`).setAttribute('aria-selected', String(b === box));
    this.editor.load(box, this.drafts[box]);
    this.renderScriptStatus();
  }

  private onEditorChange(source: string): void {
    this.drafts[this.box] = source;
    const box = this.box;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => storage.saveScript(box, source), 400);
    this.renderScriptStatus();
  }

  private applyScript(): void {
    const result = this.game.installScript(this.box, this.editor.value);
    if (!result.ok) {
      this.editor.showError(result.error.message, result.error.line, result.error.col);
      this.setHint('O script tem erro e não foi aplicado.', true);
      return;
    }
    storage.saveBaggage(this.game.mode.id, this.baggageNow());
    this.setHint(`${BOX_LABEL[this.box]} aplicado.`);
    this.refresh();
  }

  private removeScript(): void {
    this.game.removeScript(this.box);
    storage.saveBaggage(this.game.mode.id, this.baggageNow());
    this.refresh();
  }

  private testScript(): void {
    this.showTab('bench');
    if (this.box === 'rotear') {
      const g = this.game;
      const result = verifyRouter(this.editor.value, g.grid, g.activePorts, g.params.palette, g.mode.pulseLifetime);
      if (!result.ok) this.editor.showError(result.message, result.line);
      this.renderRouteBench(result);
      return;
    }
    const cases = this.game.delivered.slice(-BENCH_SIZE);
    if (cases.length === 0) {
      this.ui.bench.replaceChildren(el('p', { class: 'empty' }, 'Ainda não há pulsos que saíram para testar. Jogue alguns turnos.'));
      return;
    }
    const result = runBench(this.editor.value, cases, this.game.entered);
    if (!result.ok) this.editor.showError(result.message, result.line);
    this.renderBench(result);
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
      if (e.key === 'Escape' && (this.dialog === 'pause' || this.dialog === 'help' || this.dialog === 'abandon')) {
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

  private openDialog(kind: Exclude<Dialog, null>, isRecord = false): void {
    this.dialog = kind;
    const d = this.ui.dialog;
    d.replaceChildren(...this.dialogContent(kind, isRecord));
    this.ui.overlay.hidden = false;
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }

  private closeDialog(): void {
    if (this.dialog === 'help') storage.markHelpSeen();
    this.dialog = null;
    this.ui.overlay.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur();
  }

  private dialogContent(kind: Exclude<Dialog, null>, isRecord: boolean): Node[] {
    const button = (label: string, onClick: () => void, cls = '', autofocus = false) => {
      const b = el('button', { type: 'button', class: cls }, label);
      if (autofocus) b.setAttribute('data-autofocus', '');
      b.addEventListener('click', onClick);
      return b;
    };

    if (kind === 'pause') {
      return [
        el('div', { class: 'pause-screen' },
          el('h2', {}, 'Pausado'),
          el('p', { class: 'muted' }, 'Pressione Esc para voltar.'),
          el('div', { class: 'actions' }, button('Voltar', () => this.closeDialog(), 'primary', true)),
        ),
      ];
    }

    if (kind === 'abandon') {
      return [
        el('h2', {}, 'Abandonar a partida?'),
        el('p', {}, 'Só existe uma partida por vez. A partida atual será encerrada: os pontos entram no recorde e no histórico se forem maiores que 0, e nada mais vem dela.'),
        el('div', { class: 'actions' },
          button('Continuar jogando', () => this.closeDialog(), 'ghost', true),
          button('Abandonar e começar outra', () => this.abandonAndRestart(), 'primary'),
        ),
      ];
    }

    if (kind === 'over') {
      const s = this.game.summary();
      const precision = s.precision === null ? '—' : `${Math.round(s.precision * 100)}%`;
      const stat = (label: string, value: string) => el('div', {}, el('dt', {}, label), el('dd', {}, value));
      const carried = BOXES.filter((b) => this.game.scripts[b]).map((b) => BOX_LABEL[b]);
      return [
        el('h2', {}, 'Fim de partida'),
        el('p', { class: 'big' }, String(s.score)),
        isRecord
          ? el('p', { class: 'record' }, 'Novo recorde no modo fácil!')
          : el('p', { class: 'muted' }, `Recorde: ${storage.record(this.game.mode.id)}`),
        el('dl', { class: 'summary-grid' },
          stat('Turnos', String(s.turns)),
          stat('Precisão', precision),
          stat('Acertos', String(s.totals.acertos)),
          stat('Nível máx.', String(s.maxLevel)),
        ),
        el('h3', {}, 'As regras desta partida'),
        el('ol', { class: 'regimes' }, ...s.regimes.map((r) => el('li', {}, r))),
        carried.length ? el('p', { class: 'muted' }, `Na bagagem para a próxima partida: ${carried.join(' e ')}.`) : null,
        el('div', { class: 'actions' }, button('Nova partida', () => this.startNewGame(), 'primary', true)),
      ].filter((n) => n !== null);
    }

    const key = (keys: string, what: string) => [el('dt', {}, ...keys.split('+').flatMap((k, i) => (i ? ['+', el('kbd', {}, k)] : [el('kbd', {}, k)]))), el('dd', {}, what)];
    return [
      el('h2', {}, 'Relé — como jogar'),
      el('ul', {},
        el('li', {}, 'Pulsos entram pelas portas à esquerda e andam uma casa por turno. Cada um deve sair pela saída da sua cor, à direita; ruído (cinza) vai para o TERRA.'),
        el('li', {}, 'Nas colunas de relés (◆), o pulso segue a seta do relé. Clique num relé para girá-lo (1 ação); a seta vale para todos que passarem depois.'),
        el('li', {}, 'O Classificador decide o destino de cada pulso; o Roteador decide as setas quando há um pulso no relé. Programe os dois.'),
        el('li', {}, 'Pulsos velados (?) escondem a cor, mas ela segue uma regra oculta que pode usar porta, carga (pontinhos), forma e o pulso anterior. Use a aba Sinais.'),
        el('li', {}, 'Casa com pulso parado forma fila; dois pulsos entrando na mesma casa colidem (−1 de integridade cada). Use ocupado(j, DIR) no Roteador.'),
        el('li', {}, 'Saída errada: −1. Ruído numa saída: −2. Fios rompem e saídas trocam de cor conforme o nível sobe.'),
      ),
      el('h3', {}, 'Atalhos'),
      el('dl', { class: 'help-keys' },
        ...key('Espaço', 'encerrar o turno'),
        ...key('Tab', 'selecionar o próximo pulso'),
        ...key('1–9, 0', 'enviar o pulso selecionado a uma saída de cor (T: terra)'),
        ...key('S', 'segurar o pulso selecionado por 1 turno'),
        ...key('Clique', 'girar um relé (Shift+clique ou botão direito: ao contrário)'),
        ...key('E', 'ir para o editor'),
        ...key('Esc', 'pausar (no editor: sair dele)'),
        ...key('Ctrl+Enter', 'aplicar o script'),
        ...key('Ctrl+Shift+Enter', 'testar na bancada'),
      ),
      el('div', { class: 'actions' }, button('Jogar', () => this.closeDialog(), 'primary', true)),
    ];
  }

  // ---- Renderização ----

  private setHint(text: string, isError = false): void {
    this.ui.hint.textContent = text || DEFAULT_HINT;
    this.ui.hint.classList.toggle('error', isError);
  }

  private refresh(): void {
    const g = this.game;
    this.ui.turn.textContent = String(g.turn);
    this.ui.wave.textContent = String(g.wave);
    this.ui.waveFill.style.width = `${(g.turnInWave / g.mode.waveLength) * 100}%`;
    this.ui.waveFill.parentElement!.title = `Turno ${g.turnInWave} de ${g.mode.waveLength} da onda`;
    this.ui.level.textContent = `${g.level} ×${g.multiplier.toFixed(2)}`;
    this.ui.score.textContent = String(g.score);
    this.ui.record.textContent = String(storage.record(g.mode.id));

    if (g.score > this.shown.score) restartAnimation(this.ui.score, 'bump');
    if (g.integrity < this.shown.integrity) restartAnimation(this.ui.integrity, 'hit');
    this.shown = { score: g.score, integrity: g.integrity };

    this.ui.integrity.replaceChildren(
      ...Array.from({ length: MAX_INTEGRITY }, (_, i) => el('i', { class: i < g.integrity ? '' : 'lost' })),
    );
    this.ui.integrity.classList.toggle('low', g.integrity <= 3);
    this.ui.integrity.setAttribute('aria-label', `${g.integrity} de ${MAX_INTEGRITY}`);

    this.ui.queue.replaceChildren(
      ...g.queue.map((q) => {
        const dot = el('span', { class: q.velado ? 'dot veiled' : 'dot' });
        if (!q.velado) dot.style.background = PULSE_FILL[q.cor];
        const inTurns = q.turn - g.turn;
        return el('li', { title: q.velado ? 'velado' : COLOR_LABEL[q.cor] },
          dot,
          `#${q.seq} P${q.porta}`,
          el('span', { class: 'when' }, inTurns <= 0 ? 'agora' : `+${inTurns}`),
        );
      }),
    );
    const p = g.params;
    this.ui.boardStats.textContent =
      `${g.pulses.length} na grade · portas ${p.ports} · cores ${p.palette.length} · ${g.grid.broken.size} fios rompidos`;

    this.ui.actions.replaceChildren(
      ...Array.from({ length: g.mode.actionsPerTurn }, (_, i) => el('i', { class: i < g.actionsLeft ? '' : 'used' })),
    );
    this.ui.energyFill.style.width = `${(g.energyLeft / g.mode.energyPerTurn) * 100}%`;
    this.ui.energyValue.textContent = String(g.energyLeft);
    this.ui.hold.disabled = this.selectedId === null || g.actionsLeft <= 0;

    this.renderScriptStatus();
    this.renderTimeline();
    this.renderLog();
    this.renderer.requestDraw();
  }

  private renderTimeline(): void {
    const g = this.game;
    this.timeline.render(timelineItems(g), g.mode.announceRegime ? g.regimeBoundaries : [], g.activePorts);
  }

  private renderScriptStatus(): void {
    for (const box of BOXES) {
      const status = byId(`status-${box}`);
      const script = this.game.scripts[box];
      const draft = box === this.box ? this.editor?.value : this.drafts?.[box];
      if (!script) {
        status.className = 'status';
        status.textContent = 'inativo';
      } else if (draft !== undefined && script.source !== draft) {
        status.className = 'status dirty';
        status.textContent = `v${script.version} · não aplicado`;
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
