import type { TimeBankConfig } from './mode';

/**
 * Banco de tempo do médio e do difícil (documento conceitual: "Banco de tempo").
 * Cada turno consome o tempo que o jogador levou; encerrar o turno devolve um pouco.
 * Com o banco zerado, os turnos passam sozinhos, só com os scripts, até ele se recuperar.
 */
export class TimeBank {
  remainingMs: number;
  auto = false;

  constructor(readonly config: TimeBankConfig) {
    this.remainingMs = config.startMs;
  }

  get fraction(): number {
    return this.remainingMs / this.config.maxMs;
  }

  /** Desconta o tempo gasto pensando (ou na bancada). Retorna `true` se o banco zerou agora. */
  spend(ms: number): boolean {
    if (this.auto || ms <= 0) return false;
    this.remainingMs = Math.max(0, this.remainingMs - ms);
    if (this.remainingMs > 0) return false;
    this.auto = true;
    return true;
  }

  /** Fim de turno: recarrega e sai do modo automático quando chega ao valor de retomada. */
  turnEnded(): void {
    this.remainingMs = Math.min(this.config.maxMs, this.remainingMs + this.config.rechargeMs);
    if (this.auto && this.remainingMs >= this.config.resumeMs) this.auto = false;
  }
}
