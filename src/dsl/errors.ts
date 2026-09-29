/** Erro da DSL com posição no código do jogador (linha e coluna começam em 1). */
export class DslError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(message);
    this.name = 'DslError';
  }
}

/** Recursos da linguagem que existem no design mas ainda não foram desbloqueados. */
export const LOCKED_FEATURES = {
  historico: { nome: 'Histórico', preco: 40 },
  laco: { nome: 'Laço', preco: 60 },
  funcional: { nome: 'Funcional', preco: 100 },
  casamento: { nome: 'Casamento', preco: 120 },
} as const;

export type LockedFeature = keyof typeof LOCKED_FEATURES;

export function lockedMessage(feature: LockedFeature): string {
  const f = LOCKED_FEATURES[feature];
  return `recurso bloqueado: ${f.nome} (${f.preco} PP)`;
}
