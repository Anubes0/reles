import { COLOR_LABEL, type Color } from '../core/colors';
import { COLS, DECISION_COL, destRow, isAssignable, PORTS, portRow, ROWS } from '../game/board';
import type { Game } from '../game/engine';
import { levelParams } from '../game/mode';
import type { Destination, Pulse, TurnEvent } from '../game/types';
import { BOARD, FONT_MONO, PULSE_FILL } from './theme';

/** Saídas na ordem das linhas: a tecla 1–5 corresponde à linha 0–4. */
export const OUTPUTS: { row: number; dest: Destination }[] = (
  [
    { kind: 'saida', cor: 'RED' },
    { kind: 'saida', cor: 'GREEN' },
    { kind: 'terra' },
    { kind: 'saida', cor: 'BLUE' },
    { kind: 'saida', cor: 'YELLOW' },
  ] as Destination[]
)
  .map((dest) => ({ row: destRow(dest), dest }))
  .sort((a, b) => a.row - b.row);

const MARGIN = { left: 70, right: 150, top: 30, bottom: 16 };
const MAX_CELL = 92;
const MIN_CELL = 40;
const TWEEN_MS = 240;
const FLASH_MS = 750;
const FLOAT_MS = 1000;
const BANNER_MS = 1900;

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
  row: number;
  text: string;
  color: string;
  start: number;
  offset: number;
}

interface Banner {
  title: string;
  subtitle: string;
  color: string;
  start: number;
}

