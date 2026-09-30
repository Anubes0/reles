import { describe, expect, it } from 'vitest';
import { COLORS, SHAPES } from '../src/core/colors';
import { Rng } from '../src/core/rng';
import { COLS, generateLayout, Grid, LAST_RELAY_COL, RELAY_COLS, ROWS, TERRA_ROW } from '../src/game/board';
import { runBench, verifyRouter } from '../src/game/bench';
import { classify, compileFor } from '../src/game/boxes';
import { Game, MAX_INTEGRITY } from '../src/game/engine';
import { levelParams, MODES, nextLevel } from '../src/game/mode';
import { TimeBank } from '../src/game/timebank';
import { colorFor, generateRule, KEY_VALUES, type Key, type Rule } from '../src/game/pattern';
import type { Pulse, PulseView } from '../src/game/types';
import { DEFAULT_SCRIPTS } from '../src/ui/defaults';

// ---- Utilitários ----

/** Escreve em DSL um Classificador que implementa a regra: prova que ela é expressável. */
function ruleToDsl(rule: Rule): string {
  const lines = [
    'box classificar(p, hist):',
    '    if p.cor == GRAY:',
    '        return TERRA',
    '    if p.cor != None:',
    '        return saida(p.cor)',
  ];
  for (const m of rule.mods) if (m.kind === 'ruido') lines.push(`    if p.seq % ${m.k} == ${m.r}:`, '        return TERRA');
  for (const m of rule.mods) {
    if (m.kind === 'fixa') lines.push(`    if p.${m.key} == ${m.value}:`, `        return saida(${m.cor})`);
  }
  const lookup = (expr: string, key: Key, colorExpr: (v: string) => string) => {
    for (const v of KEY_VALUES[key]) lines.push(`    if ${expr} == ${v}:`, `        return saida(${colorExpr(v)})`);
    lines.push('    return MANUAL');
  };
  const b = rule.base;
  switch (b.kind) {
    case 'ciclo':
      lines.push(`    return saida([${b.cycle.join(', ')}][p.seq % ${b.cycle.length}])`);
      break;
    case 'mapa':
      lookup(`p.${b.key}`, b.key, (v) => b.map[v]);
      break;
    case 'tabela':
      lookup(`p.${b.key}`, b.key, (v) => `[${b.table[v].join(', ')}][p.seq % ${b.n}]`);
      break;
    case 'anterior':
      lines.push('    if len(hist) == 0:', `        return saida(${b.map[KEY_VALUES[b.key][0]]})`);
      lookup(`hist[-1].${b.key}`, b.key, (v) => b.map[v]);
      break;
  }
  return lines.join('\n');
}

const ORACLE_ROUTER = `
box rotear(j, p, destino):
    if destino == None:
        return MANTER
    const ultima = j.coluna == 12
    const voltaria_norte = p.direcao == SUL and not ultima
    const voltaria_sul = p.direcao == NORTE and not ultima
    let want = MANTER
    if destino.linha < j.linha and j.norte and not voltaria_norte:
        want = NORTE
    elif destino.linha > j.linha and j.sul and not voltaria_sul:
        want = SUL
    elif j.leste and (not ultima or destino.linha == j.linha):
        want = LESTE
    elif j.norte and not voltaria_norte:
        want = NORTE
    elif j.sul and not voltaria_sul:
        want = SUL
    if want == MANTER:
        return MANTER
    if ocupado(j, want):
        if want != LESTE and not ultima and j.leste and not ocupado(j, LESTE):
            return LESTE
        return ESPERAR
    return want
`;

/** Partida sem pulsos nem fila, para montar cenários à mão. */
function emptyGame(seed = 1): Game {
  const game = new Game(seed);
  game.pulses = [];
  game.queue = [];
  return game;
}

let nextId = 5000;
function inject(game: Game, over: Partial<Pulse>): Pulse {
  const pulse: Pulse = {
    id: nextId++,
    seq: nextId,
    porta: 1,
    cor: 'RED',
    velado: false,
    carga: 1,
    forma: 'CIRCULO',
    spawnTurn: game.turn,
    row: 0,
    col: 0,
    dest: null,
    destBy: null,
    held: false,
    stalled: false,
    heading: 'LESTE',
    sintonizado: false,
    ...over,
  };
  game.pulses.push(pulse);
  return pulse;
}

