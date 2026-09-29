import { COLOR_LABEL, type PulseColor } from '../core/colors';
import { PORTS } from '../game/board';
import type { Game } from '../game/engine';
import type { DeliveryOutcome } from '../game/types';
import { destLabel } from './render';
import { PULSE_FILL } from './theme';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ITEMS = 24;
const COL_W = 27;
const ROW_H = 26;
const LEFT = 34;
const TOP = 16;
const DOT_R = 8;

export interface TimelineItem {
  seq: number;
  porta: number;
  /** `null` enquanto a cor é desconhecida (velado ainda não entregue). */
  cor: PulseColor | null;
  velado: boolean;
  state: 'entregue' | 'grade' | 'fila';
  outcome?: DeliveryOutcome;
  detail?: string;
}

/** Junta pulsos entregues, na grade e na fila numa sequência única por `seq`. */
export function timelineItems(game: Game): TimelineItem[] {
  const items: TimelineItem[] = [
    ...game.delivered.map((d): TimelineItem => ({
      seq: d.seq,
      porta: d.porta,
      cor: d.cor,
      velado: d.velado,
      state: 'entregue',
      outcome: d.outcome,
      detail: destLabel(d.dest),
    })),
    ...game.pulses.map((p): TimelineItem => ({
      seq: p.seq,
      porta: p.porta,
      cor: p.velado ? null : p.cor,
      velado: p.velado,
      state: 'grade',
    })),
    ...game.queue.map((q): TimelineItem => ({
      seq: q.seq,
      porta: q.porta,
      cor: q.velado ? null : q.cor,
      velado: q.velado,
      state: 'fila',
    })),
  ];
  return items.sort((a, b) => a.seq - b.seq).slice(-MAX_ITEMS);
}

/**
 * Linha do tempo dos sinais: colunas por `seq`, linhas por porta. É a ferramenta
 * para deduzir a regra oculta — os velados aparecem como "?" no meio da sequência.
 */
export class PatternTimeline {
  groupBy: number | null = null;

  constructor(private readonly root: HTMLElement) {}

  render(items: TimelineItem[], boundaries: number[]): void {
    if (items.length === 0) {
      this.root.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Os pulsos aparecem aqui conforme entram.' }));
      return;
    }

    const residueRow = this.groupBy !== null;
    const rowsBottom = TOP + PORTS.length * ROW_H;
    const height = rowsBottom + (residueRow ? 44 : 30);
    const width = LEFT + MAX_ITEMS * COL_W + 8;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'timeline-svg', role: 'img' });
    svg.setAttribute('aria-label', `Linha do tempo com ${items.length} pulsos`);

    const x = (i: number) => LEFT + i * COL_W + COL_W / 2;
    const y = (porta: number) => TOP + (porta - 1) * ROW_H + ROW_H / 2;

    // Faixas das portas.
    for (const porta of PORTS) {
      svg.append(
        svgEl('line', { x1: LEFT, x2: width - 8, y1: y(porta), y2: y(porta), class: 'tl-rail' }),
        svgText(`P${porta}`, { x: 6, y: y(porta) + 4, class: 'tl-port' }),
      );
    }

    items.forEach((item, i) => {
      const cx = x(i);

      // Início de um grupo seq % k: linha vertical fina antes da coluna.
      if (this.groupBy !== null && item.seq % this.groupBy === 0) {
        svg.append(svgEl('line', { x1: cx - COL_W / 2, x2: cx - COL_W / 2, y1: TOP - 6, y2: rowsBottom + 2, class: 'tl-group' }));
      }
      // Mudança de regime entre esta coluna e a anterior.
      const prevSeq = i > 0 ? items[i - 1].seq : -1;
      if (boundaries.some((b) => b > prevSeq && b <= item.seq) && i > 0) {
        const bx = cx - COL_W / 2;
        svg.append(
          svgEl('line', { x1: bx, x2: bx, y1: 2, y2: rowsBottom + 4, class: 'tl-regime' }),
          svgText('regime', { x: bx + 3, y: 10, class: 'tl-regime-label' }),
        );
      }

      const g = svgEl('g', { class: `tl-item tl-${item.state}` });
      const cy = y(item.porta);
      if (item.cor === null) {
        g.append(
          svgEl('circle', { cx, cy, r: DOT_R, class: 'tl-unknown' }),
          svgText('?', { x: cx, y: cy + 4, class: 'tl-q' }),
        );
      } else {
        const dot = svgEl('circle', { cx, cy, r: DOT_R, class: 'tl-dot' });
        dot.setAttribute('fill', PULSE_FILL[item.cor]);
        g.append(dot);
        if (item.velado) g.append(svgEl('circle', { cx, cy, r: DOT_R + 3.5, class: 'tl-veil-ring' }));
      }

      g.append(svgText(String(item.seq), { x: cx, y: rowsBottom + 12, class: 'tl-seq' }));
      if (item.outcome) {
        g.append(svgEl('rect', { x: cx - 6, y: rowsBottom + 17, width: 12, height: 3, rx: 1.5, class: `tl-out tl-${item.outcome}` }));
      }
      if (residueRow) {
        g.append(svgText(String(item.seq % this.groupBy!), { x: cx, y: rowsBottom + 36, class: 'tl-residue' }));
      }

      const title = svgEl('title', {});
      title.textContent = describe(item);
      g.append(title);
      svg.append(g);
    });

    if (residueRow) svg.append(svgText(`%${this.groupBy}`, { x: 6, y: rowsBottom + 36, class: 'tl-port' }));
    svg.append(svgText('seq', { x: 6, y: rowsBottom + 12, class: 'tl-port' }));

    this.root.replaceChildren(svg);
  }
}

function describe(item: TimelineItem): string {
  const cor = item.cor ? COLOR_LABEL[item.cor] : 'cor desconhecida';
  const veil = item.velado ? ' (velado)' : '';
  const where =
    item.state === 'entregue'
      ? `entregue: ${item.detail} ${item.outcome === 'acerto' ? '✓' : item.outcome === 'erro' ? '✗' : '(perdido)'}`
      : item.state === 'grade'
        ? 'na grade'
        : 'na fila';
  return `#${item.seq} · porta ${item.porta} · ${cor}${veil} · ${where}`;
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
