import { COLORS } from '../core/colors';

/**
 * Realce de sintaxe só para exibição. Diferente do lexer da DSL, nunca falha:
 * precisa colorir código incompleto enquanto o jogador digita.
 */

export const KEYWORDS = ['box', 'if', 'elif', 'else', 'for', 'in', 'break', 'continue', 'match', 'case', 'return', 'let', 'const', 'pass', 'and', 'or', 'not'];
export const LOCKED_WORDS = ['while', 'def', 'import'];
export const CONSTANTS = ['TERRA', 'MANUAL', 'None', 'True', 'False'];
export const DIRECTIONS = ['NORTE', 'LESTE', 'SUL', 'ESPERAR', 'MANTER'];
export const SHAPE_WORDS = ['CIRCULO', 'QUADRADO', 'TRIANGULO'];
export const EVENT_WORDS = ['ENTREGA', 'COLISAO', 'QUEIMOU', 'ALERTA'];
export const BUILTINS = ['saida', 'len', 'range', 'ocupado', 'vizinhos', 'dist'];
export const COLOR_WORDS: readonly string[] = [...COLORS, 'GRAY'];

export const PULSE_FIELDS = ['cor', 'porta', 'seq', 'turno', 'carga', 'forma'];
export const RELAY_FIELDS = ['linha', 'coluna', 'norte', 'leste', 'sul', 'direcao'];
export const DEST_FIELDS = ['linha', 'cor', 'terra'];
export const EVENT_FIELDS = ['tipo', 'pulso', 'ok', 'saida', 'terra', 'destino'];

export interface Span {
  text: string;
  cls: string;
}

const TOKEN = /(#.*$)|(\d+)|([A-Za-z_]\w*)|(\?\?|==|!=|<=|>=|\/\/|=>|[-+*%<>=])|(\s+)|(.)/g;

export function highlightLine(line: string): Span[] {
  const spans: Span[] = [];
  let prev = '';
  for (const m of line.matchAll(TOKEN)) {
    const [text, comment, num, word, op] = m;
    let cls = '';
    if (comment) cls = 'c-comment';
    else if (num) cls = 'c-num';
    else if (word) cls = wordClass(word, prev === '.');
    else if (op) cls = 'c-op';
    spans.push({ text, cls });
    if (!/^\s+$/.test(text)) prev = text;
  }
  return spans;
}

function wordClass(word: string, afterDot: boolean): string {
  if (afterDot) return 'c-field';
  if (KEYWORDS.includes(word)) return 'c-kw';
  if (LOCKED_WORDS.includes(word)) return 'c-locked';
  if (COLOR_WORDS.includes(word)) return `c-color c-${word}`;
  if (DIRECTIONS.includes(word)) return 'c-dir';
  if (SHAPE_WORDS.includes(word) || EVENT_WORDS.includes(word)) return 'c-shape';
  if (CONSTANTS.includes(word)) return 'c-const';
  if (BUILTINS.includes(word)) return 'c-fn';
  if (word === 'mem') return 'c-mem';
  return 'c-ident';
}
