import type { BoxId } from '../game/boxes';
import type { ModeId } from '../game/mode';

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

export interface MatchRecord {
  score: number;
  turns: number;
  precision: number | null;
  abandoned: boolean;
  date: string;
}

export type Baggage = Partial<Record<BoxId, string>>;

const HISTORY_KEPT = 20;

export const storage = {
  record(mode: ModeId): number {
    return read(`reles.recorde.${mode}`, 0);
  },

  /**
   * Registra o fim de uma partida. Partida abandonada só conta pontos se forem
   * maiores que 0 (documento conceitual: "Progressão entre partidas").
   * Retorna `true` se foi um novo recorde.
   */
  finishMatch(mode: ModeId, match: MatchRecord): boolean {
    if (match.abandoned && match.score <= 0) return false;
    const history = read<MatchRecord[]>(`reles.historico.${mode}`, []);
    history.push(match);
    write(`reles.historico.${mode}`, history.slice(-HISTORY_KEPT));
    if (match.score > this.record(mode)) {
      write(`reles.recorde.${mode}`, match.score);
      return true;
    }
    return false;
  },

  /** Rascunho do editor de uma caixa (a versão antiga guardava só o Classificador). */
  script(box: BoxId): string | null {
    const saved = read<string | null>(`reles.script.${box}`, null);
    if (saved !== null || box !== 'classificar') return saved;
    return read<string | null>('reles.script', null);
  },

  saveScript(box: BoxId, source: string): void {
    write(`reles.script.${box}`, source);
  },

  /** Bagagem do modo: os scripts instalados ao fim da partida seguem para a próxima. */
  baggage(mode: ModeId): Baggage {
    const saved = read<Baggage | string | null>(`reles.bagagem.${mode}`, null);
    if (typeof saved === 'string') return { classificar: saved };
    return saved ?? {};
  },

  saveBaggage(mode: ModeId, baggage: Baggage): void {
    write(`reles.bagagem.${mode}`, baggage);
  },

  helpSeen(): boolean {
    return read('reles.ajudaVista2', false);
  },

  markHelpSeen(): void {
    write('reles.ajudaVista2', true);
  },
};
