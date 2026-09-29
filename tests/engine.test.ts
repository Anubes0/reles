import { describe, expect, it } from 'vitest';
import { advance, COLS, DECISION_COL, OUTPUT_ROW } from '../src/game/board';
import { runBench } from '../src/game/bench';
import { Game, MAX_INTEGRITY } from '../src/game/engine';
import { nextLevel } from '../src/game/mode';
import { colorFor, describeRegime, generateRegime } from '../src/game/pattern';
import type { Pulse } from '../src/game/types';
import { Rng } from '../src/core/rng';

/** Script perfeito para um regime conhecido: usado para simular um jogador que acertou o padrão. */
const ORACLE = (game: Game) => {
  const r = game.regime;
  const colorExpr =
    r.kind === 'ciclo'
      ? `[${r.cycle.join(', ')}][p.seq % ${r.cycle.length}]`
      : `[None, ${r.map[1]}, ${r.map[2]}, ${r.map[3]}][p.porta]`;
  return `
box classificar(p, hist):
    if p.cor == GRAY:
        return TERRA
    return saida(p.cor ?? ${colorExpr})
`;
};

function makePulse(over: Partial<Pulse> = {}): Pulse {
  return {
    id: 1, seq: 0, porta: 1, cor: 'RED', velado: false, spawnTurn: 1,
    row: 1, col: 0, dest: null, destBy: null, ...over,
  };
}

describe('tabuleiro', () => {
  it('leva o pulso até a linha do destino e o entrega na borda direita', () => {
    const pulse = makePulse({ row: 3, dest: { kind: 'saida', cor: 'RED' } });
    let steps = 0;
    while (!advance(pulse)) steps++;
    expect(pulse.row).toBe(OUTPUT_ROW.RED);
    expect(pulse.col).toBe(COLS);
    // 2 passos até a decisão + 3 verticais + 3 até sair (o último não conta em steps)
    expect(steps).toBe(DECISION_COL + 3 + 2);
  });

  it('manda para o terra o pulso sem destino na coluna de decisão', () => {
    const pulse = makePulse({ col: DECISION_COL, row: 1 });
    advance(pulse);
    expect(pulse.dest).toEqual({ kind: 'terra' });
    expect(pulse.destBy).toBe('auto');
  });
});

describe('gerador de padrões', () => {
  it('sempre gera uma regra diferente da anterior e com duas cores ou mais', () => {
    const rng = new Rng(7);
    let previous = null;
    for (let i = 0; i < 200; i++) {
      const regime = generateRegime(rng, { palette: ['RED', 'GREEN', 'BLUE'], maxCycleLength: 3, previous });
      if (previous) expect(describeRegime(regime)).not.toBe(describeRegime(previous));
      const colors = regime.kind === 'ciclo' ? regime.cycle : Object.values(regime.map);
      expect(new Set(colors).size).toBeGreaterThanOrEqual(2);
      previous = regime;
    }
  });

  it('calcula a cor pela regra', () => {
    expect(colorFor({ kind: 'ciclo', cycle: ['RED', 'BLUE'] }, 3, 1)).toBe('BLUE');
    expect(colorFor({ kind: 'porta', map: { 1: 'RED', 2: 'GREEN', 3: 'BLUE' } }, 3, 2)).toBe('GREEN');
  });
});

describe('diretor', () => {
  it('sobe acima de 85%, desce abaixo de 70% ou com perda de 3+ de integridade', () => {
    expect(nextLevel(1, { acertos: 9, erros: 1, perdidos: 0, integrityLost: 1 }, 5)).toBe(2);
    expect(nextLevel(1, { acertos: 6, erros: 4, perdidos: 0, integrityLost: 0 }, 5)).toBe(0);
    expect(nextLevel(1, { acertos: 9, erros: 1, perdidos: 0, integrityLost: 3 }, 5)).toBe(0);
    expect(nextLevel(1, { acertos: 8, erros: 2, perdidos: 0, integrityLost: 2 }, 5)).toBe(1);
    expect(nextLevel(5, { acertos: 10, erros: 0, perdidos: 0, integrityLost: 0 }, 5)).toBe(5);
    expect(nextLevel(2, { acertos: 0, erros: 0, perdidos: 0, integrityLost: 0 }, 5)).toBe(2);
  });
});