// ---- Grade ----

describe('grade', () => {
  const grid = new Grid(generateLayout(new Rng(7)));

  it('tem 15×15, 10 portas, 10 saídas de cor e o terra no meio', () => {
    expect(ROWS).toBe(15);
    expect(COLS).toBe(15);
    expect(grid.layout.portRows).toHaveLength(10);
    expect(new Set(grid.layout.outputs.map((o) => o.cor)).size).toBe(COLORS.length);
    expect(grid.exitAt(TERRA_ROW)).toEqual({ kind: 'terra' });
    expect(grid.layout.outputs.some((o) => o.row === TERRA_ROW)).toBe(false);
  });

  it('relés só apontam para fios inteiros e, na última coluna, para linhas com saída', () => {
    expect(grid.canGo(0, 3, 'NORTE')).toBe(false);
    expect(grid.canGo(ROWS - 1, 3, 'SUL')).toBe(false);
    for (let row = 0; row < ROWS; row++) {
      expect(grid.canGo(row, LAST_RELAY_COL, 'LESTE')).toBe(grid.exitAt(row) !== null);
    }
    const copy = grid.clone();
    copy.broken.add('h:5:0');
    expect(copy.canGo(5, RELAY_COLS[0], 'LESTE')).toBe(false);
    expect(grid.canGo(5, RELAY_COLS[0], 'LESTE')).toBe(true);
  });

  it('gira o relé só entre as direções válidas', () => {
    const copy = grid.clone();
    copy.setDir(0, 3, 'LESTE');
    expect(copy.rotate(0, 3)).toBe('SUL');
    expect(copy.rotate(0, 3)).toBe('LESTE');
  });

  it('a mutação rompe fios sem tirar o caminho de nenhuma porta ativa', () => {
    const rng = new Rng(99);
    const copy = grid.clone();
    const ports = grid.layout.portRows;
    const exits = [TERRA_ROW, ...grid.layout.outputs.map((o) => o.row)];
    for (let i = 0; i < 30; i++) {
      const broken = copy.mutate(rng, 18, ports, exits, new Set());
      expect(broken).toBeGreaterThan(0);
      expect(copy.isPlayable(ports, exits)).toBe(true);
      for (let row = 0; row < ROWS; row++) {
        for (const col of RELAY_COLS) expect(copy.canGo(row, col, copy.dir(row, col))).toBe(true);
      }
    }
  });
});

// ---- Regras ----

describe('gerador de regras', () => {
  it('toda regra sorteada pode ser escrita na DSL e acerta os velados', () => {
    const rng = new Rng(2024);
    let previous: Rule | null = null;
    for (let level = 0; level <= 10; level++) {
      for (let k = 0; k < 8; k++) {
        const p = levelParams(level);
        const ports = Array.from({ length: p.ports }, (_, i) => i + 1);
        const rule = generateRule(rng, { ...p, previous, activePorts: ports });
        previous = rule;
        const compiled = compileFor('classificar', ruleToDsl(rule));
        expect(compiled.ok).toBe(true);
        if (!compiled.ok) continue;
        const hist: PulseView[] = [];
        for (let seq = 0; seq < 40; seq++) {
          const t = { seq, porta: rng.pick(ports), carga: rng.int(1, 3), forma: rng.pick(SHAPES) };
          const prev = hist[hist.length - 1] ?? null;
          const expected = colorFor(rule, t, prev);
          const view: PulseView = { ...t, cor: null, turno: 1 };
          const result = classify(compiled.box, view, hist.slice(-10), 120);
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.decision).toEqual(expected === 'GRAY' ? { kind: 'terra' } : { kind: 'saida', cor: expected });
          }
          hist.push(view);
        }
      }
    }
  });

  it('sempre gera uma regra diferente da anterior e com duas cores ou mais', () => {
    const rng = new Rng(7);
    let previous: Rule | null = null;
    for (let i = 0; i < 100; i++) {
      const p = levelParams(i % 11);
      const rule: Rule = generateRule(rng, { ...p, previous, activePorts: [1, 2, 3] });
      if (previous) expect(JSON.stringify(rule)).not.toBe(JSON.stringify(previous));
      previous = rule;
    }
  });
});

