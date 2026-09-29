import { COLOR_LABEL } from '../core/colors';
import { isAssignable } from '../game/board';
import { formatDecision, runBench, type BenchResult } from '../game/bench';
import { Game, MAX_INTEGRITY } from '../game/engine';
import { FACIL } from '../game/mode';
import type { Destination } from '../game/types';
import { byId, el } from './dom';
import { CodeEditor } from './editor';
import { BoardRenderer, destLabel, OUTPUTS } from './render';
import { storage } from './storage';
import { PULSE_FILL } from './theme';
import { PatternTimeline, timelineItems } from './timeline';

export const DEFAULT_SCRIPT = `# Classificador: decide o destino de cada pulso que entra.
# Retorne saida(COR), TERRA ou MANUAL (fica por sua conta).
box classificar(p, hist):
    if p.cor == GRAY:
        return TERRA          # ruído vai para o terra
    if p.cor != None:
        return saida(p.cor)
    return MANUAL             # velado: descubra a regra!
`;

const BENCH_SIZE = 20;
const DEFAULT_HINT = 'Clique num pulso (ou Tab) e escolha a saída (clique ou 1–5).';

type Dialog = 'help' | 'pause' | 'over' | 'abandon' | null;
type Tab = 'log' | 'bench' | 'ref';

