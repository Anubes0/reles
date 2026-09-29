import { COLORS, DIRS, type Color, type Dir } from '../core/colors';
import type { Rng } from '../core/rng';
import type { Destination } from './types';

/**
 * Grade 15 × 15. Os pulsos entram pela esquerda (portas), andam para leste pelos fios
 * e, nas colunas de relés, seguem a direção do relé (▲ ► ▼). Saem pela borda direita.
 */
export const ROWS = 15;
export const COLS = 15;
export const RELAY_COLS = [3, 6, 9, 12] as const;
export const LAST_RELAY_COL = RELAY_COLS[RELAY_COLS.length - 1];
export const TERRA_ROW = 7;
export const MAX_PORTS = 10;
/** Pulso que chega a esta coluna de relés sem destino segue para o terra. */
export const DEADLINE_COL = RELAY_COLS[1];

export interface Output {
  row: number;
  cor: Color;
}

export interface Layout {
  /** Linha de cada porta: `portRows[porta - 1]`. Portas numeradas de cima para baixo. */
  portRows: number[];
  /** Ordem em que o diretor ativa as portas. */
  portActivation: number[];
  outputs: Output[];
}

export interface Cell {
  row: number;
  col: number;
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

/** Sorteia as linhas das portas e das saídas de uma partida. */
export function generateLayout(rng: Rng): Layout {
  const rows = Array.from({ length: ROWS }, (_, r) => r);
  const portRows = shuffle(rng, rows).slice(0, MAX_PORTS).sort((a, b) => a - b);
  const outputRows = shuffle(rng, rows.filter((r) => r !== TERRA_ROW))
    .slice(0, COLORS.length)
    .sort((a, b) => a - b);
  const colors = shuffle(rng, [...COLORS]);
  return {
    portRows,
    portActivation: shuffle(rng, portRows.map((_, i) => i + 1)),
    outputs: outputRows.map((row, i) => ({ row, cor: colors[i] })),
  };
}

/** Trecho de fio que pode romper: horizontal entre duas colunas de relés, ou vertical numa coluna de relés. */
type Segment = string;

const hSeg = (row: number, i: number): Segment => `h:${row}:${i}`;
const vSeg = (row: number, i: number): Segment => `v:${row}:${i}`;

export class Grid {
  readonly broken = new Set<Segment>();
  private readonly dirs = new Map<string, Dir>();

  constructor(readonly layout: Layout) {
    this.normalizeDirs();
  }

  isRelay(row: number, col: number): boolean {
    return (RELAY_COLS as readonly number[]).includes(col) && row >= 0 && row < ROWS;
  }

  portRow(porta: number): number {
    return this.layout.portRows[porta - 1];
  }

  exitAt(row: number): Destination | null {
    if (row === TERRA_ROW) return { kind: 'terra' };
    const out = this.layout.outputs.find((o) => o.row === row);
    return out ? { kind: 'saida', cor: out.cor } : null;
  }

  rowOf(dest: Destination): number {
    if (dest.kind === 'terra') return TERRA_ROW;
    return this.layout.outputs.find((o) => o.cor === dest.cor)!.row;
  }

  isBroken(segment: Segment): boolean {
    return this.broken.has(segment);
  }

  /** Um relé pode apontar nesta direção? (fio inteiro e, na última coluna, uma saída do lado de lá) */
  canGo(row: number, col: number, d: Dir): boolean {
    const i = RELAY_COLS.indexOf(col as (typeof RELAY_COLS)[number]);
    if (i === -1) return d === 'LESTE';
    if (d === 'NORTE') return row > 0 && !this.broken.has(vSeg(row - 1, i));
    if (d === 'SUL') return row < ROWS - 1 && !this.broken.has(vSeg(row, i));
    if (col === LAST_RELAY_COL) return this.exitAt(row) !== null;
    return !this.broken.has(hSeg(row, i));
  }

  validDirs(row: number, col: number): Dir[] {
    return DIRS.filter((d) => this.canGo(row, col, d));
  }

  dir(row: number, col: number): Dir {
    return this.dirs.get(cellKey(row, col)) ?? 'LESTE';
  }

  setDir(row: number, col: number, d: Dir): boolean {
    if (!this.isRelay(row, col) || !this.canGo(row, col, d)) return false;
    this.dirs.set(cellKey(row, col), d);
    return true;
  }

  /** Gira o relé para a próxima direção válida (▲ → ► → ▼). */
  rotate(row: number, col: number, step: 1 | -1 = 1): Dir | null {
    const valid = this.validDirs(row, col);
    if (valid.length < 2) return null;
    const current = DIRS.indexOf(this.dir(row, col));
    for (let k = 1; k <= DIRS.length; k++) {
      const next = DIRS[(current + step * k + DIRS.length * 2) % DIRS.length];
      if (valid.includes(next)) {
        this.dirs.set(cellKey(row, col), next);
        return next;
      }
    }
    return null;
  }

  /** Casa vizinha na direção; `col === COLS` significa que o pulso saiu pela borda direita. */
  step(row: number, col: number, d: Dir): Cell {
    if (d === 'NORTE') return { row: row - 1, col };
    if (d === 'SUL') return { row: row + 1, col };
    return { row, col: col + 1 };
  }