describe('diretor', () => {
  it('sobe acima de 85%, desce abaixo de 70% ou com perda de 3+ de integridade', () => {
    expect(nextLevel(1, { acertos: 9, erros: 1, perdidos: 0, integrityLost: 1 }, 10)).toBe(2);
    expect(nextLevel(1, { acertos: 6, erros: 4, perdidos: 0, integrityLost: 0 }, 10)).toBe(0);
    expect(nextLevel(1, { acertos: 9, erros: 1, perdidos: 0, integrityLost: 3 }, 10)).toBe(0);
    expect(nextLevel(10, { acertos: 10, erros: 0, perdidos: 0, integrityLost: 0 }, 10)).toBe(10);
  });

  it('abre portas, cores e fios rompidos conforme o nível sobe, até 10 portas e 10 cores', () => {
    expect(levelParams(0)).toMatchObject({ ports: 3, brokenWires: 0 });
    expect(levelParams(0).palette).toHaveLength(3);
    expect(levelParams(10)).toMatchObject({ ports: 10 });
    expect(levelParams(10).palette).toHaveLength(10);
    expect(levelParams(10).brokenWires).toBeGreaterThan(levelParams(4).brokenWires);
  });
});

// ---- Movimento ----

describe('movimento', () => {
  it('o pulso segue a seta do relé', () => {
    const game = emptyGame();
    game.grid.setDir(4, 3, 'SUL');
    const p = inject(game, { row: 4, col: 3 });
    game.endTurn();
    expect(p).toMatchObject({ row: 5, col: 3 });
  });

  it('dois pulsos entrando na mesma casa colidem e custam 1 de integridade cada', () => {
    const game = emptyGame();
    game.grid.setDir(4, 3, 'SUL');
    inject(game, { row: 4, col: 3 });
    inject(game, { row: 5, col: 2 });
    game.endTurn();
    expect(game.pulses).toHaveLength(0);
    expect(game.integrity).toBe(MAX_INTEGRITY - 2);
    expect(game.lastEvents).toContainEqual({ kind: 'colisao', row: 5, col: 3, count: 2 });
  });

  it('no barramento vertical, pulsos em sentidos opostos passam um pelo outro', () => {
    const game = emptyGame();
    game.grid.setDir(4, 3, 'SUL');
    game.grid.setDir(5, 3, 'NORTE');
    const down = inject(game, { row: 4, col: 3 });
    const up = inject(game, { row: 5, col: 3 });
    game.endTurn();
    expect(down).toMatchObject({ row: 5, col: 3 });
    expect(up).toMatchObject({ row: 4, col: 3 });
    expect(game.integrity).toBe(MAX_INTEGRITY);
  });

  it('quem vai para uma casa com pulso parado espera na fila', () => {
    const game = emptyGame();
    const front = inject(game, { row: 5, col: 3, held: true });
    const back = inject(game, { row: 5, col: 2 });
    game.endTurn();
    expect(game.pulses).toHaveLength(2);
    expect(front).toMatchObject({ row: 5, col: 3, stalled: true, held: false });
    expect(back).toMatchObject({ row: 5, col: 2, stalled: true });
    expect(game.integrity).toBe(MAX_INTEGRITY);
  });

  it('o Roteador decide a seta e pode mandar esperar', () => {
    const game = emptyGame();
    game.installScript('rotear', 'box rotear(j, p, destino):\n    if p.carga == 2: return ESPERAR\n    return SUL');
    const down = inject(game, { row: 4, col: 3, carga: 1 });
    const waiting = inject(game, { row: 9, col: 3, carga: 2 });
    game.endTurn();
    expect(down).toMatchObject({ row: 5, col: 3 });
    expect(game.grid.dir(4, 3)).toBe('SUL');
    expect(waiting).toMatchObject({ row: 9, col: 3, stalled: true });
  });

  it('entrega na saída certa pontua e na errada tira integridade', () => {
    const game = emptyGame();
    const red = game.grid.layout.outputs.find((o) => o.cor === 'RED')!.row;
    const blue = game.grid.layout.outputs.find((o) => o.cor === 'BLUE')!.row;
    inject(game, { row: red, col: COLS - 1, cor: 'RED' });
    inject(game, { row: blue, col: COLS - 1, cor: 'RED' });
    game.endTurn();
    expect(game.score).toBeGreaterThan(0);
    expect(game.totals).toMatchObject({ acertos: 1, erros: 1 });
    expect(game.integrity).toBe(MAX_INTEGRITY - 1);
  });

  it('sem destino na 2ª coluna de relés, o pulso vai para o terra', () => {
    const game = emptyGame();
    const p = inject(game, { row: 2, col: RELAY_COLS[1] });
    game.endTurn();
    expect(p.dest).toEqual({ kind: 'terra' });
    expect(p.destBy).toBe('auto');
  });

  it('quem fica tempo demais na grade queima, sem custar integridade', () => {
    const game = emptyGame();
    inject(game, { row: 2, col: 1, spawnTurn: game.turn - (game.mode.pulseLifetime - 1) });
    game.endTurn();
    expect(game.pulses).toHaveLength(0);
    expect(game.totals.perdidos).toBe(1);
    expect(game.integrity).toBe(MAX_INTEGRITY);
  });
});

