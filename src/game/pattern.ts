import { SHAPES, type Color, type PulseColor, type Shape } from '../core/colors';
import type { Rng } from '../core/rng';
import { MAX_PORTS } from './board';

/**
 * Regra oculta de um regime: uma peça-base que dá a cor, mais modificadores que a
 * sobrepõem. Tudo depende só do que o jogador vê (seq, porta, carga, forma e o pulso
 * anterior), então todo pulso velado pode ser deduzido e escrito na DSL.
 */
export type Key = 'porta' | 'carga' | 'forma';

export type Base =
  | { kind: 'ciclo'; cycle: Color[] }
  | { kind: 'mapa'; key: Key; map: Record<string, Color> }
  | { kind: 'tabela'; key: Key; n: number; table: Record<string, Color[]> }
  | { kind: 'anterior'; key: Key; map: Record<string, Color> };

export type Modifier =
  | { kind: 'ruido'; k: number; r: number }
  | { kind: 'fixa'; key: Key; value: string; cor: Color };

export interface Rule {
  base: Base;
  mods: Modifier[];
}

/** Atributos que a regra enxerga. */
export interface Traits {
  seq: number;
  porta: number;
  carga: number;
  forma: Shape;
}

export const KEY_VALUES: Record<Key, string[]> = {
  porta: Array.from({ length: MAX_PORTS }, (_, i) => String(i + 1)),
  carga: ['1', '2', '3'],
  forma: [...SHAPES],
};

function keyOf(t: Traits, key: Key): string {
  return String(t[key]);
}

/** Cor que a regra dá a um pulso. `prev` é o pulso de `seq - 1` (ou `null` no primeiro). */
export function colorFor(rule: Rule, t: Traits, prev: Traits | null): PulseColor {
  for (const mod of rule.mods) {
    if (mod.kind === 'ruido' && t.seq % mod.k === mod.r) return 'GRAY';
  }
  for (const mod of rule.mods) {
    if (mod.kind === 'fixa' && keyOf(t, mod.key) === mod.value) return mod.cor;
  }
  const base = rule.base;
  switch (base.kind) {
    case 'ciclo':
      return base.cycle[t.seq % base.cycle.length];
    case 'mapa':
      return base.map[keyOf(t, base.key)];
    case 'tabela':
      return base.table[keyOf(t, base.key)][t.seq % base.n];
    case 'anterior':
      return base.map[prev ? keyOf(prev, base.key) : KEY_VALUES[base.key][0]];
  }
}

/** A regra usa o pulso anterior (precisa de `hist` para ser escrita). */
export function usesHistory(rule: Rule): boolean {
  return rule.base.kind === 'anterior';
}

const KEY_LABEL: Record<Key, string> = { porta: 'porta', carga: 'carga', forma: 'forma' };

function describeMap(key: Key, map: Record<string, Color>, activeValues?: string[]): string {
  const values = key === 'porta' && activeValues ? activeValues : KEY_VALUES[key];
  return values.map((v) => `${v}→${map[v]}`).join(', ');
}

export function describeRule(rule: Rule, activePorts?: number[]): string {
  const ports = activePorts?.map(String);
  const b = rule.base;
  let text: string;
  switch (b.kind) {
    case 'ciclo':
      text = `Ciclo de ${b.cycle.length}: ${b.cycle.join(', ')} (cor = ciclo[seq % ${b.cycle.length}])`;
      break;
    case 'mapa':
      text = `Por ${KEY_LABEL[b.key]}: ${describeMap(b.key, b.map, ports)}`;
      break;
    case 'tabela': {
      const values = b.key === 'porta' && ports ? ports : KEY_VALUES[b.key];
      text = `Tabela por ${KEY_LABEL[b.key]} × seq % ${b.n}: ${values.map((v) => `${v}→[${b.table[v].join(', ')}]`).join(', ')}`;
      break;
    }
    case 'anterior':
      text = `Pela ${KEY_LABEL[b.key]} do pulso anterior: ${describeMap(b.key, b.map, ports)}`;
      break;
  }
  const mods = rule.mods.map((m) =>
    m.kind === 'ruido' ? `ruído quando seq % ${m.k} == ${m.r}` : `${KEY_LABEL[m.key]} ${m.value} → ${m.cor}`,
  );
  return [text, ...mods].join(' · ');
}