export class App {
  private game: Game;
  private selectedId: number | null = null;
  private dialog: Dialog = null;
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
    actions: byId('actions'),
    energyFill: byId('energy-fill'),
    energyValue: byId('energy-value'),
    hint: byId('hint'),
    scriptStatus: byId('script-status'),
    bench: byId('bench'),
    log: byId('log'),
    overlay: byId('overlay'),
    dialog: byId('dialog'),
    canvas: byId<HTMLCanvasElement>('board'),
  };

  constructor() {
    this.game = this.newGame();
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
    this.editor.value = storage.script() ?? this.game.script?.source ?? DEFAULT_SCRIPT;

    byId('btn-end').addEventListener('click', () => this.endTurn());
    byId('btn-apply').addEventListener('click', () => this.applyScript());
    byId('btn-test').addEventListener('click', () => this.testScript());
    byId('btn-remove').addEventListener('click', () => this.removeScript());
    byId('btn-new').addEventListener('click', () => this.requestNewGame());
    byId('btn-help').addEventListener('click', () => this.openDialog('help'));
    for (const tab of ['log', 'bench', 'ref'] as const) {
      byId(`tab-${tab}`).addEventListener('click', () => this.showTab(tab));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
      button.addEventListener('click', () => this.setGrouping(button.dataset.group ? Number(button.dataset.group) : null));
    }
    this.ui.canvas.addEventListener('click', (e) => this.onCanvasClick(e));
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
    this.setHint(this.game.script ? 'Nova partida: seu Classificador veio na bagagem.' : 'Nova partida.');
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
    if (!selected || !isAssignable(selected)) this.selectedId = null;
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
    storage.saveBaggage(this.game.mode.id, this.game.script?.source ?? null);
    this.openDialog('over', isRecord);
  }

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
    this.refresh();
  }

  /** Seleciona o próximo pulso que ainda aceita destino, do mais urgente ao menos urgente. */
  private cycleSelection(step: 1 | -1, skipAssigned = false): void {
    const candidates = this.game.pulses
      .filter(isAssignable)
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

  // ---- Script ----

  private onEditorChange(source: string): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => storage.saveScript(source), 400);
    this.renderScriptStatus();
  }

  private applyScript(): void {
    const result = this.game.installScript(this.editor.value);
    if (!result.ok) {
      this.editor.showError(result.error.message, result.error.line, result.error.col);
      this.setHint('O script tem erro e não foi aplicado.', true);
      return;
    }
    storage.saveBaggage(this.game.mode.id, this.editor.value);
    this.setHint('Classificador aplicado: vale a partir do próximo pulso que entrar.');
    this.refresh();
  }

  private removeScript(): void {
    this.game.removeScript();
    storage.saveBaggage(this.game.mode.id, null);
    this.refresh();
  }

  private testScript(): void {
    this.showTab('bench');
    const cases = this.game.delivered.slice(-BENCH_SIZE);
    if (cases.length === 0) {
      this.renderBench(null);
      return;
    }
    const result = runBench(this.editor.value, cases);
    if (!result.ok) this.editor.showError(result.message, result.line);
    this.renderBench(result);
  }

  // ---- Entrada ----

  private onCanvasClick(e: MouseEvent): void {
    if (this.game.over) return;
    const rect = this.ui.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pulseId = this.renderer.pulseAt(x, y);
    if (pulseId !== null) {
      this.selectedId = this.selectedId === pulseId ? null : pulseId;
      const pulse = this.game.pulses.find((p) => p.id === pulseId);
      if (pulse && !isAssignable(pulse)) this.setHint('Este pulso já passou da coluna de decisão.', true);
      this.refresh();
      return;
    }
    const dest = this.renderer.outputAt(x, y);
    if (dest) {
      this.assignSelected(dest);
      return;
    }
    this.selectedId = null;
    this.refresh();
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

    if ((e.key === ' ' || e.key === 'Enter') && !onControl) {
      e.preventDefault();
      this.endTurn();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.openDialog('pause');
    } else if (e.key === 'Tab' && (target === document.body || target === this.ui.canvas)) {
      e.preventDefault();
      this.cycleSelection(e.shiftKey ? -1 : 1);
    } else if (/^[1-5]$/.test(e.key)) {
      const out = OUTPUTS[Number(e.key) - 1];
      if (out) this.assignSelected(out.dest);
    } else if (e.key === 'h' || e.key === 'H') {
      this.openDialog('help');
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      this.editor.focus();
    }
  }

  private showTab(tab: Tab): void {
    for (const t of ['log', 'bench', 'ref'] as const) {
      byId(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
      byId(`panel-${t}`).hidden = t !== tab;
    }
  }

  private setGrouping(k: number | null): void {
    this.timeline.groupBy = k;
    for (const button of document.querySelectorAll<HTMLButtonElement>('.seg button')) {
      const value = button.dataset.group ? Number(button.dataset.group) : null;
      button.setAttribute('aria-pressed', String(value === k));
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
        this.game.script ? el('p', { class: 'muted' }, 'Seu Classificador segue na bagagem para a próxima partida.') : null,
        el('div', { class: 'actions' }, button('Nova partida', () => this.startNewGame(), 'primary', true)),
      ].filter((n) => n !== null);
    }

    const key = (keys: string, what: string) => [el('dt', {}, ...keys.split('+').flatMap((k, i) => (i ? ['+', el('kbd', {}, k)] : [el('kbd', {}, k)]))), el('dd', {}, what)];
    return [
      el('h2', {}, 'Relé — como jogar'),
      el('ul', {},
        el('li', {}, 'Pulsos entram pelas portas P1–P3 e andam uma casa por turno. Cada um deve chegar à saída da sua cor; ruído (cinza) vai para o TERRA.'),
        el('li', {}, 'Na coluna de decisão o pulso segue para o destino escolhido. Sem destino, cai no terra e é perdido.'),
        el('li', {}, 'Pulsos velados (?) escondem a cor, mas ela segue uma regra oculta. Use a linha do tempo de Sinais para descobri-la.'),
        el('li', {}, 'Você tem 2 ações por turno para definir destinos à mão. Escreva o Classificador para automatizar o que for previsível.'),
        el('li', {}, 'Saída errada: −1 de integridade. Ruído numa saída: −2. Com a integridade zerada, a partida acaba.'),
        el('li', {}, 'A regra muda de tempos em tempos. No modo fácil, uma faixa avisa.'),
      ),
      el('h3', {}, 'Atalhos'),
      el('dl', { class: 'help-keys' },
        ...key('Espaço', 'encerrar o turno'),
        ...key('Tab', 'selecionar o próximo pulso'),
        ...key('1–5', 'enviar à saída da linha correspondente'),
        ...key('E', 'ir para o editor'),
        ...key('Esc', 'pausar (no editor: sair dele)'),
        ...key('Ctrl+Enter', 'aplicar o script'),
        ...key('Ctrl+Shift+Enter', 'testar na bancada'),
        ...key('Ctrl+Espaço', 'sugestões no editor'),
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
    this.ui.level.textContent = `${g.level} ×${g.multiplier.toFixed(1)}`;
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

    this.ui.actions.replaceChildren(
      ...Array.from({ length: g.mode.actionsPerTurn }, (_, i) => el('i', { class: i < g.actionsLeft ? '' : 'used' })),
    );
    this.ui.energyFill.style.width = `${(g.energyLeft / g.mode.energyPerTurn) * 100}%`;
    this.ui.energyValue.textContent = String(g.energyLeft);

    this.renderScriptStatus();
    this.renderTimeline();
    this.renderLog();
    this.renderer.requestDraw();
  }

  private renderTimeline(): void {
    this.timeline.render(timelineItems(this.game), this.game.mode.announceRegime ? this.game.regimeBoundaries : []);
  }

  private renderScriptStatus(): void {
    const status = this.ui.scriptStatus;
    const script = this.game.script;
    if (!script) {
      status.className = 'status';
      status.textContent = 'nenhum script ativo';
    } else if (script.source !== this.editor?.value) {
      status.className = 'status dirty';
      status.textContent = `v${script.version} ativo · alterações não aplicadas`;
    } else {
      status.className = 'status live';
      status.textContent = `v${script.version} ativo`;
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

  private renderBench(result: BenchResult | null): void {
    const bench = this.ui.bench;
    if (!result) {
      bench.replaceChildren(el('p', { class: 'empty' }, 'Ainda não há pulsos entregues para testar. Jogue alguns turnos.'));
      return;
    }
    if (!result.ok) {
      bench.replaceChildren(el('p', { class: 'fail' }, `O script não compila (linha ${result.line}): ${result.message}`));
      return;
    }
    const summary = el('p', { class: 'bench-summary' },
      el('strong', { class: result.passed === result.cases.length ? 'pass' : '' }, `${result.passed}/${result.cases.length} corretos`),
      result.manual > 0 ? ` · ${result.manual} MANUAL` : '',
      ' — contra os últimos pulsos entregues, com o véu original.',
    );
    const rows = [...result.cases].reverse().map((c) => {
      const cls = c.pass ? 'pass' : c.got?.kind === 'manual' ? 'manual' : 'fail';
      return el('tr', {},
        el('td', {}, `#${c.pulse.seq}`),
        el('td', {}, String(c.pulse.porta)),
        el('td', {}, c.pulse.velado ? `${c.pulse.cor} (velado)` : c.pulse.cor),
        el('td', {}, formatDecision(c.expected)),
        el('td', { class: cls, title: c.error ?? '' }, c.error ? `erro: ${c.error}` : formatDecision(c.got)),
      );
    });
    bench.replaceChildren(
      summary,
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'seq'), el('th', {}, 'porta'), el('th', {}, 'cor'), el('th', {}, 'esperado'), el('th', {}, 'obtido'))),
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