// ---- Ações manuais ----

describe('ações manuais', () => {
  it('destino, segurar e girar relé custam uma ação cada, com limite por turno', () => {
    const game = emptyGame();
    const p = inject(game, { row: 2, col: 1 });
    expect(game.assign(p.id, { kind: 'terra' })).toEqual({ ok: true });
    expect(game.rotateRelay(2, 3)).toEqual({ ok: true });
    expect(game.actionsLeft).toBe(0);
    expect(game.hold(p.id).ok).toBe(false);
    expect(game.rotateRelay(3, 3).ok).toBe(false);
  });

  it('o destino só muda até o último relé', () => {
    const game = emptyGame();
    const p = inject(game, { row: 2, col: LAST_RELAY_COL + 1 });
    expect(game.assign(p.id, { kind: 'terra' }).ok).toBe(false);
  });
});

// ---- Partida ----

describe('partida', () => {
  it('é determinística a partir da semente', () => {
    const a = new Game(123);
    const b = new Game(123);
    for (let i = 0; i < 60; i++) {
      a.endTurn();
      b.endTurn();
    }
    expect(a.summary()).toEqual(b.summary());
    expect(a.log).toEqual(b.log);
  });

  it('contabiliza tudo o que sai da grade', () => {
    const game = new Game(1);
    for (let i = 0; i < 80 && !game.over; i++) game.endTurn();
    const { acertos, erros, perdidos } = game.totals;
    expect(acertos + erros + perdidos).toBeGreaterThan(0);
    expect(game.delivered.length).toBeLessThanOrEqual(acertos + erros + perdidos);
  });

  it('com Classificador e Roteador que conhecem a regra, o diretor sobe', () => {
    const game = new Game(42, undefined, { rotear: ORACLE_ROUTER });
    let rule = game.rule;
    game.installScript('classificar', ruleToDsl(rule));
    for (let i = 0; i < 200 && !game.over; i++) {
      game.endTurn();
      if (game.rule !== rule) {
        rule = game.rule;
        game.installScript('classificar', ruleToDsl(rule));
      }
    }
    expect(game.over).toBe(false);
    expect(game.maxLevel).toBeGreaterThanOrEqual(3);
    expect(game.precision).toBeGreaterThan(0.8);
  });

  it('a grade continua jogável depois de cada onda nos níveis altos', () => {
    const game = new Game(8);
    game.level = 9;
    game.queue = [];
    game.pulses = [];
    for (let wave = 0; wave < 12; wave++) {
      for (let t = 0; t < game.mode.waveLength; t++) game.endTurn();
      const ports = game.activePorts.map((p) => game.grid.portRow(p));
      expect(game.grid.isPlayable(ports, game.activeExitRows)).toBe(true);
      expect(new Set(game.grid.layout.outputs.map((o) => o.cor)).size).toBe(COLORS.length);
    }
    expect(game.grid.broken.size).toBeGreaterThan(0);
  });

  it('publica os eventos do turno e marca onde cada regime começa', () => {
    const game = new Game(21);
    game.integrity = 1_000_000; // sem scripts, os pulsos erram de saída: só queremos ver o regime mudar
    let deliveries = 0;
    for (let i = 0; i < 300 && game.regimeBoundaries.length === 0 && !game.over; i++) {
      game.endTurn();
      deliveries += game.lastEvents.filter((e) => e.kind === 'entrega').length;
    }
    expect(deliveries).toBeGreaterThan(0);
    const boundary = game.regimeBoundaries[0];
    expect(boundary).toBeGreaterThan(0);
    expect(game.queue.every((q) => q.seq >= boundary)).toBe(true);
  });

  it('os scripts da bagagem já valem para o primeiro pulso', () => {
    const game = new Game(11, undefined, { classificar: 'box classificar(p, hist):\n    return TERRA' });
    while (game.pulses.length === 0) game.endTurn();
    expect(game.pulses[0]).toMatchObject({ seq: 0, dest: { kind: 'terra' }, destBy: 'script' });
  });

  it('cada caixa instalada gasta energia por turno', () => {
    const game = new Game(3, undefined, { classificar: DEFAULT_SCRIPTS.classificar, rotear: DEFAULT_SCRIPTS.rotear });
    game.endTurn();
    expect(game.energyUsed).toBeGreaterThanOrEqual(2);
    expect(game.energyLeft).toBe(game.mode.energyPerTurn - game.energyUsed);
  });
});