export interface RuleOptions {
  palette: readonly Color[];
  maxCycleLength: number;
  bases: Base['kind'][];
  keys: Key[];
  maxMods: number;
  previous: Rule | null;
  activePorts: number[];
}

/** Sorteia uma regra nova, garantindo que ela difira da anterior e use ao menos duas cores. */
export function generateRule(rng: Rng, options: RuleOptions): Rule {
  const previous = options.previous ? describeRule(options.previous) : null;
  for (;;) {
    const base = generateBase(rng, options);
    const mods: Modifier[] = [];
    const modCount = options.maxMods > 0 ? rng.int(0, options.maxMods) : 0;
    for (let i = 0; i < modCount; i++) {
      const mod = generateModifier(rng, options, base, mods);
      if (mod) mods.push(mod);
    }
    const rule = { base, mods };
    if (describeRule(rule) !== previous && distinctColors(rule, options.activePorts) >= 2) return rule;
  }
}

function generateBase(rng: Rng, o: RuleOptions): Base {
  const kind = rng.pick(o.bases);
  const key = rng.pick(o.keys);
  const pick = () => rng.pick(o.palette);
  const mapOf = () => Object.fromEntries(KEY_VALUES[key].map((v) => [v, pick()]));
  switch (kind) {
    case 'ciclo':
      return { kind, cycle: Array.from({ length: rng.int(2, Math.max(2, o.maxCycleLength)) }, pick) };
    case 'mapa':
      return { kind, key, map: mapOf() };
    case 'tabela': {
      const n = rng.int(2, 3);
      return { kind, key, n, table: Object.fromEntries(KEY_VALUES[key].map((v) => [v, Array.from({ length: n }, pick)])) };
    }
    case 'anterior':
      return { kind, key, map: mapOf() };
  }
}

function generateModifier(rng: Rng, o: RuleOptions, base: Base, mods: Modifier[]): Modifier | null {
  if (!mods.some((m) => m.kind === 'ruido') && rng.chance(0.4)) {
    const k = rng.int(4, 7);
    return { kind: 'ruido', k, r: rng.int(0, k - 1) };
  }
  // Um modificador por atributo, e nunca sobre o atributo que já define a base.
  const baseKey = base.kind === 'ciclo' ? null : base.key;
  const keys = o.keys.filter((k) => k !== baseKey && !mods.some((m) => m.kind === 'fixa' && m.key === k));
  if (keys.length === 0) return null;
  const key = rng.pick(keys);
  const values = key === 'porta' ? o.activePorts.map(String) : KEY_VALUES[key];
  return { kind: 'fixa', key, value: rng.pick(values), cor: rng.pick(o.palette) };
}

/** Quantas cores diferentes a regra produz nas portas ativas (para o padrão ter o que descobrir). */
function distinctColors(rule: Rule, activePorts: number[]): number {
  const seen = new Set<PulseColor>();
  for (let seq = 0; seq < 60; seq++) {
    for (const porta of activePorts) {
      for (const carga of [1, 2, 3]) {
        for (const forma of SHAPES) {
          const t = { seq, porta, carga, forma };
          const prev = { seq: seq - 1, porta: activePorts[(seq + 1) % activePorts.length], carga: ((seq + 2) % 3) + 1, forma: SHAPES[seq % 3] };
          const c = colorFor(rule, t, seq === 0 ? null : prev);
          if (c !== 'GRAY') seen.add(c);
        }
      }
    }
  }
  return seen.size;
}
