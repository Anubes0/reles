import { COLOR_LABEL, SHAPE_LABEL, SHAPES, type PulseColor, type Shape } from '../core/colors';
import type { Game } from '../game/engine';
import type { DeliveryOutcome } from '../game/types';
import { destLabel } from './render';
import { PULSE_FILL } from './theme';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ITEMS = 24;
const COL_W = 21;
const LEFT = 30;
const TOP = 14;
const DOT_R = 6;

export type RowKey = 'porta' | 'carga' | 'forma';

export interface TimelineItem {
  seq: number;
  porta: number;
  carga: number;
  forma: Shape;
  /** `null` enquanto a cor é desconhecida (velado ainda na grade ou na fila). */
  cor: PulseColor | null;
  velado: boolean;
  state: 'saiu' | 'grade' | 'fila';
  outcome?: DeliveryOutcome;
  detail?: string;
}

/** Junta pulsos que saíram, na grade e na fila numa sequência única por `seq`. */
export function timelineItems(game: Game): TimelineItem[] {
  const items: TimelineItem[] = [
    ...game.delivered.map((d): TimelineItem => ({
      seq: d.seq,
      porta: d.porta,
      carga: d.carga,
      forma: d.forma,
      cor: d.cor,
      velado: d.velado,
      state: 'saiu',
      outcome: d.outcome,
      detail: d.motivo === 'colisao' ? 'colidiu' : d.motivo === 'queimou' ? 'queimou' : d.dest ? destLabel(d.dest) : 'perdido',
    })),
    ...game.pulses.map((p): TimelineItem => ({
      seq: p.seq,
      porta: p.porta,
      carga: p.carga,
      forma: p.forma,
      cor: p.velado ? null : p.cor,
      velado: p.velado,
      state: 'grade',
    })),
    ...game.queue.map((q): TimelineItem => ({
      seq: q.seq,
      porta: q.porta,
      carga: q.carga,
      forma: q.forma,
      cor: q.velado ? null : q.cor,
      velado: q.velado,
      state: 'fila',
    })),
  ];
  return items.sort((a, b) => a.seq - b.seq).slice(-MAX_ITEMS);
}

const SHAPE_GLYPH: Record<Shape, string> = { CIRCULO: '●', QUADRADO: '■', TRIANGULO: '▶' };

/**
 * Linha do tempo dos sinais: colunas por `seq`, linhas por porta, carga ou forma.
 * É a ferramenta para deduzir a regra oculta — os velados aparecem como "?" no meio da sequência.
 */
export class PatternTimeline {
  groupBy: number | null = null;
  rowKey: RowKey = 'porta';

  constructor(private readonly root: HTMLElement) {}