describe('partida', () => {
  it('é determinística a partir da semente', () => {
    const a = new Game(123);
    const b = new Game(123);
    for (let i = 0; i < 40; i++) {
      a.endTurn();
      b.endTurn();
    }
    expect(a.summary()).toEqual(b.summary());
    expect(a.log).toEqual(b.log);
  });

  it('sem script nem ações, pulsos caem no terra e são perdidos sem dano', () => {
    const game = new Game(1);
    for (let i = 0; i < 30; i++) game.endTurn();
    expect(game.integrity).toBeGreaterThan(0);
    expect(game.totals.perdidos).toBeGreaterThan(0);
    expect(game.totals.erros).toBe(0);
  });

  it('um script que conhece a regra acerta tudo e o diretor sobe', () => {
    const game = new Game(42);
    let regimeSeen = game.regime;
    game.installScript(ORACLE(game));
    for (let i = 0; i < 120 && !game.over; i++) {
      game.endTurn();
      if (game.regime !== regimeSeen) {
        regimeSeen = game.regime;
        game.installScript(ORACLE(game));
      }
    }
    expect(game.over).toBe(false);
    expect(game.level).toBeGreaterThan(0);
    // Pulsos já na grade durante uma troca de regime podem ter sido classificados pela regra antiga.
    expect(game.precision).toBeGreaterThan(0.9);
  });

  it('a ação manual custa uma ação e respeita o limite do turno', () => {
    const game = new Game(5);
    while (game.pulses.length < 1) game.endTurn();
    const pulse = game.pulses[0];
    expect(game.assign(pulse.id, { kind: 'terra' })).toEqual({ ok: true });
    expect(game.assign(pulse.id, { kind: 'saida', cor: 'RED' })).toEqual({ ok: true });
    expect(game.actionsLeft).toBe(0);
    expect(game.assign(pulse.id, { kind: 'terra' }).ok).toBe(false);
    expect(pulse.destBy).toBe('manual');
  });

  it('enviar para a saída errada tira integridade até acabar a partida', () => {
    const game = new Game(9);
    game.installScript('box classificar(p, hist):\n    return saida(RED)');
    for (let i = 0; i < 400 && !game.over; i++) game.endTurn();
    expect(game.over).toBe(true);
    expect(game.integrity).toBe(0);
    expect(game.integrity).toBeLessThan(MAX_INTEGRITY);
  });

  it('publica os eventos do turno e marca onde cada regime começa', () => {
    const game = new Game(21);
    const kinds = new Set<string>();
    let deliveries = 0;
    for (let i = 0; i < 200 && game.regimeBoundaries.length === 0; i++) {
      game.endTurn();
      for (const e of game.lastEvents) {
        kinds.add(e.kind);
        if (e.kind === 'entrega') {
          deliveries++;
          expect(e.outcome).toBe(game.delivered.find((d) => d.seq === e.seq)?.outcome);
        }
      }
    }
    expect(deliveries).toBe(game.totals.acertos + game.totals.erros + game.totals.perdidos);
    expect(kinds.has('regime')).toBe(true);
    const boundary = game.regimeBoundaries[0];
    // Da fronteira em diante, os pulsos seguem a regra nova: a fila inteira já está nela.
    expect(boundary).toBeGreaterThan(0);
    expect(game.queue.every((q) => q.seq >= boundary)).toBe(true);
    for (const q of game.queue) {
      if (q.cor !== 'GRAY') expect(q.cor).toBe(colorFor(game.regime, q.seq, q.porta));
    }
  });

  it('o script da bagagem já classifica o primeiro pulso da partida', () => {
    const game = new Game(11, undefined, 'box classificar(p, hist):\n    return TERRA');
    expect(game.pulses.length).toBeGreaterThan(0);
    expect(game.pulses[0]).toMatchObject({ dest: { kind: 'terra' }, destBy: 'script' });
  });

  it('gasta energia por operação e cobra o chip por turno', () => {
    const game = new Game(3);
    game.installScript('box classificar(p, hist):\n    return MANUAL');
    game.endTurn();
    expect(game.energyUsed).toBeGreaterThanOrEqual(1);
    expect(game.energyLeft).toBe(game.mode.energyPerTurn - game.energyUsed);
  });
});

describe('bancada de testes', () => {
  it('confere o script contra pulsos revelados, mantendo o véu', () => {
    const cases = [
      { seq: 0, porta: 1, cor: 'RED' as const, velado: true, turno: 1, dest: { kind: 'terra' as const }, outcome: 'perdido' as const },
      { seq: 1, porta: 2, cor: 'GRAY' as const, velado: false, turno: 2, dest: { kind: 'terra' as const }, outcome: 'acerto' as const },
    ];
    const result = runBench('box classificar(p, hist):\n    if p.cor == GRAY: return TERRA\n    return saida(p.cor ?? RED)', cases);
    expect(result).toMatchObject({ ok: true, passed: 2 });
    const failing = runBench('box classificar(p, hist):\n    return saida(p.cor)', cases);
    expect(failing).toMatchObject({ ok: true, passed: 0 });
  });
});
