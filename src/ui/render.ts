import { COLOR_LABEL, type Dir } from '../core/colors';
import { COLS, LAST_RELAY_COL, RELAY_COLS, ROWS, type Grid } from '../game/board';
import type { Game } from '../game/engine';
import type { Destination, Pulse, TurnEvent } from '../game/types';
import { BOARD, FONT_MONO, PULSE_FILL } from './theme';

const MARGIN = { left: 50, right: 128, top: 24, bottom: 10 };
const MAX_CELL = 58;
const MIN_CELL = 20;
const TWEEN_MS = 220;
const FLASH_MS = 750;
const FLOAT_MS = 1000;
const BURST_MS = 650;
const BANNER_MS = 1900;

export interface OutputSlot {
  row: number;
  dest: Destination;
  key: string;
}

/** Saídas de cima para baixo: as de cor usam as teclas 1–9 e 0; o terra usa T. */
export function outputSlots(grid: Grid): OutputSlot[] {
  const slots: OutputSlot[] = [];
  let n = 0;
  for (let row = 0; row < ROWS; row++) {
    const dest = grid.exitAt(row);
    if (!dest) continue;
    const key = dest.kind === 'terra' ? 'T' : String(++n % 10);
    slots.push({ row, dest, key });
  }
  return slots;
}

interface Point {
  x: number;
  y: number;
}

interface Hit {
  id: number;
  x: number;
  y: number;
  r: number;
}