  render(items: TimelineItem[], boundaries: number[], activePorts: number[]): void {
    if (items.length === 0) {
      this.root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Os pulsos aparecem aqui conforme entram.' }));
      return;
    }

    const rows = this.rowValues(items, activePorts);
    const rowH = rows.length > 6 ? 17 : 24;
    const rowsBottom = TOP + rows.length * rowH;
    const residueRow = this.groupBy !== null;
    const height = rowsBottom + (residueRow ? 40 : 26);
    const width = LEFT + MAX_ITEMS * COL_W + 6;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'timeline-svg', role: 'img' });
    svg.setAttribute('aria-label', `Linha do tempo com ${items.length} pulsos`);

    const x = (i: number) => LEFT + i * COL_W + COL_W / 2;
    const y = (value: string) => TOP + rows.indexOf(value) * rowH + rowH / 2;

    for (const value of rows) {
      svg.append(
        svgEl('line', { x1: LEFT, x2: width - 4, y1: y(value), y2: y(value), class: 'tl-rail' }),
        svgText(this.rowLabel(value), { x: 3, y: y(value) + 3.5, class: 'tl-port' }),
      );
    }

    items.forEach((item, i) => {
      const cx = x(i);
      if (this.groupBy !== null && item.seq % this.groupBy === 0) {
        svg.append(svgEl('line', { x1: cx - COL_W / 2, x2: cx - COL_W / 2, y1: TOP - 5, y2: rowsBottom + 2, class: 'tl-group' }));
      }
      const prevSeq = i > 0 ? items[i - 1].seq : -1;
      if (i > 0 && boundaries.some((b) => b > prevSeq && b <= item.seq)) {
        const bx = cx - COL_W / 2;
        svg.append(
          svgEl('line', { x1: bx, x2: bx, y1: 1, y2: rowsBottom + 3, class: 'tl-regime' }),
          svgText('regime', { x: bx + 2, y: 8, class: 'tl-regime-label' }),
        );
      }

      const g = svgEl('g', { class: `tl-item tl-${item.state}` });
      const cy = y(this.valueOf(item));
      const glyph = shapeEl(item.forma, cx, cy, DOT_R);
      if (item.cor === null) {
        glyph.setAttribute('class', 'tl-unknown');
        g.append(glyph, svgText('?', { x: cx - (item.forma === 'TRIANGULO' ? 1 : 0), y: cy + 3, class: 'tl-q' }));
      } else {
        glyph.setAttribute('class', 'tl-dot');
        glyph.setAttribute('fill', PULSE_FILL[item.cor]);
        g.append(glyph);
        if (item.velado) {
          const ring = svgEl('circle', { cx, cy, r: DOT_R + 3, class: 'tl-veil-ring' });
          g.append(ring);
        }
      }
      if (this.rowKey !== 'carga') {
        for (let k = 0; k < item.carga; k++) {
          g.append(svgEl('circle', { cx: cx + (k - (item.carga - 1) / 2) * 3.2, cy: cy + DOT_R + 2.6, r: 0.95, class: 'tl-pip' }));
        }
      }

      g.append(svgText(String(item.seq), { x: cx, y: rowsBottom + 10, class: 'tl-seq' }));
      if (item.outcome) {
        g.append(svgEl('rect', { x: cx - 5, y: rowsBottom + 14, width: 10, height: 3, rx: 1.5, class: `tl-out tl-${item.outcome}` }));
      }
      if (residueRow) g.append(svgText(String(item.seq % this.groupBy!), { x: cx, y: rowsBottom + 32, class: 'tl-residue' }));

      const title = svgEl('title', {});
      title.textContent = describe(item);
      g.append(title);
      svg.append(g);
    });

    svg.append(svgText('seq', { x: 3, y: rowsBottom + 10, class: 'tl-port' }));
    if (residueRow) svg.append(svgText(`%${this.groupBy}`, { x: 3, y: rowsBottom + 32, class: 'tl-port' }));
    this.root.replaceChildren(svg);
  }

  private valueOf(item: TimelineItem): string {
    return this.rowKey === 'forma' ? item.forma : String(item[this.rowKey]);
  }

  private rowValues(items: TimelineItem[], activePorts: number[]): string[] {
    if (this.rowKey === 'carga') return ['1', '2', '3'];
    if (this.rowKey === 'forma') return [...SHAPES];
    const ports = new Set([...activePorts, ...items.map((i) => i.porta)]);
    return [...ports].sort((a, b) => a - b).map(String);
  }

  private rowLabel(value: string): string {
    if (this.rowKey === 'porta') return `P${value}`;
    if (this.rowKey === 'carga') return `c${value}`;
    return SHAPE_GLYPH[value as Shape];
  }
}

function describe(item: TimelineItem): string {
  const cor = item.cor ? COLOR_LABEL[item.cor] : 'cor desconhecida';
  const veil = item.velado ? ' (velado)' : '';
  const where =
    item.state === 'saiu'
      ? `${item.detail} ${item.outcome === 'acerto' ? '✓' : item.outcome === 'erro' ? '✗' : ''}`
      : item.state === 'grade'
        ? 'na grade'
        : 'na fila';
  return `#${item.seq} · porta ${item.porta} · carga ${item.carga} · ${SHAPE_LABEL[item.forma]} · ${cor}${veil} · ${where}`;
}

function shapeEl(forma: Shape, cx: number, cy: number, r: number): SVGElement {
  if (forma === 'QUADRADO') {
    const s = r * 1.62;
    return svgEl('rect', { x: cx - s / 2, y: cy - s / 2, width: s, height: s, rx: 1.4 });
  }
  if (forma === 'TRIANGULO') {
    return svgEl('polygon', {
      points: `${cx + r * 1.05},${cy} ${cx - r * 0.75},${cy - r * 0.98} ${cx - r * 0.75},${cy + r * 0.98}`,
    });
  }
  return svgEl('circle', { cx, cy, r });
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node as SVGElement;
}

function svgText(text: string, attrs: Record<string, string | number>): SVGElement {
  const node = svgEl('text', attrs);
  node.textContent = text;
  return node;
}
