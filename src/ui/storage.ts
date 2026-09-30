import type { BoxId } from '../game/boxes';
import type { Command, MatchStart } from '../game/engine';
import type { ModeId } from '../game/mode';
import type { ResearchId } from '../game/research';

/** Acesso ao localStorage que nunca quebra o jogo (aba privada, armazenamento bloqueado etc.). */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Sem armazenamento: o jogo segue, só não lembra entre sessões.
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Idem.
  }
}

export interface MatchRecord {
  score: number;
  turns: number;
  precision: number | null;
  abandoned: boolean;
  date: string;
  maxLevel?: number;
  regimes?: number;
  /** Tempo médio por turno, em segundos. */
  avgTurnSeconds?: number;
  pp?: number;
}

export type Baggage = Partial<Record<BoxId, string>>;

/**
 * A partida ativa (só existe uma, em qualquer modo): início e diário de comandos.
 * Ao abrir o jogo, ela é refeita comando a comando e conferida com `check`.
 */
export interface SavedMatch {
  start: MatchStart;
  journal: Command[];
  check: { turn: number; score: number; integrity: number; precision: number | null; maxLevel: number; regimes: number };
  bank: { remainingMs: number; auto: boolean } | null;
  /** Soma e contagem dos segundos por turno (para o tempo médio do histórico). */
  turnTime: { total: number; count: number };
}

const HISTORY_KEPT = 30;
const MATCH_KEY = 'reles.partida';

/**
 * Tudo é separado por modo (documento conceitual: "Progressão entre partidas"):
 * recorde, histórico, pontos de pesquisa, desbloqueios, bagagem e rascunhos.
 */
export const storage = {
  record(mode: ModeId): number {
    return read(`reles.recorde.${mode}`, 0);
  },

  history(mode: ModeId): MatchRecord[] {
    return read<MatchRecord[]>(`reles.historico.${mode}`, []);
  },

  /**
   * Registra o fim de uma partida. Partida abandonada só conta pontos se forem
   * maiores que 0 e não rende pesquisa. Retorna `true` se foi um novo recorde.
   */
  finishMatch(mode: ModeId, match: MatchRecord): boolean {
    if (match.abandoned && match.score <= 0) return false;
    const history = this.history(mode);
    history.push(match);
    write(`reles.historico.${mode}`, history.slice(-HISTORY_KEPT));
    if (!match.abandoned && match.pp) this.addPoints(mode, match.pp);
    if (match.score > this.record(mode)) {
      write(`reles.recorde.${mode}`, match.score);
      return true;
    }
    return false;
  },

  points(mode: ModeId): number {
    return read(`reles.pp.${mode}`, 0);
  },

  addPoints(mode: ModeId, amount: number): void {
    write(`reles.pp.${mode}`, this.points(mode) + amount);
  },

  unlocked(mode: ModeId): ResearchId[] {
    return read<ResearchId[]>(`reles.pesquisa.${mode}`, []);
  },

  /** Compra um item de pesquisa. Retorna `false` se faltam pontos. */
  buy(mode: ModeId, id: ResearchId, price: number): boolean {
    const points = this.points(mode);
    if (points < price) return false;
    const unlocked = new Set(this.unlocked(mode));
    unlocked.add(id);
    write(`reles.pp.${mode}`, points - price);
    write(`reles.pesquisa.${mode}`, [...unlocked]);
    return true;
  },

  /** Rascunho do editor de uma caixa (as versões antigas não separavam por modo). */
  script(mode: ModeId, box: BoxId): string | null {
    const saved = read<string | null>(`reles.script.${mode}.${box}`, null);
    if (saved !== null || mode !== 'facil') return saved;
    return read<string | null>(`reles.script.${box}`, null) ?? (box === 'classificar' ? read<string | null>('reles.script', null) : null);
  },

  saveScript(mode: ModeId, box: BoxId, source: string): void {
    write(`reles.script.${mode}.${box}`, source);
  },

  /** O que não vai na bagagem é apagado, sem arquivo para copiar depois. */
  eraseScript(mode: ModeId, box: BoxId): void {
    remove(`reles.script.${mode}.${box}`);
    if (mode === 'facil') remove(`reles.script.${box}`);
  },

  /** Bagagem do modo: os scripts escolhidos ao fim da partida seguem para a próxima. */
  baggage(mode: ModeId): Baggage {
    const saved = read<Baggage | string | null>(`reles.bagagem.${mode}`, null);
    if (typeof saved === 'string') return { classificar: saved };
    return saved ?? {};
  },

  saveBaggage(mode: ModeId, baggage: Baggage): void {
    write(`reles.bagagem.${mode}`, baggage);
  },

  match(): SavedMatch | null {
    return read<SavedMatch | null>(MATCH_KEY, null);
  },

  saveMatch(match: SavedMatch): void {
    write(MATCH_KEY, match);
  },

  clearMatch(): void {
    remove(MATCH_KEY);
  },

  lastMode(): ModeId {
    return read<ModeId>('reles.modo', 'facil');
  },

  saveLastMode(mode: ModeId): void {
    write('reles.modo', mode);
  },

  helpSeen(): boolean {
    return read('reles.ajudaVista3', false);
  },

  markHelpSeen(): void {
    write('reles.ajudaVista3', true);
  },
};
