import { describe, expect, it } from 'vitest';
import { classify, compileClassifier } from '../src/game/classifier';
import type { PulseView } from '../src/game/types';

const pulse = (over: Partial<PulseView> = {}): PulseView => ({ seq: 0, porta: 1, cor: 'RED', turno: 1, ...over });

function run(source: string, p: PulseView = pulse(), limit = 50) {
  const compiled = compileClassifier(source);
  if (!compiled.ok) throw new Error(`compilação falhou: ${compiled.error.message} (linha ${compiled.error.line})`);
  return classify(compiled.box, p, limit);
}

function compileError(source: string) {
  const compiled = compileClassifier(source);
  if (compiled.ok) throw new Error('era esperado erro de compilação');
  return compiled.error;
}

describe('DSL — execução', () => {
  it('encaminha a cor visível e manda ruído para o terra', () => {
    const src = `
box classificar(p, hist):
    if p.cor == GRAY:
        return TERRA
    return saida(p.cor)
`;
    expect(run(src, pulse({ cor: 'BLUE' }))).toMatchObject({ ok: true, decision: { kind: 'saida', cor: 'BLUE' } });
    expect(run(src, pulse({ cor: 'GRAY' }))).toMatchObject({ ok: true, decision: { kind: 'terra' } });
  });

  it('deduz a cor de um pulso velado com ?? e lista indexada', () => {
    const src = `
box classificar(p, hist):
    const ciclo = [RED, BLUE, BLUE]
    let cor = p.cor ?? ciclo[p.seq % 3]
    return saida(cor)
`;
    expect(run(src, pulse({ cor: null, seq: 4 }))).toMatchObject({ decision: { kind: 'saida', cor: 'BLUE' } });
    expect(run(src, pulse({ cor: null, seq: 6 }))).toMatchObject({ decision: { kind: 'saida', cor: 'RED' } });
  });

  it('suporta elif/else, instrução na mesma linha, and/or/not e MANUAL', () => {
    const src = `
box classificar(p, hist):
    if p.cor != None and not (p.cor == GRAY): return saida(p.cor)
    elif p.porta == 2 or p.porta == 3:
        return saida(GREEN)
    else:
        return MANUAL
`;
    expect(run(src, pulse({ cor: 'RED' }))).toMatchObject({ decision: { kind: 'saida', cor: 'RED' } });
    expect(run(src, pulse({ cor: null, porta: 3 }))).toMatchObject({ decision: { kind: 'saida', cor: 'GREEN' } });
    expect(run(src, pulse({ cor: null, porta: 1 }))).toMatchObject({ decision: { kind: 'manual' } });
  });

  it('usa módulo e divisão inteira no estilo Python', () => {
    const src = `
box classificar(p, hist):
    let x = (0 - 7) % 3
    let y = 7 // 2
    if x == 2 and y == 3: return TERRA
    return MANUAL
`;
    expect(run(src)).toMatchObject({ decision: { kind: 'terra' } });
  });

  it('conta operações e para no limite', () => {
    const src = `
box classificar(p, hist):
    let a = 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1
    return TERRA
`;
    const ok = run(src);
    expect(ok.ok).toBe(true);
    expect(ok.ops).toBe(11); // 2 instruções (let, return) + 9 somas
    const limited = run(src, pulse(), 5);
    expect(limited).toMatchObject({ ok: false, limitHit: true, ops: 5 });
  });

  it('reporta erro de execução com a linha', () => {
    const src = `
box classificar(p, hist):
    return saida(p.cor)
`;
    const result = run(src, pulse({ cor: null }));
    expect(result).toMatchObject({ ok: false, line: 3 });
    if (!result.ok) expect(result.message).toContain('None');
  });

  it('bloqueia hist com o preço do recurso', () => {
    const src = `
box classificar(p, hist):
    let h = hist[0]
    return TERRA
`;
    const result = run(src);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Histórico (40 PP)');
  });

  it('rejeita retorno que não é destino e sugere saida()', () => {
    const src = `
box classificar(p, hist):
    return p.cor
`;
    const result = run(src);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('saida(RED)');
  });

  it('impede reatribuir const e parâmetros', () => {
    const constSrc = `
box classificar(p, hist):
    const a = 1
    a = 2
    return TERRA
`;
    expect(run(constSrc).ok).toBe(false);
    const paramSrc = `
box classificar(p, hist):
    p = 1
    return TERRA
`;
    expect(run(paramSrc).ok).toBe(false);
  });

  it('acusa função sem return', () => {
    const src = `
box classificar(p, hist):
    if p.porta == 9:
        return TERRA
`;
    expect(run(src)).toMatchObject({ ok: false });
  });
});

describe('DSL — compilação', () => {
  it('exige a assinatura fixa da caixa', () => {
    expect(compileError('box outra(p, hist):\n    return TERRA').message).toContain('classificar');
    expect(compileError('box classificar(p):\n    return TERRA').message).toContain('assinatura');
  });

  it('proíbe while e informa recursos bloqueados', () => {
    expect(compileError('box classificar(p, h):\n    while True:\n        pass').message).toContain('proibido');
    expect(compileError('box classificar(p, h):\n    for x in h:\n        pass').message).toContain('Laço (60 PP)');
    expect(compileError('box classificar(p, h):\n    let f = x => x\n    return TERRA').message).toContain('Funcional');
    expect(compileError('box classificar(p, h):\n    let s = h[1:]\n    return TERRA').message).toContain('Histórico');
  });

  it('aponta a linha do erro de sintaxe', () => {
    const error = compileError('box classificar(p, hist):\n    if p.cor == RED\n        return TERRA');
    expect(error.line).toBe(2);
  });

  it('detecta indentação inconsistente', () => {
    const error = compileError('box classificar(p, hist):\n    let a = 1\n  return TERRA');
    expect(error.message).toContain('indentação');
  });

  it('aceita comentários, tabs e expressões em várias linhas', () => {
    const src = 'box classificar(p, hist):  # comentário\n\tconst c = [RED,\n\t    BLUE]\n\treturn saida(c[1])';
    expect(run(src)).toMatchObject({ ok: true, decision: { kind: 'saida', cor: 'BLUE' } });
  });
});
