import { describe, expect, it } from 'vitest';
import { generateLayout, Grid } from '../src/game/board';
import { classify, compileFor, learn, predict, route, watch, type BoxContext, type BoxId } from '../src/game/boxes';
import { ALL_FEATURES } from '../src/dsl/errors';
import type { PulseView } from '../src/game/types';
import { Rng } from '../src/core/rng';

const pulse = (over: Partial<PulseView> = {}): PulseView => ({
  seq: 0,
  porta: 1,
  cor: 'RED',
  turno: 1,
  carga: 1,
  forma: 'CIRCULO',
  ...over,
});

function compile(box: BoxId, source: string) {
  const compiled = compileFor(box, source);
  if (!compiled.ok) throw new Error(`compilação falhou: ${compiled.error.message} (linha ${compiled.error.line})`);
  return compiled.box;
}

function run(source: string, p: PulseView = pulse(), hist: PulseView[] = [], limit = 120) {
  return classify(compile('classificar', source), p, hist, limit);
}

function compileError(source: string, box: BoxId = 'classificar') {
  const compiled = compileFor(box, source);
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
    expect(run(src, pulse({ cor: 'VIOLET' }))).toMatchObject({ ok: true, decision: { kind: 'saida', cor: 'VIOLET' } });
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

  it('lê carga, forma e o pulso anterior em hist', () => {
    const src = `
box classificar(p, hist):
    if p.carga == 3:
        return saida(WHITE)
    if len(hist) > 0 and hist[-1].forma == TRIANGULO:
        return saida(PINK)
    return MANUAL
`;
    expect(run(src, pulse({ carga: 3 }))).toMatchObject({ decision: { kind: 'saida', cor: 'WHITE' } });
    expect(run(src, pulse(), [pulse({ forma: 'TRIANGULO' })])).toMatchObject({ decision: { kind: 'saida', cor: 'PINK' } });
    expect(run(src, pulse(), [])).toMatchObject({ decision: { kind: 'manual' } });
  });

  it('percorre listas com for, break, continue, range e fatiamento', () => {
    const src = `
box classificar(p, hist):
    let quadrados = 0
    for h in hist[-4:]:
        if h.forma != QUADRADO:
            continue
        quadrados = quadrados + 1
    let primeiro = -1
    for i in range(10):
        if i * i > 20:
            primeiro = i
            break
    if quadrados == 2 and primeiro == 5:
        return TERRA
    return MANUAL
`;
    const hist = ['QUADRADO', 'CIRCULO', 'QUADRADO', 'TRIANGULO', 'CIRCULO'].map((forma, seq) =>
      pulse({ seq, forma: forma as PulseView['forma'] }),
    );
    // Os 4 últimos: CIRCULO, QUADRADO, TRIANGULO, CIRCULO → 1 quadrado.
    expect(run(src, pulse(), hist)).toMatchObject({ decision: { kind: 'manual' } });
    expect(run(src, pulse(), hist.slice(0, 4))).toMatchObject({ decision: { kind: 'terra' } });
  });

  it('suporta elif/else, instrução na mesma linha, and/or/not e soma de listas', () => {
    const src = `
box classificar(p, hist):
    const cores = [RED] + [BLUE, GREEN]
    if p.cor != None and not (p.cor == GRAY): return saida(p.cor)
    elif p.porta == 2 or p.porta == 3:
        return saida(cores[len(cores) - 1])
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

  it('conta operações, inclusive as voltas de laço, e para no limite', () => {
    const src = `
box classificar(p, hist):
    let a = 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1
    return TERRA
`;
    const ok = run(src);
    expect(ok.ok).toBe(true);
    expect(ok.ops).toBe(11); // 2 instruções (let, return) + 9 somas
    expect(run(src, pulse(), [], 5)).toMatchObject({ ok: false, limitHit: true, ops: 5 });

    const loop = `
box classificar(p, hist):
    for i in range(100):
        pass
    return TERRA
`;
    expect(run(loop)).toMatchObject({ ok: false, limitHit: true });
    expect(run('box classificar(p, hist):\n    let r = range(1000)\n    return TERRA').ok).toBe(false);
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

  it('rejeita retorno que não é destino e sugere saida()', () => {
    const result = run('box classificar(p, hist):\n    return p.cor');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('saida(RED)');
  });

  it('impede reatribuir const e parâmetros', () => {
    expect(run('box classificar(p, hist):\n    const a = 1\n    a = 2\n    return TERRA').ok).toBe(false);
    expect(run('box classificar(p, hist):\n    p = 1\n    return TERRA').ok).toBe(false);
  });

  it('acusa caixa sem return', () => {
    expect(run('box classificar(p, hist):\n    if p.porta == 9:\n        return TERRA')).toMatchObject({ ok: false });
  });
});

describe('DSL — Roteador', () => {
  const grid = new Grid(generateLayout(new Rng(3)));
  const dest = { kind: 'saida', cor: 'RED' } as const;

  it('recebe o relé e o destino e devolve uma direção', () => {
    const box = compile('rotear', `
box rotear(j, p, destino):
    if destino.linha < j.linha and j.norte:
        return NORTE
    if destino.linha > j.linha and j.sul:
        return SUL
    return LESTE
`);
    const destRow = grid.rowOf(dest);
    const row = destRow < 14 ? destRow + 1 : destRow - 1;
    const result = route(box, grid, row, 3, pulse(), 'LESTE', dest, () => false, 120);
    expect(result).toMatchObject({ ok: true, action: destRow < 14 ? 'NORTE' : 'SUL' });
    const same = route(box, grid, destRow, 3, pulse(), 'LESTE', dest, () => false, 120);
    expect(same).toMatchObject({ ok: true, action: 'LESTE' });
  });

  it('consulta o sensor ocupado e pode esperar', () => {
    const box = compile('rotear', `
box rotear(j, p, destino):
    if ocupado(j, LESTE):
        return ESPERAR
    return LESTE
`);
    expect(route(box, grid, 5, 3, pulse(), 'LESTE', null, (d: string) => d === 'LESTE', 120)).toMatchObject({ action: 'ESPERAR' });
    expect(route(box, grid, 5, 3, pulse(), 'LESTE', null, () => false, 120)).toMatchObject({ action: 'LESTE' });
  });

  it('recebe destino None quando o pulso não tem destino', () => {
    const box = compile('rotear', 'box rotear(j, p, destino):\n    if destino == None: return MANTER\n    return LESTE');
    expect(route(box, grid, 5, 3, pulse(), 'LESTE', null, () => false, 120)).toMatchObject({ action: 'MANTER' });
  });

  it('rejeita retorno que não é direção', () => {
    const box = compile('rotear', 'box rotear(j, p, destino):\n    return TERRA');
    const result = route(box, grid, 5, 3, pulse(), 'LESTE', null, () => false, 120);
    expect(result.ok).toBe(false);
  });

  it('ocupado só existe no Roteador e não pode ser redefinido', () => {
    expect(run('box classificar(p, hist):\n    if ocupado(p, NORTE): return TERRA\n    return MANUAL').ok).toBe(false);
    expect(compileFor('rotear', 'box rotear(j, p, ocupado):\n    return LESTE').ok).toBe(false);
    const box = compile('rotear', 'box rotear(j, p, destino):\n    let ocupado = 1\n    return LESTE');
    expect(route(box, grid, 5, 3, pulse(), 'LESTE', null, () => false, 120).ok).toBe(false);
  });
});

describe('DSL — compilação', () => {
  it('exige a assinatura fixa da caixa', () => {
    expect(compileError('box outra(p, hist):\n    return TERRA').message).toContain('classificar');
    expect(compileError('box classificar(p):\n    return TERRA').message).toContain('assinatura');
    expect(compileError('box rotear(j, p):\n    return LESTE', 'rotear').message).toContain('rotear(j, p, destino)');
  });

  it('proíbe while e informa recursos bloqueados', () => {
    expect(compileError('box classificar(p, h):\n    while True:\n        pass').message).toContain('proibido');
    expect(compileError('box classificar(p, h):\n    let f = x => x\n    return TERRA').message).toContain('Funcional');
    expect(compileError('box classificar(p, h):\n    match p:\n        pass').message).toContain('Casamento');
  });

  it('só aceita break e continue dentro de for', () => {
    expect(compileError('box classificar(p, h):\n    break').message).toContain('dentro de um "for"');
    expect(compileFor('classificar', 'box classificar(p, h):\n    for x in h: break\n    return TERRA').ok).toBe(true);
  });

  it('aponta a linha do erro de sintaxe', () => {
    expect(compileError('box classificar(p, hist):\n    if p.cor == RED\n        return TERRA').line).toBe(2);
  });

  it('detecta indentação inconsistente', () => {
    expect(compileError('box classificar(p, hist):\n    let a = 1\n  return TERRA').message).toContain('indentação');
  });

  it('aceita comentários, tabs e expressões em várias linhas', () => {
    const src = 'box classificar(p, hist):  # comentário\n\tconst c = [RED,\n\t    BLUE]\n\treturn saida(c[1])';
    expect(run(src)).toMatchObject({ ok: true, decision: { kind: 'saida', cor: 'BLUE' } });
  });
});

// ---- Recursos liberados pela pesquisa ----

describe('DSL — recursos desbloqueáveis', () => {
  const all = { features: ALL_FEATURES, mem: null };

  function runWith(source: string, p: PulseView = pulse(), hist: PulseView[] = [], ctx: BoxContext = all) {
    const compiled = compileFor('classificar', source, ctx.features);
    if (!compiled.ok) throw new Error(`compilação falhou: ${compiled.error.message} (linha ${compiled.error.line})`);
    return classify(compiled.box, p, hist, 120, ctx);
  }

  it('Funcional: lambdas com .filter, .map e .some', () => {
    const src = `
box classificar(p, hist):
    const quadrados = hist.filter(h => h.forma == QUADRADO)
    const portas = hist.map(h => h.porta)
    if len(quadrados) == 2 and portas[0] == 7 and hist.some(h => h.carga == 3):
        return TERRA
    return MANUAL
`;
    const hist = [pulse({ forma: 'QUADRADO', porta: 7 }), pulse({ forma: 'QUADRADO', carga: 3 }), pulse()];
    expect(runWith(src, pulse(), hist)).toMatchObject({ ok: true, decision: { kind: 'terra' } });
  });

  it('Funcional bloqueado: nem => nem métodos de lista', () => {
    expect(compileFor('classificar', 'box classificar(p, hist):\n    let f = x => x\n    return TERRA').ok).toBe(false);
    const result = run('box classificar(p, hist):\n    let l = hist.map(len)\n    return TERRA', pulse(), [pulse()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Funcional');
  });

  it('Casamento: match com vários valores por case e coringa', () => {
    const src = `
box classificar(p, hist):
    match p.forma:
        case CIRCULO, QUADRADO:
            return saida(RED)
        case _:
            return saida(BLUE)
`;
    expect(runWith(src, pulse({ forma: 'QUADRADO' }))).toMatchObject({ decision: { kind: 'saida', cor: 'RED' } });
    expect(runWith(src, pulse({ forma: 'TRIANGULO' }))).toMatchObject({ decision: { kind: 'saida', cor: 'BLUE' } });
  });

  it('Memória: mem é compartilhado entre chamadas e bloqueado sem pesquisa', () => {
    const mem = Array.from({ length: 8 }, () => null) as BoxContext['mem'];
    const ctx = { features: ALL_FEATURES, mem };
    const src = `
box classificar(p, hist):
    mem[0] = (mem[0] ?? 0) + 1
    if mem[0] == 3 and len(mem) == 8:
        return TERRA
    return MANUAL
`;
    expect(runWith(src, pulse(), [], ctx)).toMatchObject({ decision: { kind: 'manual' } });
    expect(runWith(src, pulse(), [], ctx)).toMatchObject({ decision: { kind: 'manual' } });
    expect(runWith(src, pulse(), [], ctx)).toMatchObject({ decision: { kind: 'terra' } });
    expect(mem![0]).toBe(3);
    const locked = compileFor('classificar', src);
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error.message).toContain('Memória');
  });

  it('atribuição por índice só em listas let', () => {
    expect(run('box classificar(p, hist):\n    let l = [1, 2]\n    l[1] = 5\n    if l[1] == 5: return TERRA\n    return MANUAL')).toMatchObject({
      decision: { kind: 'terra' },
    });
    expect(run('box classificar(p, hist):\n    const l = [1, 2]\n    l[0] = 5\n    return TERRA').ok).toBe(false);
    expect(run('box classificar(p, hist):\n    hist[0] = 5\n    return TERRA', pulse(), [pulse()]).ok).toBe(false);
  });

  it('Sensores avançados: dist e vizinhos no Roteador, e bloqueados sem pesquisa', () => {
    const grid = new Grid(generateLayout(new Rng(4)));
    const dest = { kind: 'saida', cor: 'RED' } as const;
    const row = grid.rowOf(dest) === 0 ? 5 : 0;
    const expected = grid.distanceToExit(row, 3, grid.rowOf(dest));
    const vias = grid.neighborRelays(row, 3).map((n) => n.via);
    const src = `
box rotear(j, p, destino):
    const vs = vizinhos(j)
    for v in vs:
        const d = dist(v, destino)
        if d == None:
            return ESPERAR
    if dist(j, destino) == ${expected} and len(vs) == ${vias.length}:
        return vs[0].via
    return MANTER
`;
    const compiled = compileFor('rotear', src, ALL_FEATURES);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const result = route(compiled.box, grid, row, 3, pulse(), 'LESTE', dest, () => false, 120, all);
    expect(result).toMatchObject({ ok: true, action: vias[0] });
    const locked = compileFor('rotear', src);
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error.message).toContain('Sensores avançados');
  });

  it('declarações valem só dentro do bloco, e cada volta do laço tem o seu', () => {
    const src = `
box classificar(p, hist):
    let total = 0
    for h in hist:
        const c = h.carga
        total = total + c
    if total == 6:
        const ok = True
    return TERRA
`;
    expect(run(src, pulse(), [pulse({ carga: 1 }), pulse({ carga: 2 }), pulse({ carga: 3 })])).toMatchObject({ ok: true });
    const leaked = run(`
box classificar(p, hist):
    if True:
        const x = 1
    if x == 1: return TERRA
    return MANUAL
`);
    expect(leaked.ok).toBe(false);
  });

  it('Previsor, Vigia e Aprendiz têm assinaturas próprias', () => {
    const prev = compileFor('prever', 'box prever(hist):\n    if len(hist) == 0: return None\n    return [RED, BLUE][(hist[-1].seq + 1) % 2]');
    expect(prev.ok).toBe(true);
    if (prev.ok) expect(predict(prev.box, [pulse({ seq: 4 })], 120)).toMatchObject({ ok: true, cor: 'BLUE' });

    const vig = compileFor('vigiar', 'box vigiar(evento, hist):\n    if evento.tipo == COLISAO or not evento.ok: return ALERTA\n    return None');
    expect(vig.ok).toBe(true);
    if (vig.ok) {
      const ev = { tipo: 'ENTREGA' as const, pulso: pulse(), ok: false, saida: 'BLUE' as const, terra: false, destino: 'RED' as const };
      expect(watch(vig.box, ev, [], 120)).toMatchObject({ ok: true, alert: true });
      expect(watch(vig.box, { ...ev, ok: true }, [], 120)).toMatchObject({ ok: true, alert: false });
    }

    const mem = Array.from({ length: 8 }, () => null) as BoxContext['mem'];
    const apr = compileFor('aprender', 'box ao_entregar(p, ok):\n    if not ok: mem[p.porta] = p.cor', ALL_FEATURES);
    expect(apr.ok).toBe(true);
    if (apr.ok) {
      expect(learn(apr.box, pulse({ porta: 2, cor: 'CYAN' }), false, 120, { features: ALL_FEATURES, mem })).toMatchObject({ ok: true });
      expect(mem![2]).toEqual({ t: 'cor', c: 'CYAN' });
    }
  });
});