/** Posições de antes do turno, para animar a transição. */
type Snapshot = Map<number, Pulse>;

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
  private banner: Banner | null = null;
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

  /** Efeitos do turno: saídas piscam, pontos sobem, mudança de regime ganha uma faixa. */
  playEvents(events: TurnEvent[]): void {
    const at = performance.now() + (reducedMotion() ? 0 : TWEEN_MS * 0.7);
    const perRow = new Map<number, number>();
    for (const e of events) {
      if (e.kind === 'entrega') {
        const row = destRow(e.dest);
        const color = e.outcome === 'acerto' ? BOARD.good : e.outcome === 'erro' ? BOARD.bad : BOARD.textMuted;
        this.flashes.push({ row, color, start: at });
        const text =
          e.integrity < 0 ? `${e.integrity} integridade` : e.points > 0 ? `+${e.points}` : 'perdido';
        const offset = perRow.get(row) ?? 0;
        perRow.set(row, offset + 1);
        this.floaters.push({ row, text, color, start: at, offset });
      } else if (e.kind === 'regime') {
        this.banner = { title: 'MUDANÇA DE REGIME', subtitle: 'a regra oculta mudou', color: BOARD.regime, start: at };
      } else if (e.kind === 'nivel' && !this.banner) {
        const up = e.to > e.from;
        this.banner = {
          title: `NÍVEL ${e.to}`,
          subtitle: up ? 'o diretor aumentou a dificuldade' : 'o diretor aliviou a dificuldade',
          color: BOARD.accent,
          start: at,
        };
      }
    }
    this.requestDraw();
  }

  clearEffects(): void {
    this.flashes = [];
    this.floaters = [];
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

  pulseAt(x: number, y: number): number | null {
    let best: { id: number; d: number } | null = null;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= h.r + 8 && (!best || d < best.d)) best = { id: h.id, d };
    }
    return best?.id ?? null;
  }

  outputAt(x: number, y: number): Destination | null {
    const box = this.outputBoxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    return box?.dest ?? null;
  }

  private resize(): void {
    const availW = this.wrap.clientWidth;
    // Em telas largas o canvas é posicionado sobre a área e cabe na altura dela; nas estreitas,
    // a altura acompanha a largura (ler a altura da área aí criaria um ciclo com o próprio canvas).
    const fillsArea = getComputedStyle(this.canvas).position === 'absolute';
    const availH = fillsArea ? this.wrap.clientHeight : Infinity;
    const byWidth = (availW - MARGIN.left - MARGIN.right) / COLS;
    const byHeight = (availH - MARGIN.top - MARGIN.bottom) / ROWS;
    this.cell = Math.max(MIN_CELL, Math.min(MAX_CELL, byWidth, byHeight));
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
    return MARGIN.left + COLS * this.cell + 12;
  }

  private draw(): void {
    const { game, selectedId } = this.getState();
    const ctx = this.ctx;
    const now = performance.now();
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawBackground();
    this.drawTraces();
    this.drawPorts();
    this.drawLitRoutes(game, selectedId);
    this.drawOutputs(levelParams(game.level).palette, now);

    let progress = 1;
    if (this.tween) {
      progress = Math.min(1, (now - this.tween.start) / TWEEN_MS);
      if (progress >= 1) this.tween = null;
    }
    this.drawPulses(game, selectedId, 1 - Math.pow(1 - progress, 3));
    this.drawFloaters(now);
    this.drawBanner(now);

    if (this.tween || this.flashes.length || this.floaters.length || this.banner) this.requestDraw();
  }

  // ---- Placa ----

  private drawBackground(): void {
    const ctx = this.ctx;
    const x0 = MARGIN.left;
    const y0 = MARGIN.top;
    const w = this.cell * COLS;
    const h = this.cell * ROWS;

    // Coluna de decisão.
    const band = this.center(0, DECISION_COL).x - this.cell / 2;
    ctx.fillStyle = BOARD.decisionBand;
    ctx.fillRect(band, y0, this.cell, h);
    ctx.strokeStyle = BOARD.decisionEdge;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.strokeRect(band + 0.5, y0 + 0.5, this.cell - 1, h - 1);
    ctx.setLineDash([]);

    // Grade de pontos, como furos de uma placa.
    ctx.fillStyle = BOARD.gridDot;
    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c <= COLS; c++) {
        ctx.beginPath();
        ctx.arc(x0 + c * this.cell, y0 + r * this.cell, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.font = `600 10px ${FONT_MONO}`;
    ctx.fillStyle = BOARD.textMuted;
    ctx.textAlign = 'center';
    ctx.fillText('DECISÃO', band + this.cell / 2, y0 - 11);
    ctx.textAlign = 'left';
    ctx.fillText('ENTRADA', 8, y0 - 11);
    ctx.textAlign = 'right';
    ctx.fillText('SAÍDA', x0 + w + MARGIN.right - 8, y0 - 11);
  }

  private drawTraces(): void {
    const ctx = this.ctx;
    const bus = this.center(0, DECISION_COL).x;
    ctx.strokeStyle = BOARD.trace;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const porta of PORTS) {
      const y = this.center(portRow(porta), 0).y;
      ctx.moveTo(MARGIN.left - 8, y);
      ctx.lineTo(bus, y);
    }
    ctx.moveTo(bus, this.center(0, 0).y);
    ctx.lineTo(bus, this.center(ROWS - 1, 0).y);
    for (const out of OUTPUTS) {
      const y = this.center(out.row, 0).y;
      ctx.moveTo(bus, y);
      ctx.lineTo(this.exitX, y);
    }
    ctx.stroke();

    // Pads onde as trilhas se cruzam com o barramento.
    for (let r = 0; r < ROWS; r++) {
      const { y } = this.center(r, 0);
      ctx.beginPath();
      ctx.arc(bus, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = BOARD.pad;
      ctx.fill();
      ctx.strokeStyle = BOARD.trace;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  private drawPorts(): void {
    const ctx = this.ctx;
    const h = Math.min(34, this.cell * 0.5);
    const w = MARGIN.left - 24;
    for (const porta of PORTS) {
      const { y } = this.center(portRow(porta), 0);
      roundRect(ctx, 8, y - h / 2, w, h, 6);
      ctx.fillStyle = BOARD.panel;
      ctx.fill();
      ctx.strokeStyle = BOARD.trace;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Pinos do conector.
      ctx.fillStyle = BOARD.pin;
      ctx.fillRect(8 + w, y - 5, 6, 3);
      ctx.fillRect(8 + w, y + 2, 6, 3);
      ctx.fillStyle = BOARD.text;
      ctx.font = `700 12px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(`P${porta}`, 8 + w / 2, y + 4);
    }
  }

  /** Cada pulso com destino acende a trilha que vai percorrer. */
  private drawLitRoutes(game: Game, selectedId: number | null): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pulse of game.pulses) {
      if (!pulse.dest) continue;
      const selected = pulse.id === selectedId;
      const color = destColor(pulse.dest);
      ctx.strokeStyle = color;
      ctx.globalAlpha = selected ? 0.95 : 0.3;
      ctx.lineWidth = selected ? 3 : 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = selected ? 10 : 4;
      ctx.setLineDash(selected ? [7, 5] : []);
      ctx.beginPath();
      this.routePoints(pulse).forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.restore();
  }

  private routePoints(pulse: Pulse): Point[] {
    const target = destRow(pulse.dest!);
    const points: Point[] = [this.center(pulse.row, pulse.col)];
    if (pulse.col <= DECISION_COL) {
      points.push(this.center(pulse.row, DECISION_COL), this.center(target, DECISION_COL));
    }
    points.push({ x: this.exitX, y: this.center(target, 0).y });
    return points;
  }

  private drawOutputs(palette: readonly Color[], now: number): void {
    const ctx = this.ctx;
    const x = this.exitX;
    const w = MARGIN.right - 20;
    const h = Math.min(44, this.cell * 0.6);
    this.outputBoxes = [];
    this.flashes = this.flashes.filter((f) => now - f.start < FLASH_MS);

    OUTPUTS.forEach((out, i) => {
      const { y } = this.center(out.row, 0);
      const active = out.dest.kind === 'terra' || palette.includes(out.dest.cor);
      const accent = destColor(out.dest);
      const top = y - h / 2;

      // Brilho da entrega.
      for (const f of this.flashes) {
        if (f.row !== out.row || now < f.start) continue;
        const t = (now - f.start) / FLASH_MS;
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 24;
        ctx.strokeStyle = f.color;
        ctx.lineWidth = 3;
        roundRect(ctx, x - 3 - t * 4, top - 3 - t * 4, w + 6 + t * 8, h + 6 + t * 8, 10);
        ctx.stroke();
        ctx.restore();
      }

      roundRect(ctx, x, top, w, h, 8);
      ctx.fillStyle = BOARD.panel;
      ctx.fill();
      ctx.strokeStyle = active ? accent : BOARD.inactive;
      ctx.globalAlpha = active ? 0.9 : 1;
      ctx.lineWidth = active ? 1.5 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Tecla de atalho.
      roundRect(ctx, x + 8, y - 9, 18, 18, 4);
      ctx.strokeStyle = BOARD.inactive;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = BOARD.textMuted;
      ctx.font = `600 11px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x + 17, y + 4);

      // LED ou símbolo de terra.
      const ledX = x + 40;
      if (out.dest.kind === 'terra') {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ledX, y - 7);
        ctx.lineTo(ledX, y - 1);
        ctx.moveTo(ledX - 7, y - 1);
        ctx.lineTo(ledX + 7, y - 1);
        ctx.moveTo(ledX - 4.5, y + 3);
        ctx.lineTo(ledX + 4.5, y + 3);
        ctx.moveTo(ledX - 2, y + 7);
        ctx.lineTo(ledX + 2, y + 7);
        ctx.stroke();
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.arc(ledX, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = active ? accent : BOARD.inactive;
        if (active) {
          ctx.shadowColor = accent;
          ctx.shadowBlur = 10;
        }
        ctx.fill();
        ctx.restore();
      }

      ctx.textAlign = 'left';
      ctx.font = `700 12px ${FONT_MONO}`;
      ctx.fillStyle = active ? BOARD.text : BOARD.inactive;
      ctx.fillText(out.dest.kind === 'terra' ? 'TERRA' : out.dest.cor, x + 54, active ? y + 4 : y);
      if (!active) {
        ctx.font = `10px ${FONT_MONO}`;
        ctx.fillText('inativa', x + 54, y + 12);
      }

      this.outputBoxes.push({ dest: out.dest, row: out.row, x, y: top, w, h });
    });
  }

  // ---- Pulsos ----

  private drawPulses(game: Game, selectedId: number | null, t: number): void {
    const ctx = this.ctx;
    const r = Math.max(11, this.cell * 0.23);
    this.hits = [];

    // Pulsos que acabaram de sair deslizam até a saída e somem.
    if (this.tween && t < 1) {
      for (const [id, before] of this.tween.from) {
        if (game.pulses.some((p) => p.id === id)) continue;
        const from = this.center(before.row, before.col);
        const to = { x: this.exitX + 10, y: from.y };
        ctx.globalAlpha = 1 - t;
        this.drawPulse(before, lerp(from, to, t), r, false);
        ctx.globalAlpha = 1;
      }
    }

    // Pulsos na mesma casa ficam lado a lado.
    const perCell = new Map<string, number>();
    for (const pulse of game.pulses) {
      const key = `${pulse.row}:${pulse.col}`;
      const slot = perCell.get(key) ?? 0;
      perCell.set(key, slot + 1);

      let pos = this.center(pulse.row, pulse.col);
      const before = this.tween?.from.get(pulse.id);
      if (before && t < 1) pos = lerp(this.center(before.row, before.col), pos, t);
      else if (!before && this.tween && t < 1) ctx.globalAlpha = t;
      pos = { x: pos.x + slot * r * 0.9, y: pos.y - slot * r * 0.5 };

      this.drawPulse(pulse, pos, r, pulse.id === selectedId);
      ctx.globalAlpha = 1;
      this.hits.push({ id: pulse.id, x: pos.x, y: pos.y, r });
    }
  }

  private drawPulse(pulse: Pulse, pos: Point, r: number, selected: boolean): void {
    const ctx = this.ctx;

    if (selected) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 7, 0, Math.PI * 2);
      ctx.strokeStyle = BOARD.selection;
      ctx.shadowColor = BOARD.selection;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    if (pulse.velado) {
      ctx.fillStyle = BOARD.veiledFill;
      ctx.fill();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = BOARD.veiledStroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = BOARD.text;
      ctx.font = `700 ${Math.round(r)}px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText('?', pos.x, pos.y + r * 0.36);
    } else {
      const color = PULSE_FILL[pulse.cor];
      ctx.shadowColor = color;
      ctx.shadowBlur = pulse.cor === 'GRAY' ? 4 : 14;
      const grad = ctx.createRadialGradient(pos.x - r * 0.35, pos.y - r * 0.35, r * 0.1, pos.x, pos.y, r);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.25, color);
      grad.addColorStop(1, color);
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.restore();

    ctx.font = `600 10px ${FONT_MONO}`;
    ctx.fillStyle = BOARD.textMuted;
    ctx.textAlign = 'center';
    ctx.fillText(`#${pulse.seq}`, pos.x, pos.y + r + 13);

    this.drawDestinationBadge(pulse, pos, r);
  }

  /** Selo no canto do pulso: para onde ele vai e quem decidiu. */
  private drawDestinationBadge(pulse: Pulse, pos: Point, r: number): void {
    const ctx = this.ctx;
    const b = { x: pos.x + r * 0.8, y: pos.y - r * 0.8 };
    const br = Math.max(5.5, r * 0.36);
    ctx.beginPath();
    ctx.arc(b.x, b.y, br, 0, Math.PI * 2);

    if (!pulse.dest) {
      const urgent = isAssignable(pulse) && pulse.col === DECISION_COL;
      ctx.fillStyle = urgent ? BOARD.warning : BOARD.panel;
      ctx.fill();
      ctx.strokeStyle = urgent ? BOARD.warning : BOARD.textMuted;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = urgent ? BOARD.background : BOARD.textMuted;
      ctx.font = `800 ${Math.round(br * 1.35)}px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(urgent ? '!' : '·', b.x, b.y + br * 0.48);
      return;
    }

    ctx.fillStyle = destColor(pulse.dest);
    ctx.fill();
    ctx.strokeStyle = pulse.destBy === 'manual' ? BOARD.selection : BOARD.background;
    ctx.lineWidth = pulse.destBy === 'manual' ? 2 : 1.5;
    ctx.stroke();
    if (pulse.dest.kind === 'terra') {
      ctx.fillStyle = BOARD.background;
      ctx.font = `800 ${Math.round(br * 1.2)}px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText('T', b.x, b.y + br * 0.42);
    }
  }

  // ---- Efeitos ----

  private drawFloaters(now: number): void {
    const ctx = this.ctx;
    this.floaters = this.floaters.filter((f) => now - f.start < FLOAT_MS);
    const rise = reducedMotion() ? 0 : 26;
    for (const f of this.floaters) {
      if (now < f.start) continue;
      const t = (now - f.start) / FLOAT_MS;
      const box = this.outputBoxes.find((b) => b.row === f.row);
      if (!box) continue;
      ctx.save();
      ctx.globalAlpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      ctx.font = `700 13px ${FONT_MONO}`;
      // À esquerda da caixa, sobre a trilha: não cobre as saídas vizinhas.
      ctx.textAlign = 'right';
      ctx.fillStyle = f.color;
      ctx.shadowColor = BOARD.background;
      ctx.shadowBlur = 6;
      ctx.fillText(f.text, box.x - 10, box.y + box.h / 2 - 6 - f.offset * 15 - rise * t);
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
    const bandH = 64;
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

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