interface OutputBox {
  dest: Destination;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Flash {
  row: number;
  color: string;
  start: number;
}

interface Floater {
  at: Point | { row: number };
  text: string;
  color: string;
  start: number;
  offset: number;
}

interface Burst {
  row: number;
  col: number;
  color: string;
  start: number;
}

interface Banner {
  title: string;
  subtitle: string;
  color: string;
  start: number;
}

/** Posições de antes do turno, para animar a transição. */
type Snapshot = Map<number, Pulse>;

export type BoardTarget = { kind: 'pulse'; id: number } | { kind: 'relay'; row: number; col: number } | { kind: 'output'; dest: Destination };

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly wrap: HTMLElement;
  private cell = MAX_CELL;
  private width = 0;
  private height = 0;
  private hits: Hit[] = [];
  private outputBoxes: OutputBox[] = [];
  private tween: { from: Snapshot; start: number } | null = null;
  private flashes: Flash[] = [];
  private floaters: Floater[] = [];
  private bursts: Burst[] = [];
  private banner: Banner | null = null;
  private hover: BoardTarget | null = null;
  private frame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly getState: () => { game: Game; selectedId: number | null },
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D indisponível');
    this.ctx = ctx;
    this.wrap = canvas.parentElement ?? canvas;
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    canvas.addEventListener('mousemove', (e) => this.onHover(e));
    canvas.addEventListener('mouseleave', () => this.setHover(null));
    this.resize();
  }

  /** Guarda o estado atual antes de encerrar o turno. */
  snapshot(): Snapshot {
    return new Map(this.getState().game.pulses.map((p) => [p.id, { ...p, dest: p.dest && { ...p.dest } }]));
  }

  animateFrom(from: Snapshot): void {
    this.tween = reducedMotion() ? null : { from, start: performance.now() };
    this.requestDraw();
  }

  /** Efeitos do turno: entregas piscam, colisões explodem e mudanças ganham uma faixa. */
  playEvents(events: TurnEvent[]): void {
    const at = performance.now() + (reducedMotion() ? 0 : TWEEN_MS * 0.7);
    const perRow = new Map<number, number>();
    const banners: Banner[] = [];
    const grid = this.getState().game.grid;
    for (const e of events) {
      switch (e.kind) {
        case 'entrega': {
          const row = grid.rowOf(e.dest);
          const color = e.outcome === 'acerto' ? BOARD.good : e.outcome === 'erro' ? BOARD.bad : BOARD.textMuted;
          this.flashes.push({ row, color, start: at });
          const text = e.integrity < 0 ? `${e.integrity}` : e.points > 0 ? `+${e.points}` : 'perdido';
          const offset = perRow.get(row) ?? 0;
          perRow.set(row, offset + 1);
          this.floaters.push({ at: { row }, text, color, start: at, offset });
          break;
        }
        case 'colisao': {
          this.bursts.push({ row: e.row, col: e.col, color: BOARD.bad, start: at });
          this.floaters.push({ at: this.center(e.row, e.col), text: `colisão −${e.count}`, color: BOARD.bad, start: at, offset: 0 });
          break;
        }
        case 'queimado':
          this.bursts.push({ row: e.row, col: e.col, color: BOARD.textMuted, start: at });
          break;
        case 'regime':
          banners.push({ title: 'MUDANÇA DE REGIME', subtitle: 'a regra oculta mudou', color: BOARD.regime, start: at });
          break;
        case 'grade':
          banners.push({
            title: e.broken > 0 ? 'A GRADE MUDOU' : 'GRADE CONSERTADA',
            subtitle: e.broken > 0 ? `${e.broken} fios rompidos` : 'todos os fios inteiros',
            color: BOARD.warning,
            start: at,
          });
          break;
        case 'deriva':
          banners.push({ title: 'SAÍDAS TROCARAM', subtitle: 'confira as cores à direita', color: BOARD.warning, start: at });
          break;
        case 'nivel':
          banners.push({
            title: `NÍVEL ${e.to}`,
            subtitle: e.to > e.from ? 'o diretor aumentou a dificuldade' : 'o diretor aliviou a dificuldade',
            color: BOARD.accent,
            start: at,
          });
          break;
      }
    }
    // Uma faixa por vez: a mais importante.
    if (banners.length > 0) this.banner = banners[0];
    this.requestDraw();
  }

  clearEffects(): void {
    this.flashes = [];
    this.floaters = [];
    this.bursts = [];
    this.banner = null;
    this.tween = null;
  }

  requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** O que está sob o ponteiro: pulso, relé ou saída (nessa prioridade). */
  targetAt(x: number, y: number): BoardTarget | null {
    let best: { id: number; d: number } | null = null;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= h.r + 5 && (!best || d < best.d)) best = { id: h.id, d };
    }
    if (best) return { kind: 'pulse', id: best.id };

    const box = this.outputBoxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (box) return { kind: 'output', dest: box.dest };

    const col = Math.floor((x - MARGIN.left) / this.cell);
    const row = Math.floor((y - MARGIN.top) / this.cell);
    if ((RELAY_COLS as readonly number[]).includes(col) && row >= 0 && row < ROWS) {
      const c = this.center(row, col);
      if (Math.abs(c.x - x) <= this.cell * 0.45 && Math.abs(c.y - y) <= this.cell * 0.45) return { kind: 'relay', row, col };
    }
    return null;
  }

  private onHover(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.setHover(this.targetAt(e.clientX - rect.left, e.clientY - rect.top));
  }

  private setHover(target: BoardTarget | null): void {
    const same = JSON.stringify(target) === JSON.stringify(this.hover);
    this.hover = target;
    this.canvas.style.cursor = target ? 'pointer' : 'default';
    if (!same) this.requestDraw();
  }

  private resize(): void {
    const availW = this.wrap.clientWidth;
    // Em telas largas o canvas é posicionado sobre a área e cabe na altura dela; nas estreitas,
    // a altura acompanha a largura (ler a altura da área aí criaria um ciclo com o próprio canvas).
    const fillsArea = getComputedStyle(this.canvas).position === 'absolute';
    const availH = fillsArea ? this.wrap.clientHeight : Infinity;
    const byWidth = (availW - MARGIN.left - MARGIN.right) / COLS;
    const byHeight = (availH - MARGIN.top - MARGIN.bottom) / ROWS;
    this.cell = Math.floor(Math.max(MIN_CELL, Math.min(MAX_CELL, byWidth, byHeight)));
    this.width = MARGIN.left + this.cell * COLS + MARGIN.right;
    this.height = MARGIN.top + this.cell * ROWS + MARGIN.bottom;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private center(row: number, col: number): Point {
    return { x: MARGIN.left + (col + 0.5) * this.cell, y: MARGIN.top + (row + 0.5) * this.cell };
  }

  private get exitX(): number {
    return MARGIN.left + COLS * this.cell + 8;
  }

  private draw(): void {
    const { game, selectedId } = this.getState();
    const ctx = this.ctx;
    const now = performance.now();
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawBackground();
    this.drawWires(game.grid);
    this.drawPorts(game);
    this.drawOutputs(game, now);
    const selected = game.pulses.find((p) => p.id === selectedId);
    if (selected) this.drawPredictedPath(game.grid, selected);
    this.drawRelays(game.grid);

    let progress = 1;
    if (this.tween) {
      progress = Math.min(1, (now - this.tween.start) / TWEEN_MS);
      if (progress >= 1) this.tween = null;
    }
    this.drawPulses(game, selectedId, 1 - Math.pow(1 - progress, 3));
    this.drawBursts(now);
    this.drawFloaters(now);
    this.drawBanner(now);

    const animating = this.tween || this.flashes.length || this.floaters.length || this.bursts.length || this.banner;
    if (animating) this.requestDraw();
  }

  // ---- Placa ----

  private drawBackground(): void {
    const ctx = this.ctx;
    ctx.fillStyle = BOARD.background;
    ctx.fillRect(0, 0, this.width, this.height);
    // Faixas das colunas de relés.
    for (const col of RELAY_COLS) {
      const x = MARGIN.left + col * this.cell;
      ctx.fillStyle = BOARD.relayBand;
      ctx.fillRect(x, MARGIN.top, this.cell, this.cell * ROWS);
    }
    ctx.font = `600 9.5px ${FONT_MONO}`;
    ctx.fillStyle = BOARD.textMuted;
    ctx.textAlign = 'center';
    RELAY_COLS.forEach((col) => ctx.fillText('RELÉS', this.center(0, col).x, MARGIN.top - 9));
    ctx.textAlign = 'left';
    ctx.fillText('ENTRADAS', 6, MARGIN.top - 9);
    ctx.textAlign = 'right';
    ctx.fillText('SAÍDAS', this.width - 6, MARGIN.top - 9);
  }

  private drawWires(grid: Grid): void {
    const ctx = this.ctx;
    const w = Math.max(1.5, this.cell * 0.07);
    ctx.lineCap = 'round';
    for (let row = 0; row < ROWS; row++) {
      const y = this.center(row, 0).y;
      const hasPort = grid.layout.portRows.includes(row);
      const hasExit = grid.exitAt(row) !== null;
      // Entrada → primeiro relé.
      this.line(hasPort ? MARGIN.left - 6 : this.center(row, 0).x - this.cell / 2, y, this.center(row, RELAY_COLS[0]).x, y, BOARD.trace, w);
      // Entre colunas de relés (pode estar rompido).
      for (let i = 0; i < RELAY_COLS.length - 1; i++) {
        const x1 = this.center(row, RELAY_COLS[i]).x;
        const x2 = this.center(row, RELAY_COLS[i + 1]).x;
        if (grid.isBroken(`h:${row}:${i}`)) this.brokenLine(x1, y, x2, y, w);
        else this.line(x1, y, x2, y, BOARD.trace, w);
      }
      // Último relé → saída (linhas sem saída terminam num tampão).
      const xLast = this.center(row, LAST_RELAY_COL).x;
      if (hasExit) this.line(xLast, y, this.exitX, y, BOARD.trace, w);
      else this.line(xLast, y, xLast + this.cell * 0.9, y, BOARD.traceDead, w);
    }
    for (const [i, col] of RELAY_COLS.entries()) {
      const x = this.center(0, col).x;
      for (let row = 0; row < ROWS - 1; row++) {
        const y1 = this.center(row, col).y;
        const y2 = this.center(row + 1, col).y;
        if (grid.isBroken(`v:${row}:${i}`)) this.brokenLine(x, y1, x, y2, w);
        else this.line(x, y1, x, y2, BOARD.trace, w);
      }
    }
  }

  private line(x1: number, y1: number, x2: number, y2: number, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  private brokenLine(x1: number, y1: number, x2: number, y2: number, width: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([3, 4]);
    this.line(x1, y1, x2, y2, BOARD.brokenTrace, width);
    ctx.restore();
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const s = Math.max(3, this.cell * 0.14);
    ctx.strokeStyle = BOARD.bad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx - s, my - s);
    ctx.lineTo(mx + s, my + s);
    ctx.moveTo(mx + s, my - s);
    ctx.lineTo(mx - s, my + s);
    ctx.stroke();
  }

  private drawRelays(grid: Grid): void {
    const ctx = this.ctx;
    const size = Math.max(8, this.cell * 0.42);
    for (let row = 0; row < ROWS; row++) {
      for (const col of RELAY_COLS) {
        const { x, y } = this.center(row, col);
        const hovered = this.hover?.kind === 'relay' && this.hover.row === row && this.hover.col === col;
        const fixed = grid.validDirs(row, col).length < 2;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.roundRect(-size / 2, -size / 2, size, size, 2);
        ctx.fillStyle = hovered ? BOARD.relayHover : BOARD.relay;
        ctx.fill();
        ctx.strokeStyle = hovered ? BOARD.text : BOARD.relayEdge;
        ctx.lineWidth = hovered ? 1.4 : 1;
        ctx.stroke();
        ctx.restore();
        const d = grid.dir(row, col);
        // Seta para o leste é o normal: fica discreta. Desvios (▲ ▼) aparecem mais.
        const color = hovered ? BOARD.text : fixed ? BOARD.textMuted : d === 'LESTE' ? BOARD.arrowQuiet : BOARD.arrowTurn;
        this.arrow(x, y, d, size * 0.36, color);
      }
    }
  }

  private arrow(x: number, y: number, d: Dir, s: number, color: string): void {
    const ctx = this.ctx;
    const angle = d === 'NORTE' ? -Math.PI / 2 : d === 'SUL' ? Math.PI / 2 : 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(s, 0);
    ctx.lineTo(-s * 0.7, -s * 0.8);
    ctx.lineTo(-s * 0.7, s * 0.8);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  private drawPorts(game: Game): void {
    const ctx = this.ctx;
    const active = game.activePorts;
    const h = Math.min(22, this.cell * 0.72);
    const w = MARGIN.left - 14;
    game.grid.layout.portRows.forEach((row, i) => {
      const porta = i + 1;
      const on = active.includes(porta);
      const { y } = this.center(row, 0);
      ctx.beginPath();
      ctx.roundRect(4, y - h / 2, w, h, 5);
      ctx.fillStyle = BOARD.panel;
      ctx.fill();
      ctx.strokeStyle = on ? BOARD.relayEdge : BOARD.inactive;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = on ? BOARD.pin : BOARD.inactive;
      ctx.fillRect(4 + w, y - 3.5, 5, 2.5);
      ctx.fillRect(4 + w, y + 1, 5, 2.5);
      ctx.fillStyle = on ? BOARD.text : BOARD.inactive;
      ctx.font = `700 ${Math.min(11, Math.max(9, this.cell * 0.34))}px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(`P${porta}`, 4 + w / 2, y + 3.5);
    });
  }

  private drawOutputs(game: Game, now: number): void {
    const ctx = this.ctx;
    const palette = game.params.palette;
    const x = this.exitX;
    const w = MARGIN.right - 14;
    const h = Math.min(26, this.cell * 0.8);
    this.outputBoxes = [];
    this.flashes = this.flashes.filter((f) => now - f.start < FLASH_MS);
    const font = Math.min(11.5, Math.max(9, this.cell * 0.36));

    for (const slot of outputSlots(game.grid)) {
      const { row, dest, key } = slot;
      const { y } = this.center(row, 0);
      const active = dest.kind === 'terra' || palette.includes(dest.cor);
      const accent = destColor(dest);
      const top = y - h / 2;

      for (const f of this.flashes) {
        if (f.row !== row || now < f.start) continue;
        const t = (now - f.start) / FLASH_MS;
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 18;
        ctx.strokeStyle = f.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(x - 2 - t * 3, top - 2 - t * 3, w + 4 + t * 6, h + 4 + t * 6, 8);
        ctx.stroke();
        ctx.restore();
      }

      const hovered = this.hover?.kind === 'output' && sameDest(this.hover.dest, dest);
      ctx.beginPath();
      ctx.roundRect(x, top, w, h, 6);
      ctx.fillStyle = hovered ? BOARD.relayHover : BOARD.panel;
      ctx.fill();
      ctx.strokeStyle = active ? accent : BOARD.inactive;
      ctx.globalAlpha = active ? 0.85 : 1;
      ctx.lineWidth = active ? 1.4 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.font = `600 ${font - 1}px ${FONT_MONO}`;
      ctx.fillStyle = BOARD.textMuted;
      ctx.textAlign = 'center';
      ctx.fillText(key, x + 10, y + font * 0.35);

      const ledX = x + 25;
      if (dest.kind === 'terra') {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(ledX, y - 5);
        ctx.lineTo(ledX, y - 1);
        ctx.moveTo(ledX - 5, y - 1);
        ctx.lineTo(ledX + 5, y - 1);
        ctx.moveTo(ledX - 3, y + 2);
        ctx.lineTo(ledX + 3, y + 2);
        ctx.moveTo(ledX - 1.2, y + 5);
        ctx.lineTo(ledX + 1.2, y + 5);
        ctx.stroke();
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.arc(ledX, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = active ? accent : BOARD.inactive;
        if (active) {
          ctx.shadowColor = accent;
          ctx.shadowBlur = 8;
        }
        ctx.fill();
        ctx.restore();
      }

      ctx.textAlign = 'left';
      ctx.font = `700 ${font}px ${FONT_MONO}`;
      ctx.fillStyle = active ? BOARD.text : BOARD.inactive;
      ctx.fillText(dest.kind === 'terra' ? 'TERRA' : dest.cor, x + 35, y + font * 0.35);

      this.outputBoxes.push({ dest, row, x, y: top, w, h });
    }
  }

  /** Para onde o pulso selecionado vai se os relés ficarem como estão. */
  private drawPredictedPath(grid: Grid, pulse: Pulse): void {
    const ctx = this.ctx;
    const points: Point[] = [this.center(pulse.row, pulse.col)];
    let { row, col } = pulse;
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const d: Dir = grid.isRelay(row, col) ? grid.dir(row, col) : 'LESTE';
      const next = grid.step(row, col, d);
      if (next.col >= COLS) {
        points.push({ x: this.exitX, y: this.center(row, 0).y });
        break;
      }
      const key = `${next.row}:${next.col}:${d}`;
      if (seen.has(key)) break;
      seen.add(key);
      row = next.row;
      col = next.col;
      points.push(this.center(row, col));
    }
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = pulse.dest ? destColor(pulse.dest) : BOARD.selection;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 8;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.restore();
  }

  // ---- Pulsos ----

  private drawPulses(game: Game, selectedId: number | null, t: number): void {
    const ctx = this.ctx;
    const r = Math.max(6, this.cell * 0.3);
    this.hits = [];

    // Pulsos que saíram deslizam até a saída e somem.
    if (this.tween && t < 1) {
      for (const [id, before] of this.tween.from) {
        if (game.pulses.some((p) => p.id === id)) continue;
        const from = this.center(before.row, before.col);
        const to = before.col === COLS - 1 ? { x: this.exitX + 8, y: from.y } : from;
        ctx.globalAlpha = 1 - t;
        this.drawPulse(before, lerp(from, to, t), r, false, false);
        ctx.globalAlpha = 1;
      }
    }

    const showLabels = this.cell >= 44;
    for (const pulse of game.pulses) {
      let pos = this.center(pulse.row, pulse.col);
      const before = this.tween?.from.get(pulse.id);
      if (before && t < 1) pos = lerp(this.center(before.row, before.col), pos, t);
      else if (!before && this.tween && t < 1) ctx.globalAlpha = t;
      const hovered = this.hover?.kind === 'pulse' && this.hover.id === pulse.id;
      this.drawPulse(pulse, pos, r, pulse.id === selectedId, showLabels || hovered || pulse.id === selectedId);
      ctx.globalAlpha = 1;
      this.hits.push({ id: pulse.id, x: pos.x, y: pos.y, r });
    }
  }

  private drawPulse(pulse: Pulse, pos: Point, r: number, selected: boolean, label: boolean): void {
    const ctx = this.ctx;
    const { x, y } = pos;

    if (selected) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = BOARD.selection;
      ctx.shadowColor = BOARD.selection;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    this.shapePath(pulse.forma, x, y, r);
    if (pulse.velado) {
      ctx.fillStyle = BOARD.veiledFill;
      ctx.fill();
      ctx.setLineDash([2.5, 2.5]);
      ctx.strokeStyle = BOARD.veiledStroke;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = BOARD.text;
      ctx.font = `800 ${Math.round(r * 1.05)}px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText('?', x - (pulse.forma === 'TRIANGULO' ? r * 0.12 : 0), y + r * 0.37);
    } else {
      const color = PULSE_FILL[pulse.cor];
      ctx.shadowColor = color;
      ctx.shadowBlur = pulse.cor === 'GRAY' ? 3 : 10;
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();

    if (pulse.held) {
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = BOARD.selection;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Carga: 1 a 3 pontos embaixo do pulso.
    const pip = Math.max(1.3, r * 0.15);
    ctx.fillStyle = BOARD.text;
    for (let i = 0; i < pulse.carga; i++) {
      ctx.beginPath();
      ctx.arc(x + (i - (pulse.carga - 1) / 2) * pip * 3, y + r + pip + 1.5, pip, 0, Math.PI * 2);
      ctx.fill();
    }

    if (pulse.stalled || pulse.held) {
      ctx.fillStyle = BOARD.selection;
      const bw = Math.max(1.5, r * 0.16);
      ctx.fillRect(x - r - bw * 2.6, y - r, bw, r * 0.7);
      ctx.fillRect(x - r - bw * 1.1, y - r, bw, r * 0.7);
    }

    if (label) {
      ctx.font = `600 ${Math.max(9, Math.min(10.5, r * 0.8))}px ${FONT_MONO}`;
      ctx.fillStyle = BOARD.textMuted;
      ctx.textAlign = 'center';
      ctx.fillText(`#${pulse.seq}`, x, y - r - 5);
    }

    this.drawDestinationBadge(pulse, x, y, r);
  }

  private shapePath(forma: Pulse['forma'], x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (forma === 'QUADRADO') {
      const s = r * 1.62;
      ctx.roundRect(x - s / 2, y - s / 2, s, s, r * 0.22);
    } else if (forma === 'TRIANGULO') {
      ctx.moveTo(x + r * 1.05, y);
      ctx.lineTo(x - r * 0.75, y - r * 0.98);
      ctx.lineTo(x - r * 0.75, y + r * 0.98);
      ctx.closePath();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  /** Selo no canto do pulso: para onde ele vai e quem decidiu. */
  private drawDestinationBadge(pulse: Pulse, x: number, y: number, r: number): void {
    const ctx = this.ctx;
    const b = { x: x + r * 0.85, y: y - r * 0.85 };
    const br = Math.max(3.5, r * 0.36);
    ctx.beginPath();
    ctx.arc(b.x, b.y, br, 0, Math.PI * 2);
    if (!pulse.dest) {
      ctx.fillStyle = BOARD.background;
      ctx.fill();
      ctx.strokeStyle = BOARD.textMuted;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      return;
    }
    ctx.fillStyle = destColor(pulse.dest);
    ctx.fill();
    ctx.strokeStyle = pulse.destBy === 'manual' ? BOARD.selection : BOARD.background;
    ctx.lineWidth = pulse.destBy === 'manual' ? 1.8 : 1.2;
    ctx.stroke();
  }

  // ---- Efeitos ----

  private drawBursts(now: number): void {
    const ctx = this.ctx;
    this.bursts = this.bursts.filter((b) => now - b.start < BURST_MS);
    for (const b of this.bursts) {
      if (now < b.start) continue;
      const t = (now - b.start) / BURST_MS;
      const { x, y } = this.center(b.row, b.col);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = b.color;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, this.cell * (0.25 + t * 0.6), 0, Math.PI * 2);
      ctx.stroke();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const r1 = this.cell * (0.2 + t * 0.4);
        const r2 = this.cell * (0.35 + t * 0.7);
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
        ctx.lineTo(x + Math.cos(a) * r2, y + Math.sin(a) * r2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawFloaters(now: number): void {
    const ctx = this.ctx;
    this.floaters = this.floaters.filter((f) => now - f.start < FLOAT_MS);
    const rise = reducedMotion() ? 0 : 22;
    for (const f of this.floaters) {
      if (now < f.start) continue;
      const t = (now - f.start) / FLOAT_MS;
      let x: number;
      let y: number;
      if ('row' in f.at) {
        const box = this.outputBoxes.find((b) => b.row === (f.at as { row: number }).row);
        if (!box) continue;
        x = box.x - 8;
        y = box.y + box.h / 2 + 4;
      } else {
        x = f.at.x;
        y = f.at.y - this.cell * 0.5;
      }
      ctx.save();
      ctx.globalAlpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      ctx.font = `700 12px ${FONT_MONO}`;
      // À esquerda das saídas, sobre a trilha: não cobre as saídas vizinhas.
      ctx.textAlign = 'row' in f.at ? 'right' : 'center';
      ctx.fillStyle = f.color;
      ctx.shadowColor = BOARD.background;
      ctx.shadowBlur = 6;
      ctx.fillText(f.text, x, y - f.offset * 13 - rise * t);
      ctx.restore();
    }
  }

  private drawBanner(now: number): void {
    const b = this.banner;
    if (!b) return;
    const t = (now - b.start) / BANNER_MS;
    if (t >= 1) {
      this.banner = null;
      return;
    }
    if (t < 0) return;
    const ctx = this.ctx;
    const alpha = t < 0.12 ? t / 0.12 : t > 0.75 ? (1 - t) / 0.25 : 1;
    const cy = MARGIN.top + (this.cell * ROWS) / 2;
    const bandH = 62;
    ctx.save();
    ctx.globalAlpha = alpha * 0.92;
    ctx.fillStyle = BOARD.background;
    ctx.fillRect(0, cy - bandH / 2, this.width, bandH);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = b.color;
    ctx.fillRect(0, cy - bandH / 2, this.width, 2);
    ctx.fillRect(0, cy + bandH / 2 - 2, this.width, 2);
    ctx.textAlign = 'center';
    ctx.font = `800 20px ${FONT_MONO}`;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 16;
    ctx.fillText(b.title, this.width / 2, cy + 2);
    ctx.shadowBlur = 0;
    ctx.font = `12px ${FONT_MONO}`;
    ctx.fillStyle = BOARD.text;
    ctx.fillText(b.subtitle, this.width / 2, cy + 20);
    ctx.restore();
  }
}

export function destColor(dest: Destination): string {
  return dest.kind === 'terra' ? PULSE_FILL.GRAY : PULSE_FILL[dest.cor];
}

export function destLabel(dest: Destination): string {
  return dest.kind === 'terra' ? 'terra' : `saída ${COLOR_LABEL[dest.cor]}`;
}

export function sameDest(a: Destination, b: Destination): boolean {
  return a.kind === b.kind && (a.kind === 'terra' || (b.kind === 'saida' && a.cor === b.cor));
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