  /** Cópia independente (relés e fios), para simular rotas sem mexer na partida. */
  clone(): Grid {
    const copy = new Grid(this.layout);
    for (const s of this.broken) copy.broken.add(s);
    copy.dirs.clear();
    for (const [key, d] of this.dirs) copy.dirs.set(key, d);
    return copy;
  }

  /** Relés que apontam para um fio rompido voltam para uma direção válida. */
  normalizeDirs(): void {
    for (let row = 0; row < ROWS; row++) {
      for (const col of RELAY_COLS) {
        const current = this.dirs.get(cellKey(row, col));
        if (current && this.canGo(row, col, current)) continue;
        const valid = this.validDirs(row, col);
        const preferred: Dir = row < TERRA_ROW ? 'SUL' : 'NORTE';
        const d = valid.includes('LESTE') ? 'LESTE' : valid.includes(preferred) ? preferred : valid[0];
        if (d) this.dirs.set(cellKey(row, col), d);
      }
    }
  }

  /** Linhas de saída alcançáveis a partir da entrada de uma porta, seguindo qualquer caminho. */
  reachableExits(entryRow: number): Set<number> {
    const exits = new Set<number>();
    const seen = new Set<string>();
    const stack: Cell[] = [{ row: entryRow, col: RELAY_COLS[0] }];
    while (stack.length > 0) {
      const { row, col } = stack.pop()!;
      const key = cellKey(row, col);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const d of this.validDirs(row, col)) {
        if (d === 'LESTE' && col === LAST_RELAY_COL) {
          exits.add(row);
          continue;
        }
        const next = d === 'LESTE' ? { row, col: RELAY_COLS[RELAY_COLS.indexOf(col as never) + 1] } : this.step(row, col, d);
        stack.push(next);
      }
    }
    return exits;
  }

  /** Toda porta ativa alcança toda saída ativa, e nenhum relé fica sem saída. */
  isPlayable(activePortRows: number[], activeExitRows: number[]): boolean {
    for (let row = 0; row < ROWS; row++) {
      for (const col of RELAY_COLS) if (this.validDirs(row, col).length === 0) return false;
    }
    return activePortRows.every((portRow) => {
      const reach = this.reachableExits(portRow);
      return activeExitRows.every((exitRow) => reach.has(exitRow));
    });
  }

  /**
   * Rompe `count` trechos de fio (os anteriores são consertados), sem tocar trechos com
   * pulsos em cima e sem tirar o caminho de nenhuma porta ativa. Retorna quantos romperam.
   */
  mutate(rng: Rng, count: number, activePortRows: number[], activeExitRows: number[], occupied: Set<Segment>): number {
    const candidates: Segment[] = [];
    for (let row = 0; row < ROWS; row++) {
      for (let i = 0; i < RELAY_COLS.length - 1; i++) if (!occupied.has(hSeg(row, i))) candidates.push(hSeg(row, i));
      if (row < ROWS - 1) for (let i = 0; i < RELAY_COLS.length; i++) candidates.push(vSeg(row, i));
    }
    for (let n = Math.min(count, candidates.length); n >= 0; n--) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const chosen = shuffle(rng, candidates).slice(0, n);
        this.broken.clear();
        for (const s of chosen) this.broken.add(s);
        if (this.isPlayable(activePortRows, activeExitRows)) {
          this.normalizeDirs();
          return n;
        }
      }
    }
    this.broken.clear();
    this.normalizeDirs();
    return 0;
  }

  /**
   * Troca as cores de pares de saídas ativas (deriva nas saídas), sem mexer nas linhas
   * em que já há pulso depois do último relé. Retorna quantas trocas fez.
   */
  driftOutputs(rng: Rng, activeColors: readonly Color[], swaps: number, lockedRows: Set<number>): number {
    const active = this.layout.outputs.filter((o) => activeColors.includes(o.cor) && !lockedRows.has(o.row));
    let done = 0;
    for (let k = 0; k < swaps && active.length >= 2; k++) {
      const [a, b] = shuffle(rng, active).slice(0, 2);
      [a.cor, b.cor] = [b.cor, a.cor];
      done++;
    }
    this.normalizeDirs();
    return done;
  }

  /** Trechos horizontais que têm pulso em cima (não podem romper agora). */
  static occupiedSegments(cells: Cell[]): Set<Segment> {
    const occupied = new Set<Segment>();
    for (const { row, col } of cells) {
      for (let i = 0; i < RELAY_COLS.length - 1; i++) {
        if (col > RELAY_COLS[i] && col < RELAY_COLS[i + 1]) occupied.add(hSeg(row, i));
      }
    }
    return occupied;
  }

  /** Para desenhar: trechos rompidos já decodificados. */
  brokenSegments(): { kind: 'h' | 'v'; row: number; index: number }[] {
    return [...this.broken].map((s) => {
      const [kind, row, index] = s.split(':');
      return { kind: kind as 'h' | 'v', row: Number(row), index: Number(index) };
    });
  }
}

function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