// ---- Partida salva ----

describe('partida salva', () => {
  it('o diário refaz a partida igual: ações, scripts, pesquisa e turnos', () => {
    const game = new Game(77, MODES.medio, { rotear: ORACLE_ROUTER }, ['memoria', 'aprender']);
    expect(game.installScript('aprender', 'box ao_entregar(p, ok):\n    mem[0] = [p.cor, ok]').ok).toBe(true);
    for (let i = 0; i < 120 && !game.over; i++) {
      if (i === 30) game.unlock('prever');
      if (i === 31) game.installScript('prever', 'box prever(hist):\n    return RED');
      if (i === 60) game.removeScript('aprender');
      if (i % 20 === 0) game.installScript('classificar', ruleToDsl(game.rule));
      const pulse = game.pulses.find((p) => p.col <= LAST_RELAY_COL && p.dest);
      if (pulse && i % 3 === 0) game.assign(pulse.id, pulse.dest!);
      if (pulse && i % 7 === 0) game.hold(pulse.id);
      if (i % 5 === 0) game.rotateRelay(TERRA_ROW - 2, RELAY_COLS[0], 1);
      game.endTurn();
    }
    const kinds = new Set(game.journal.map((cmd) => cmd.c));
    expect([...kinds].sort()).toEqual(['aplicar', 'destino', 'girar', 'liberar', 'remover', 'segurar', 'turno']);
    const saved = JSON.parse(JSON.stringify({ start: game.start, journal: game.journal }));
    const copy = Game.replay(saved.start, saved.journal)!;
    expect(copy).not.toBeNull();
    expect(copy.summary()).toEqual(game.summary());
    expect(copy.integrity).toBe(game.integrity);
    expect(copy.pulses).toEqual(game.pulses);
    expect(copy.queue).toEqual(game.queue);
    expect(copy.log).toEqual(game.log);
    expect(copy.mem).toEqual(game.mem);
    expect(copy.journal).toEqual(game.journal);
    expect(Object.keys(copy.scripts).sort()).toEqual(Object.keys(game.scripts).sort());
  });

  it('turnos seguidos viram um só comando no diário', () => {
    const game = new Game(5);
    for (let i = 0; i < 30; i++) game.endTurn();
    expect(game.journal).toEqual([{ c: 'turno', n: 30 }]);
  });

  it('um diário que não se repete (outra versão do jogo) não é retomado', () => {
    const game = new Game(5);
    game.endTurn();
    expect(Game.replay(game.start, [...game.journal, { c: 'segurar', id: 9999 }])).toBeNull();
  });
});

// ---- Bancada ----

