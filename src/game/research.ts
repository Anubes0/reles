import type { Features, LockedFeature } from '../dsl/errors';

/** O que se compra com pontos de pesquisa: recursos da linguagem e caixas novas. */
export type ResearchId = LockedFeature | 'prever' | 'vigiar' | 'aprender';

export interface ResearchItem {
  id: ResearchId;
  nome: string;
  libera: string;
  preco: number;
  /** Outro item que precisa ser comprado antes. */
  requer?: ResearchId;
}

/** Catálogo do documento conceitual ("A DSL"): Histórico e Laço já vêm liberados. */
export const RESEARCH: ResearchItem[] = [
  { id: 'sensores', nome: 'Sensores avançados', libera: 'vizinhos(j) e dist(j, destino) no Roteador', preco: 80 },
  { id: 'memoria', nome: 'Memória', libera: 'mem: 8 posições compartilhadas entre as caixas (2 de energia por posição usada, por turno)', preco: 100 },
  { id: 'funcional', nome: 'Funcional', libera: 'x => …, .filter, .map e .some', preco: 100 },
  { id: 'casamento', nome: 'Casamento', libera: 'match / case', preco: 120 },
  { id: 'prever', nome: 'Caixa Previsor', libera: 'prever(hist): acertar a cor do próximo pulso dobra os pontos dele', preco: 150 },
  { id: 'vigiar', nome: 'Caixa Vigia', libera: 'vigiar(evento, hist): dispara um alerta e pausa quando algo sai do padrão', preco: 150 },
  { id: 'aprender', nome: 'Caixa Aprendiz', libera: 'ao_entregar(p, ok): aprende com acertos e erros, gravando no mem', preco: 400, requer: 'memoria' },
];

/** 1 ponto de pesquisa a cada 100 pontos de uma partida terminada (abandonada não rende). */
export function researchPointsFor(score: number): number {
  return Math.floor(score / 100);
}

export function featuresFrom(unlocked: ReadonlySet<ResearchId>): Features {
  return {
    sensores: unlocked.has('sensores'),
    memoria: unlocked.has('memoria'),
    funcional: unlocked.has('funcional'),
    casamento: unlocked.has('casamento'),
  };
}
