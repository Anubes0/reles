import { COLOR_LABEL, type Color } from '../core/colors';
import { COLS, DECISION_COL, destRow, isAssignable, PORTS, portRow, ROWS } from '../game/board';
import type { Game } from '../game/engine';
import { levelParams } from '../game/mode';
import type { Destination, Pulse } from '../game/types';
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

const MARGIN = { left: 64, right: 132, top: 30, bottom: 14 };
const MAX_CELL = 88;
const TWEEN_MS = 220;

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
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Posições de antes do turno, para animar a transição. */
type Snapshot = Map<number, Pulse>;

export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cell = MAX_CELL;
  private width = 0;
  private height = 0;
  private hits: Hit[] = [];
  private outputBoxes: OutputBox[] = [];
  private tween: { from: Snapshot; start: number } | null = null;
  private frame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly getState: () => { game: Game; selectedId: number | null },
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D indisponível');
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  /** Guarda o estado atual antes de encerrar o turno. */
  snapshot(): Snapshot {
    return new Map(this.getState().game.pulses.map((p) => [p.id, { ...p, dest: p.dest && { ...p.dest } }]));
  }

  animateFrom(from: Snapshot): void {
    this.tween = { from, start: performance.now() };
    this.requestDraw();
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
      if (d <= h.r + 6 && (!best || d < best.d)) best = { id: h.id, d };
    }
    return best?.id ?? null;
  }

  outputAt(x: number, y: number): Destination | null {
    const box = this.outputBoxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    return box?.dest ?? null;
  }

  private resize(): void {
    const parentWidth = (this.canvas.parentElement ?? this.canvas).clientWidth;
    this.cell = Math.max(44, Math.min(MAX_CELL, (parentWidth - MARGIN.left - MARGIN.right) / COLS));
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

  private draw(): void {
    const { game, selectedId } = this.getState();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = BOARD.background;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawGrid();
    this.drawWires();
    this.drawPorts();
    this.drawOutputs(levelParams(game.level).palette);

    const selected = game.pulses.find((p) => p.id === selectedId);
    if (selected?.dest) this.drawPlannedPath(selected);

    let progress = 1;
    if (this.tween) {
      progress = Math.min(1, (performance.now() - this.tween.start) / TWEEN_MS);
      if (progress >= 1) this.tween = null;
      else this.requestDraw();
    }
    const eased = 1 - Math.pow(1 - progress, 3);
    this.drawPulses(game, selectedId, eased);
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const band = this.center(0, DECISION_COL);
    ctx.fillStyle = BOARD.decisionBand;
    ctx.fillRect(band.x - this.cell / 2, MARGIN.top, this.cell, this.cell * ROWS);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = MARGIN.left + c * this.cell;
        const y = MARGIN.top + r * this.cell;
        ctx.fillStyle = BOARD.cell;
        ctx.fillRect(x + 3, y + 3, this.cell - 6, this.cell - 6);
      }
    }

    ctx.font = `11px ${FONT_MONO}`;
    ctx.fillStyle = BOARD.textMuted;
    ctx.textAlign = 'center';
    ctx.fillText('decisão', band.x, MARGIN.top - 10);
  }

  private drawWires(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = BOARD.wire;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const bus = this.center(0, DECISION_COL).x;
    ctx.beginPath();
    for (const porta of PORTS) {
      const y = this.center(portRow(porta), 0).y;
      ctx.moveTo(MARGIN.left - 10, y);
      ctx.lineTo(bus, y);
    }
    ctx.moveTo(bus, this.center(0, 0).y);
    ctx.lineTo(bus, this.center(ROWS - 1, 0).y);
    for (const out of OUTPUTS) {
      const y = this.center(out.row, 0).y;
      ctx.moveTo(bus, y);
      ctx.lineTo(MARGIN.left + COLS * this.cell + 10, y);
    }
    ctx.stroke();
  }

  private drawPorts(): void {
    const ctx = this.ctx;
    const h = this.cell * 0.46;
    for (const porta of PORTS) {
      const { y } = this.center(portRow(porta), 0);
      roundRect(ctx, 10, y - h / 2, MARGIN.left - 22, h, 6);
      ctx.fillStyle = BOARD.cell;
      ctx.fill();
      ctx.strokeStyle = BOARD.wire;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = BOARD.text;
      ctx.font = `600 12px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(`P${porta}`, 10 + (MARGIN.left - 22) / 2, y + 4);
    }
  }

  private drawOutputs(palette: readonly Color[]): void {
    const ctx = this.ctx;
    const x = MARGIN.left + COLS * this.cell + 10;
    const w = MARGIN.right - 18;
    const h = this.cell * 0.58;
    this.outputBoxes = [];
    OUTPUTS.forEach((out, i) => {
      const { y } = this.center(out.row, 0);
      const active = out.dest.kind === 'terra' || palette.includes(out.dest.cor);
      const accent = out.dest.kind === 'terra' ? PULSE_FILL.GRAY : PULSE_FILL[out.dest.cor];
      roundRect(ctx, x, y - h / 2, w, h, 8);
      ctx.fillStyle = BOARD.cell;
      ctx.fill();
      ctx.strokeStyle = active ? accent : BOARD.inactive;
      ctx.lineWidth = active ? 2 : 1;
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.font = `600 12px ${FONT_MONO}`;
      ctx.fillStyle = active ? BOARD.text : BOARD.inactive;
      const name = out.dest.kind === 'terra' ? 'TERRA ⏚' : out.dest.cor;
      ctx.fillText(name, x + 30, y + 4);
      ctx.font = `11px ${FONT_MONO}`;
      ctx.fillStyle = BOARD.textMuted;
      ctx.fillText(String(i + 1), x + 11, y + 4);
      if (!active) ctx.fillText('inativa', x + 30, y + h / 2 - 5);

      this.outputBoxes.push({ dest: out.dest, x, y: y - h / 2, w, h });
    });
  }

  private drawPlannedPath(pulse: Pulse): void {
    if (!pulse.dest) return;
    const ctx = this.ctx;
    const target = destRow(pulse.dest);
    const points: Point[] = [this.center(pulse.row, pulse.col)];
    if (pulse.col <= DECISION_COL) {
      points.push(this.center(pulse.row, DECISION_COL), this.center(target, DECISION_COL));
    }
    points.push({ x: MARGIN.left + COLS * this.cell + 10, y: this.center(target, 0).y });
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = destColor(pulse.dest);
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.restore();
  }

  private drawPulses(game: Game, selectedId: number | null, t: number): void {
    const ctx = this.ctx;
    const r = this.cell * 0.24;
    this.hits = [];

    // Pulsos que acabaram de sair da grade deslizam até a saída e somem.
    if (this.tween && t < 1) {
      for (const [id, before] of this.tween.from) {
        if (game.pulses.some((p) => p.id === id)) continue;
        const from = this.center(before.row, before.col);
        const to = { x: MARGIN.left + COLS * this.cell + 10, y: from.y };
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
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = BOARD.selection;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

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
      ctx.fillStyle = PULSE_FILL[pulse.cor];
      ctx.fill();
    }

    ctx.font = `10px ${FONT_MONO}`;
    ctx.fillStyle = BOARD.textMuted;
    ctx.textAlign = 'center';
    ctx.fillText(`#${pulse.seq}`, pos.x, pos.y + r + 12);

    this.drawDestinationBadge(pulse, pos, r);
  }

  /** Selo no canto do pulso: para onde ele vai e quem decidiu. */
  private drawDestinationBadge(pulse: Pulse, pos: Point, r: number): void {
    const ctx = this.ctx;
    const b = { x: pos.x + r * 0.78, y: pos.y - r * 0.78 };
    const br = Math.max(5, r * 0.36);
    ctx.beginPath();
    ctx.arc(b.x, b.y, br, 0, Math.PI * 2);

    if (!pulse.dest) {
      const urgent = isAssignable(pulse) && pulse.col === DECISION_COL;
      ctx.fillStyle = BOARD.background;
      ctx.fill();
      ctx.strokeStyle = urgent ? BOARD.warning : BOARD.textMuted;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = urgent ? BOARD.warning : BOARD.textMuted;
      ctx.font = `700 ${Math.round(br * 1.4)}px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(urgent ? '!' : '·', b.x, b.y + br * 0.5);
      return;
    }

    ctx.fillStyle = destColor(pulse.dest);
    ctx.fill();
    ctx.strokeStyle = pulse.destBy === 'manual' ? BOARD.selection : BOARD.background;
    ctx.lineWidth = pulse.destBy === 'manual' ? 2 : 1.5;
    ctx.stroke();
    if (pulse.dest.kind === 'terra') {
      ctx.fillStyle = BOARD.background;
      ctx.font = `700 ${Math.round(br * 1.2)}px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText('T', b.x, b.y + br * 0.42);
    }
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
