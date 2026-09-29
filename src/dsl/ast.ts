export interface Pos {
  line: number;
  col: number;
}

export type Expr =
  | ({ kind: 'number'; value: number } & Pos)
  | ({ kind: 'bool'; value: boolean } & Pos)
  | ({ kind: 'none' } & Pos)
  | ({ kind: 'name'; name: string } & Pos)
  | ({ kind: 'list'; items: Expr[] } & Pos)
  | ({ kind: 'unary'; op: '-' | 'not'; operand: Expr } & Pos)
  | ({ kind: 'binary'; op: BinaryOp; left: Expr; right: Expr } & Pos)
  | ({ kind: 'call'; callee: Expr; args: Expr[] } & Pos)
  | ({ kind: 'member'; object: Expr; property: string } & Pos)
  | ({ kind: 'index'; object: Expr; index: Expr } & Pos)
  | ({ kind: 'slice'; object: Expr; start: Expr | null; end: Expr | null } & Pos);

export type BinaryOp =
  | '+' | '-' | '*' | '//' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or' | '??';

export type Stmt =
  | ({ kind: 'declare'; mutable: boolean; name: string; value: Expr } & Pos)
  | ({ kind: 'assign'; name: string; value: Expr } & Pos)
  | ({ kind: 'if'; branches: { test: Expr; body: Stmt[] }[]; orElse: Stmt[] | null } & Pos)
  | ({ kind: 'for'; name: string; iterable: Expr; body: Stmt[] } & Pos)
  | ({ kind: 'break' } & Pos)
  | ({ kind: 'continue' } & Pos)
  | ({ kind: 'return'; value: Expr } & Pos)
  | ({ kind: 'pass' } & Pos);

export interface BoxDef extends Pos {
  name: string;
  params: string[];
  body: Stmt[];
}