describe('bancada', () => {
  it('testa o Classificador contra pulsos que saíram, mantendo o véu e o hist', () => {
    const entered: PulseView[] = [
      { seq: 0, porta: 1, cor: null, turno: 1, carga: 1, forma: 'TRIANGULO' },
      { seq: 1, porta: 2, cor: null, turno: 2, carga: 2, forma: 'CIRCULO' },
    ];
    const cases = [
      { seq: 1, porta: 2, cor: 'PINK' as const, velado: true, carga: 2, forma: 'CIRCULO' as const, turno: 2, dest: null, outcome: 'perdido' as const },
    ];
    const src = 'box classificar(p, hist):\n    if hist[-1].forma == TRIANGULO: return saida(PINK)\n    return MANUAL';
    expect(runBench(src, cases, entered)).toMatchObject({ ok: true, passed: 1 });
  });

  it('verifica o Roteador padrão numa grade inteira: todas as rotas chegam', () => {
    const grid = new Grid(generateLayout(new Rng(5)));
    const result = verifyRouter(DEFAULT_SCRIPTS.rotear, grid, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], COLORS, 60);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.passed).toBe(result.checks.length);
  });

  it('a bancada roda com uma cópia do mem, listas internas inclusive', () => {
    const game = new Game(9, undefined, {}, ['memoria']);
    game.integrity = 1_000_000;
    while (game.delivered.length === 0) game.endTurn();
    game.mem![0] = [1, 2];
    const source = 'box classificar(p, hist):\n    let l = mem[0]\n    l[0] = 99\n    mem[1] = 5\n    return MANUAL';
    const result = runBench(source, game.delivered, game.entered, { features: game.features, mem: game.mem });
    expect(result.ok).toBe(true);
    expect(game.mem![0]).toEqual([1, 2]);
    expect(game.mem![1]).toBeNull();
  });

  it('aponta rotas que falham com fios rompidos', () => {
    const grid = new Grid(generateLayout(new Rng(5)));
    const ports = grid.layout.portRows;
    grid.mutate(new Rng(1), 20, ports, [TERRA_ROW, ...grid.layout.outputs.map((o) => o.row)], new Set());
    const naive = 'box rotear(j, p, destino):\n    return LESTE';
    const result = verifyRouter(naive, grid, [1, 2, 3], COLORS, 60);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.passed).toBeLessThan(result.checks.length);
  });
});

// ---- Modos, caixas novas e progressão ----

describe('modos', () => {
  it('o médio e o difícil velam mais e já começam com regras compostas', () => {
    expect(levelParams(0, MODES.facil).veiledChance).toBeCloseTo(0.25);
    expect(levelParams(0, MODES.medio).veiledChance).toBeCloseTo(0.45);
    expect(levelParams(10, MODES.dificil).veiledChance).toBeCloseTo(0.9);
    expect(levelParams(0, MODES.facil)).toMatchObject({ minMods: 0, maxMods: 0, keys: ['porta'] });
    expect(levelParams(0, MODES.dificil)).toMatchObject({ minMods: 2, keys: ['porta', 'carga', 'forma'] });
  });

  it('no difícil a regra tem pelo menos dois modificadores', () => {
    const game = new Game(31, MODES.dificil);
    expect(game.rule.mods.length).toBeGreaterThanOrEqual(2);
  });

  it('só o fácil anuncia a mudança de regime no registro', () => {
    for (const mode of [MODES.facil, MODES.dificil]) {
      const game = new Game(21, mode);
      game.integrity = 1_000_000;
      let regimes = 0;
      for (let i = 0; i < 200 && regimes === 0; i++) {
        game.endTurn();
        regimes += game.lastEvents.filter((e) => e.kind === 'regime').length;
      }
      expect(regimes).toBeGreaterThan(0);
      expect(game.log.some((l) => l.kind === 'regime')).toBe(mode.id === 'facil');
    }
  });

  it('no médio, as saídas apagam sem entregas recentes e acendem de novo quando recebem um pulso', () => {
    const game = new Game(5, MODES.medio);
    game.pulses = [];
    game.queue = [];
    const red = game.grid.layout.outputs.find((o) => o.cor === 'RED')!.row;
    expect(game.outputVisible(red)).toBe(true);
    for (let i = 0; i < MODES.medio.outputFade!; i++) game.endTurn();
    expect(game.outputVisible(red)).toBe(false);
    expect(game.outputVisible(TERRA_ROW)).toBe(true);
    inject(game, { row: red, col: COLS - 1, cor: 'RED' });
    game.endTurn();
    expect(game.outputVisible(red)).toBe(true);
  });
});

