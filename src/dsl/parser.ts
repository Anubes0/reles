import type { BinaryOp, BoxDef, Expr, MatchCase, Pos, Stmt } from './ast';
import { DslError, lockedMessage, NO_FEATURES, type Features } from './errors';
import { tokenize, type Token } from './lexer';

const COMPARISON_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/**
 * Lê o código de uma caixa: exatamente um `box nome(params):` com corpo indentado.
 * `features` diz quais construções bloqueáveis (`=>`, `match`) já foram liberadas.
 */
export function parseBox(source: string, features: Features = NO_FEATURES): BoxDef {
  return new Parser(tokenize(source), features).parseProgram();
}

class Parser {
  private pos = 0;
  private loopDepth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly features: Features,
  ) {}

  parseProgram(): BoxDef {
    if (this.peek().type === 'eof') throw this.error('o script está vazio: escreva um "box"', this.peek());
    const box = this.parseBox();
    if (this.peek().type !== 'eof') {
      throw this.error('só pode existir um "box" por script', this.peek());
    }
    return box;
  }

  private parseBox(): BoxDef {
    const start = this.peek();
    if (!this.isKeyword('box')) {
      if (this.isKeyword('def')) throw this.error('use "box" em vez de "def"', start);
      throw this.error('o script deve começar com "box nome(parâmetros):"', start);
    }
    this.advance();
    const name = this.expectName('nome da caixa').value;
    this.expectOp('(');
    const params: string[] = [];
    if (!this.isOp(')')) {
      do {
        params.push(this.expectName('nome do parâmetro').value);
      } while (this.matchOp(','));
    }
    this.expectOp(')');
    this.expectOp(':');
    const body = this.parseBlock();
    return { name, params, body, line: start.line, col: start.col };
  }

  /** Bloco após ":" — indentado em linhas próprias ou uma instrução simples na mesma linha. */
  private parseBlock(): Stmt[] {
    if (this.peek().type !== 'newline') {
      const stmt = this.parseSimpleStatement();
      this.expectNewline();
      return [stmt];
    }
    this.advance();
    if (this.peek().type !== 'indent') throw this.error('esperado um bloco indentado', this.peek());
    this.advance();
    const body: Stmt[] = [];
    while (this.peek().type !== 'dedent' && this.peek().type !== 'eof') {
      body.push(this.parseStatement());
    }
    if (this.peek().type === 'dedent') this.advance();
    return body;
  }

  private parseStatement(): Stmt {
    if (this.isKeyword('if')) return this.parseIf();
    if (this.isKeyword('for')) return this.parseFor();
    const tok = this.peek();
    if (this.isKeyword('match')) {
      if (!this.features.casamento) throw this.error(lockedMessage('casamento'), tok);
      return this.parseMatch();
    }
    if (this.isKeyword('case')) throw this.error('"case" sem "match" antes', tok);
    if (this.isKeyword('while')) throw this.error('"while" é proibido: use "for" sobre uma lista ou range()', tok);
    if (this.isKeyword('elif') || this.isKeyword('else')) throw this.error(`"${tok.value}" sem "if" antes`, tok);
    if (this.peek().type === 'indent') throw this.error('indentação inesperada', tok);
    const stmt = this.parseSimpleStatement();
    this.expectNewline();
    return stmt;
  }

  private parseSimpleStatement(): Stmt {
    const tok = this.peek();
    const pos: Pos = { line: tok.line, col: tok.col };
    if (this.isKeyword('return')) {
      this.advance();
      if (this.peek().type === 'newline') throw this.error('"return" precisa de um valor', tok);
      return { kind: 'return', value: this.parseExpression(), ...pos };
    }
    if (this.isKeyword('pass')) {
      this.advance();
      return { kind: 'pass', ...pos };
    }
    if (this.isKeyword('break') || this.isKeyword('continue')) {
      const word = this.advance().value as 'break' | 'continue';
      if (this.loopDepth === 0) throw this.error(`"${word}" só pode ser usado dentro de um "for"`, tok);
      return { kind: word, ...pos };
    }
    if (this.isKeyword('let') || this.isKeyword('const')) {
      const mutable = this.advance().value === 'let';
      const name = this.expectName('nome da variável').value;
      this.expectOp('=');
      return { kind: 'declare', mutable, name, value: this.parseExpression(), ...pos };
    }
    if (this.isKeyword('if') || this.isKeyword('for')) {
      throw this.error(`"${tok.value}" precisa começar em uma linha própria`, tok);
    }
    if (tok.type === 'name' && this.peekAt(1).type === 'op' && this.peekAt(1).value === '=') {
      this.advance();
      this.advance();
      return { kind: 'assign', name: tok.value, value: this.parseExpression(), ...pos };
    }
    const expr = this.parseExpression();
    if (this.isOp('=')) {
      if (expr.kind === 'index' && expr.object.kind === 'name') {
        this.advance();
        return { kind: 'assignIndex', name: expr.object.name, index: expr.index, value: this.parseExpression(), ...pos };
      }
      throw this.error('só é possível atribuir a uma variável ou a uma posição de lista (lista[i] = ...)', this.peek());
    }
    throw this.error('expressão solta não faz nada: use "return" ou "let"', { line: expr.line, col: expr.col });
  }

  private parseIf(): Stmt {
    const start = this.advance();
    const branches: { test: Expr; body: Stmt[] }[] = [];
    const test = this.parseExpression();
    this.expectOp(':');
    branches.push({ test, body: this.parseBlock() });
    let orElse: Stmt[] | null = null;
    while (this.isKeyword('elif')) {
      this.advance();
      const elifTest = this.parseExpression();
      this.expectOp(':');
      branches.push({ test: elifTest, body: this.parseBlock() });
    }
    if (this.isKeyword('else')) {
      this.advance();
      this.expectOp(':');
      orElse = this.parseBlock();
    }
    return { kind: 'if', branches, orElse, line: start.line, col: start.col };
  }

  private parseFor(): Stmt {
    const start = this.advance();
    const name = this.expectName('nome da variável do laço').value;
    if (!this.isKeyword('in')) throw this.error('esperado "in" depois da variável do laço', this.peek());
    this.advance();
    const iterable = this.parseExpression();
    this.expectOp(':');
    this.loopDepth++;
    try {
      return { kind: 'for', name, iterable, body: this.parseBlock(), line: start.line, col: start.col };
    } finally {
      this.loopDepth--;
    }
  }

  /** `match valor:` seguido de `case A, B:` (qualquer um deles) e `case _:` (qualquer outro). */
  private parseMatch(): Stmt {
    const start = this.advance();
    const subject = this.parseExpression();
    this.expectOp(':');
    if (this.peek().type !== 'newline') throw this.error('os "case" do "match" vêm nas linhas de baixo', this.peek());
    this.advance();
    if (this.peek().type !== 'indent') throw this.error('esperado um bloco indentado com "case"', this.peek());
    this.advance();
    const cases: MatchCase[] = [];
    while (this.peek().type !== 'dedent' && this.peek().type !== 'eof') {
      const tok = this.peek();
      if (!this.isKeyword('case')) throw this.error('dentro de "match" só entram linhas "case"', tok);
      this.advance();
      let patterns: Expr[] | null = [];
      if (this.peek().type === 'name' && this.peek().value === '_' && this.peekAt(1).value === ':') {
        this.advance();
        patterns = null;
      } else {
        do {
          patterns.push(this.parseExpression());
        } while (this.matchOp(','));
      }
      this.expectOp(':');
      cases.push({ patterns, body: this.parseBlock(), line: tok.line, col: tok.col });
    }
    if (this.peek().type === 'dedent') this.advance();
    if (cases.length === 0) throw this.error('"match" precisa de pelo menos um "case"', start);
    return { kind: 'match', subject, cases, line: start.line, col: start.col };
  }

  // ---- Expressões, da menor para a maior precedência ----

  private parseExpression(): Expr {
    return this.parseCoalesce();
  }

  private parseCoalesce(): Expr {
    let left = this.parseOr();
    while (this.isOp('??')) {
      const op = this.advance();
      left = this.binary('??', left, this.parseOr(), op);
    }
    return left;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKeyword('or')) {
      const op = this.advance();
      left = this.binary('or', left, this.parseAnd(), op);
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isKeyword('and')) {
      const op = this.advance();
      left = this.binary('and', left, this.parseNot(), op);
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.isKeyword('not')) {
      const op = this.advance();
      return { kind: 'unary', op: 'not', operand: this.parseNot(), line: op.line, col: op.col };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    if (this.peek().type === 'op' && COMPARISON_OPS.has(this.peek().value)) {
      const op = this.advance();
      const right = this.parseAdditive();
      if (this.peek().type === 'op' && COMPARISON_OPS.has(this.peek().value)) {
        throw this.error('comparações encadeadas não são permitidas: use "and"', this.peek());
      }
      return this.binary(op.value as BinaryOp, left, right, op);
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.advance();
      left = this.binary(op.value as BinaryOp, left, this.parseMultiplicative(), op);
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('//') || this.isOp('%')) {
      const op = this.advance();
      left = this.binary(op.value as BinaryOp, left, this.parseUnary(), op);
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp('-')) {
      const op = this.advance();
      return { kind: 'unary', op: '-', operand: this.parseUnary(), line: op.line, col: op.col };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      const tok = this.peek();
      if (this.matchOp('(')) {
        const args: Expr[] = [];
        if (!this.isOp(')')) {
          do {
            args.push(this.parseExpression());
          } while (this.matchOp(','));
        }
        this.expectOp(')');
        expr = { kind: 'call', callee: expr, args, line: tok.line, col: tok.col };
      } else if (this.matchOp('.')) {
        const property = this.expectName('nome do campo').value;
        expr = { kind: 'member', object: expr, property, line: tok.line, col: tok.col };
      } else if (this.matchOp('[')) {
        const start = this.isOp(':') ? null : this.parseExpression();
        if (this.matchOp(':')) {
          const end = this.isOp(']') ? null : this.parseExpression();
          this.expectOp(']');
          expr = { kind: 'slice', object: expr, start, end, line: tok.line, col: tok.col };
        } else {
          this.expectOp(']');
          expr = { kind: 'index', object: expr, index: start!, line: tok.line, col: tok.col };
        }
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    const pos: Pos = { line: tok.line, col: tok.col };
    if (tok.type === 'number') {
      this.advance();
      return { kind: 'number', value: Number(tok.value), ...pos };
    }
    if (tok.type === 'name') {
      this.advance();
      if (this.isOp('=>')) {
        if (!this.features.funcional) throw this.error(`"=>": ${lockedMessage('funcional')}`, this.peek());
        this.advance();
        return { kind: 'lambda', param: tok.value, body: this.parseExpression(), ...pos };
      }
      return { kind: 'name', name: tok.value, ...pos };
    }
    if (tok.type === 'keyword') {
      if (tok.value === 'True' || tok.value === 'False') {
        this.advance();
        return { kind: 'bool', value: tok.value === 'True', ...pos };
      }
      if (tok.value === 'None') {
        this.advance();
        return { kind: 'none', ...pos };
      }
    }
    if (this.matchOp('(')) {
      const inner = this.parseExpression();
      this.expectOp(')');
      return inner;
    }
    if (this.matchOp('[')) {
      const items: Expr[] = [];
      if (!this.isOp(']')) {
        do {
          items.push(this.parseExpression());
        } while (this.matchOp(','));
      }
      this.expectOp(']');
      return { kind: 'list', items, ...pos };
    }
    if (tok.type === 'newline' || tok.type === 'eof') throw this.error('esperado um valor', tok);
    throw this.error(`"${tok.value}" inesperado`, tok);
  }

  // ---- Utilitários ----

  private binary(op: BinaryOp, left: Expr, right: Expr, tok: Token): Expr {
    return { kind: 'binary', op, left, right, line: tok.line, col: tok.col };
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private peekAt(offset: number): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    if (tok.type !== 'eof') this.pos++;
    return tok;
  }

  private isOp(value: string): boolean {
    const tok = this.peek();
    return tok.type === 'op' && tok.value === value;
  }

  private isKeyword(value: string): boolean {
    const tok = this.peek();
    return tok.type === 'keyword' && tok.value === value;
  }

  private matchOp(value: string): boolean {
    if (!this.isOp(value)) return false;
    this.advance();
    return true;
  }

  private expectOp(value: string): Token {
    if (!this.isOp(value)) throw this.error(`esperado "${value}"`, this.peek());
    return this.advance();
  }

  private expectName(what: string): Token {
    const tok = this.peek();
    if (tok.type !== 'name') {
      const found = tok.type === 'keyword' ? `a palavra reservada "${tok.value}"` : 'outra coisa';
      throw this.error(`esperado ${what}, encontrado ${found}`, tok);
    }
    return this.advance();
  }

  private expectNewline(): void {
    const tok = this.peek();
    if (tok.type === 'newline') {
      this.advance();
      return;
    }
    if (tok.type === 'eof' || tok.type === 'dedent') return;
    throw this.error(`"${tok.value}" inesperado no fim da instrução`, tok);
  }

  private error(message: string, at: { line: number; col: number }): DslError {
    return new DslError(message, at.line, at.col);
  }
}
