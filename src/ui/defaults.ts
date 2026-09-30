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
  prever: `# Previsor: aposta na cor do PRÓXIMO pulso, olhando só o histórico.
# Se acertar, o pulso entra sintonizado e vale o dobro. Retorne uma cor ou None.
box prever(hist):
    if len(hist) == 0:
        return None
    # Ex.: se as cores seguem um ciclo pelo seq:
    # return [RED, BLUE][(hist[-1].seq + 1) % 2]
    return None
`,
  vigiar: `# Vigia: recebe cada evento (ENTREGA, COLISAO ou QUEIMOU) e pode dar ALERTA,
# que pausa o jogo para você olhar. Retorne ALERTA ou None.
box vigiar(evento, hist):
    if evento.tipo == ENTREGA and not evento.ok:
        return ALERTA         # entrega errada: a regra pode ter mudado
    return None
`,
  aprender: `# Aprendiz: roda a cada pulso que sai, já com a cor revelada.
# Não retorna nada: grave no mem o que as outras caixas precisam lembrar.
box ao_entregar(p, ok):
    if ok:
        mem[0] = p.cor        # a última cor que acertamos
`,
};