describe('pesquisa e caixas novas', () => {
  it('caixas bloqueadas não podem ser instaladas até a pesquisa', () => {
    const game = new Game(1);
    expect(game.installScript('prever', 'box prever(hist):\n    return None').ok).toBe(false);
    game.unlock('prever');
    expect(game.installScript('prever', 'box prever(hist):\n    return None').ok).toBe(true);
  });

  it('Previsor: acertar a cor do próximo pulso sintoniza e dobra os pontos', () => {
    const game = new Game(12, undefined, {}, ['prever']);
    game.installScript('prever', 'box prever(hist):\n    return RED');
    const spawned: Pulse[] = [];
    for (let i = 0; i < 60; i++) {
      game.endTurn();
      for (const p of game.pulses) if (!spawned.includes(p)) spawned.push(p);
    }
    expect(game.predictions.feitas).toBeGreaterThan(0);
    for (const p of spawned) if (p.sintonizado) expect(p.cor).toBe('RED');
    const tuned = spawned.filter((p) => p.sintonizado).length;
    expect(game.predictions.acertos).toBe(tuned);
    const events = game.log.filter((l) => l.text.includes('sintonizado'));
    expect(game.predictions.acertos === 0 || events.length > 0).toBe(true);
  });

  it('Vigia: um ALERTA vira evento do turno e entra no registro', () => {
    const game = new Game(4, undefined, {}, ['vigiar']);
    game.installScript('vigiar', 'box vigiar(evento, hist):\n    if not evento.ok: return ALERTA\n    return None');
    let alerted = false;
    for (let i = 0; i < 80 && !alerted && !game.over; i++) {
      game.endTurn();
      alerted = game.lastEvents.some((e) => e.kind === 'alerta');
    }
    expect(alerted).toBe(true);
    expect(game.log.some((l) => l.kind === 'alerta')).toBe(true);
  });

  it('Aprendiz e Memória: o que o Aprendiz grava o Classificador lê, e cada posição usada custa energia', () => {
    const game = new Game(6, undefined, {}, ['memoria', 'aprender']);
    game.installScript('aprender', 'box ao_entregar(p, ok):\n    mem[0] = (mem[0] ?? 0) + 1\n    mem[1] = p.cor');
    game.integrity = 1_000_000; // sem Roteador os pulsos erram de saída: só queremos ver o Aprendiz
    let delivered = 0;
    for (let i = 0; i < 60; i++) {
      game.endTurn();
      delivered += game.lastEvents.filter((e) => e.kind === 'entrega').length;
    }
    expect(delivered).toBeGreaterThan(0);
    expect(game.mem![0]).toBe(delivered);
    expect(game.memUsed).toBe(2);
    game.endTurn();
    // 1 por caixa instalada + 2 por posição ocupada, antes de qualquer chamada do turno.
    expect(game.energyUsed).toBeGreaterThanOrEqual(1 + 2 * 2);
  });

  it('eficiência: com scripts e entregas certas, a onda rende pontos extras', () => {
    const game = new Game(42, undefined, { rotear: ORACLE_ROUTER });
    game.installScript('classificar', ruleToDsl(game.rule));
    for (let i = 0; i < 45; i++) game.endTurn();
    expect(game.efficiencyPoints).toBeGreaterThan(0);
    expect(game.log.some((l) => l.text.startsWith('Eficiência da onda'))).toBe(true);
  });
});

describe('banco de tempo', () => {
  it('gasta, zera, passa para o automático e volta depois de recarregar', () => {
    const bank = new TimeBank({ startMs: 10_000, maxMs: 10_000, rechargeMs: 3000, resumeMs: 6000 });
    expect(bank.spend(4000)).toBe(false);
    expect(bank.remainingMs).toBe(6000);
    expect(bank.spend(9000)).toBe(true);
    expect(bank.auto).toBe(true);
    bank.turnEnded();
    expect(bank.auto).toBe(true);
    bank.turnEnded();
    expect(bank.remainingMs).toBe(6000);
    expect(bank.auto).toBe(false);
    bank.turnEnded();
    bank.turnEnded();
    expect(bank.remainingMs).toBe(10_000);
  });
});
