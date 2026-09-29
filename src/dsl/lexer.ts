import { DslError } from './errors';

export type TokenType = 'name' | 'number' | 'op' | 'keyword' | 'newline' | 'indent' | 'dedent' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

const KEYWORDS = new Set([
  'box', 'if', 'elif', 'else', 'return', 'let', 'const', 'pass',
  'and', 'or', 'not', 'True', 'False', 'None',
  // Reservadas: existem na linguagem, mas estão bloqueadas ou proibidas.
  'for', 'in', 'while', 'match', 'case', 'def', 'import',
]);

// Ordem importa: operadores mais longos primeiro.
const OPERATORS = ['=>', '==', '!=', '<=', '>=', '//', '??', '<', '>', '+', '-', '*', '%', '=', '(', ')', '[', ']', ',', ':', '.'];

const INDENT_WIDTH = 4;

/**
 * Converte o código em tokens, emitindo `indent`/`dedent` como o Python.
 * Dentro de parênteses/colchetes as quebras de linha são ignoradas.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const indentStack = [0];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].replace(/\t/g, ' '.repeat(INDENT_WIDTH));
    const content = stripComment(raw);
    if (content.trim() === '') continue;

    if (depth === 0) {
      const indent = content.length - content.trimStart().length;
      const current = indentStack[indentStack.length - 1];
      if (indent > current) {
        indentStack.push(indent);
        tokens.push({ type: 'indent', value: '', line: lineNo, col: 1 });
      } else {
        while (indent < indentStack[indentStack.length - 1]) {
          indentStack.pop();
          tokens.push({ type: 'dedent', value: '', line: lineNo, col: 1 });
        }
        if (indent !== indentStack[indentStack.length - 1]) {
          throw new DslError('indentação não bate com nenhum bloco anterior', lineNo, indent + 1);
        }
      }
    }

    let pos = content.length - content.trimStart().length;
    while (pos < content.length) {
      const ch = content[pos];
      const col = pos + 1;
      if (ch === ' ') {
        pos++;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        let end = pos;
        while (end < content.length && /[0-9]/.test(content[end])) end++;
        if (end < content.length && /[A-Za-z_]/.test(content[end])) {
          throw new DslError(`número inválido: "${content.slice(pos, end + 1)}"`, lineNo, col);
        }
        tokens.push({ type: 'number', value: content.slice(pos, end), line: lineNo, col });
        pos = end;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let end = pos;
        while (end < content.length && /[A-Za-z0-9_]/.test(content[end])) end++;
        const word = content.slice(pos, end);
        tokens.push({ type: KEYWORDS.has(word) ? 'keyword' : 'name', value: word, line: lineNo, col });
        pos = end;
        continue;
      }
      if (ch === '"' || ch === "'") {
        throw new DslError('textos (strings) não existem nesta linguagem', lineNo, col);
      }
      const op = OPERATORS.find((o) => content.startsWith(o, pos));
      if (!op) throw new DslError(`caractere inesperado: "${ch}"`, lineNo, col);
      if (op === '(' || op === '[') depth++;
      if (op === ')' || op === ']') depth = Math.max(0, depth - 1);
      tokens.push({ type: 'op', value: op, line: lineNo, col });
      pos += op.length;
    }

    if (depth === 0) tokens.push({ type: 'newline', value: '', line: lineNo, col: content.length + 1 });
  }

  const lastLine = lines.length;
  if (depth > 0) throw new DslError('parêntese ou colchete sem fechamento', lastLine, 1);
  while (indentStack.length > 1) {
    indentStack.pop();
    tokens.push({ type: 'dedent', value: '', line: lastLine, col: 1 });
  }
  tokens.push({ type: 'eof', value: '', line: lastLine, col: 1 });
  return tokens;
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trimEnd();
}
