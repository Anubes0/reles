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

/** Recursos da linguagem liberados com pontos de pesquisa (documento conceitual: "A DSL"). */
export const LOCKED_FEATURES = {
  sensores: { nome: 'Sensores avançados', preco: 80 },
  memoria: { nome: 'Memória', preco: 100 },
  funcional: { nome: 'Funcional', preco: 100 },
  casamento: { nome: 'Casamento', preco: 120 },
} as const;

export type LockedFeature = keyof typeof LOCKED_FEATURES;

/** Quais recursos bloqueáveis estão liberados para quem está jogando. */
export type Features = Record<LockedFeature, boolean>;

export const NO_FEATURES: Features = { sensores: false, memoria: false, funcional: false, casamento: false };
export const ALL_FEATURES: Features = { sensores: true, memoria: true, funcional: true, casamento: true };

export function lockedMessage(feature: LockedFeature): string {
  const f = LOCKED_FEATURES[feature];
  return `recurso bloqueado: ${f.nome} (${f.preco} PP)`;
}
