import type { BoxId } from '../game/boxes';

/** Scripts iniciais de cada caixa: resolvem o óbvio e deixam o resto para o jogador. */
export const DEFAULT_SCRIPTS: Record<BoxId, string> = {
  classificar: `# Classificador: decide o destino de cada pulso que entra.
# Retorne saida(COR), TERRA ou MANUAL (fica por sua conta).
box classificar(p, hist):
    if p.cor == GRAY:
        return TERRA          # ruído vai para o terra
    if p.cor != None:
        return saida(p.cor)
    return MANUAL             # velado: descubra a regra!
`,
  rotear: `# Roteador: roda quando um pulso está num relé e decide para onde ele segue.
# Retorne NORTE, LESTE, SUL, ESPERAR (parado 1 turno) ou MANTER.
box rotear(j, p, destino):
    if destino == None:
        return MANTER         # sem destino: segue a seta do relé
    if destino.linha < j.linha and j.norte:
        return NORTE
    if destino.linha > j.linha and j.sul:
        return SUL
    if j.leste:
        return LESTE
    return MANTER
`,
};
