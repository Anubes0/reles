import { NO_FEATURES, type Features } from '../dsl/errors';
import { compileFor, signatureFor, type BoxId } from '../game/boxes';
import { el } from './dom';
import {
  BUILTINS,
  COLOR_WORDS,
  CONSTANTS,
  DEST_FIELDS,
  DIRECTIONS,
  EVENT_FIELDS,
  EVENT_WORDS,
  highlightLine,
  KEYWORDS,
  PULSE_FIELDS,
  RELAY_FIELDS,
  SHAPE_WORDS,
} from './highlight';

const INDENT = '    ';
const MAX_COMPLETIONS = 8;

const DETAILS: Record<string, string> = {
  cor: 'Cor, ou None se velado',
  porta: 'porta de entrada (1–10)',
  seq: 'nº de sequência do pulso',
  turno: 'turno em que entrou',
  carga: '1, 2 ou 3',
  forma: 'CIRCULO, QUADRADO ou TRIANGULO',
  linha: 'linha (0 = topo)',
  coluna: 'coluna do relé',
  norte: 'True se dá para ir ao norte',
  leste: 'True se dá para ir ao leste',
  sul: 'True se dá para ir ao sul',
  direcao: 'NORTE, LESTE ou SUL',
  terra: 'True se o destino é o terra',
  saida: 'saida(COR) → destino',
  len: 'len(lista) → tamanho',
  range: 'range(n) → [0, …, n−1]',
  ocupado: 'ocupado(j, DIR) → a casa vai estar ocupada?',
  vizinhos: 'vizinhos(j) → relés ao lado (com .via)',
  dist: 'dist(j, destino) → passos até a saída',
  via: 'direção que leva a este vizinho',
  tipo: 'ENTREGA, COLISAO ou QUEIMOU',
  pulso: 'o pulso, com a cor real',
  ok: 'True se foi acerto',
  destino: 'cor do destino que o pulso tinha',
  mem: 'memória compartilhada: mem[0] … mem[7]',
  ALERTA: 'pausa o jogo e avisa',
  match: 'match valor:',
  case: 'case A, B:',
  TERRA: 'destino: terra',
  MANUAL: 'deixa o pulso para você',
  None: 'ausência de valor',
  NORTE: 'direção',
  LESTE: 'direção',
  SUL: 'direção',
  ESPERAR: 'o pulso fica parado 1 turno',
  MANTER: 'o relé fica como está',
  GRAY: 'cor do ruído',
  let: 'variável',
  const: 'constante',
  for: 'for x in lista:',
};

export interface EditorElements {
  textarea: HTMLTextAreaElement;
  highlight: HTMLElement;
  gutter: HTMLElement;
  completions: HTMLElement;
  message: HTMLElement;
}

export interface EditorCallbacks {
  onChange: (source: string) => void;
  onApply: () => void;
  onTest: () => void;
}

interface Completion {
  label: string;
  insert: string;
  detail: string;
}

/**
 * Editor do script: textarea transparente sobre uma camada com realce de sintaxe,
 * numeração de linhas, erro marcado no ponto exato, indentação por Tab e autocompletar.
 */
export class CodeEditor {
  box: BoxId = 'classificar';
  /** Recursos liberados na pesquisa (valida o código e escolhe as sugestões). */
  features: Features = NO_FEATURES;
  private validateTimer = 0;
  private error: { line: number; col: number } | null = null;
  private completions: Completion[] = [];
  private activeCompletion = 0;
  private completionStart = 0;

  constructor(
    private readonly els: EditorElements,
    private readonly callbacks: EditorCallbacks,
  ) {
    const ta = els.textarea;
    ta.addEventListener('input', (e) => this.changed(e as InputEvent));
    ta.addEventListener('scroll', () => this.syncScroll());
    ta.addEventListener('keydown', (e) => this.onKeyDown(e));
    ta.addEventListener('blur', () => this.closeCompletions());
    ta.addEventListener('click', () => this.closeCompletions());
    // Clicar numa sugestão não pode tirar o foco do texto antes de aceitá-la.
    els.completions.addEventListener('mousedown', (e) => e.preventDefault());
  }

  get value(): string {
    return this.els.textarea.value;
  }

  /** Troca o conteúdo (ao abrir outra caixa, por exemplo) e valida na hora. */
  load(box: BoxId, source: string): void {
    this.box = box;
    this.els.textarea.value = source;
    this.els.textarea.scrollTop = 0;
    this.closeCompletions();
    this.validate();
  }

  focus(): void {
    this.els.textarea.focus();
  }

  /** Mostra uma mensagem de erro externa (ex.: ao aplicar), marcando linha e coluna. */
  showError(text: string, line: number | null, col = 1): void {
    this.error = line ? { line, col } : null;
    this.els.message.className = 'editor-msg error';
    this.els.message.textContent = line ? `Linha ${line}: ${text}` : text;
    this.render();
  }

  private changed(e?: InputEvent): void {
    this.render();
    window.clearTimeout(this.validateTimer);
    this.validateTimer = window.setTimeout(() => this.validate(), 250);
    this.callbacks.onChange(this.value);
    if (e?.inputType?.startsWith('insert')) this.updateCompletions();
    else this.closeCompletions();
  }

  private validate(): void {
    const result = compileFor(this.box, this.value, this.features);
    if (result.ok) {
      this.error = null;
      this.els.message.className = 'editor-msg ok';
      this.els.message.textContent = 'Sintaxe ok.';
      this.render();
    } else {
      this.showError(result.error.message, result.error.line, result.error.col);
    }
  }

  // ---- Camadas visuais ----

  private render(): void {
    const lines = this.value.split('\n');
    const gutter = document.createDocumentFragment();
    const code = document.createDocumentFragment();

    lines.forEach((line, i) => {
      const lineNo = i + 1;
      const isErr = this.error?.line === lineNo;
      gutter.append(el('span', { class: isErr ? 'err' : '' }, `${lineNo}\n`));

      const lineEl = el('span', { class: isErr ? 'line err-line' : 'line' });
      let col = 1;
      let marked = false;
      for (const span of highlightLine(line)) {
        const end = col + span.text.length;
        const hit = isErr && !marked && this.error!.col >= col && this.error!.col < end && span.text.trim() !== '';
        if (hit) marked = true;
        const cls = [span.cls, hit ? 'err-token' : ''].filter(Boolean).join(' ');
        lineEl.append(cls ? el('span', { class: cls }, span.text) : span.text);
        col = end;
      }
      if (isErr && !marked) lineEl.append(el('span', { class: 'err-token err-eol' }, ' '));
      code.append(lineEl, '\n');
    });
    // Espaço extra para a última linha ter a mesma altura que no textarea.
    code.append(' ');

    this.els.gutter.replaceChildren(gutter);
    this.els.highlight.replaceChildren(code);
    this.syncScroll();
  }

  private syncScroll(): void {
    const ta = this.els.textarea;
    this.els.highlight.scrollTop = ta.scrollTop;
    this.els.highlight.scrollLeft = ta.scrollLeft;
    this.els.gutter.scrollTop = ta.scrollTop;
    if (this.completions.length) this.positionCompletions();
  }

  // ---- Teclado ----

  private onKeyDown(e: KeyboardEvent): void {
    if (this.completions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        this.activeCompletion = (this.activeCompletion + step + this.completions.length) % this.completions.length;
        this.renderCompletions();
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        this.acceptCompletion(this.activeCompletion);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeCompletions();
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey) this.callbacks.onTest();
      else this.callbacks.onApply();
      return;
    }
    if (e.key === 'Escape') {
      this.els.textarea.blur();
      return;
    }
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      this.updateCompletions(true);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.indent(e.shiftKey);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.newlineKeepingIndent();
    }
  }

  private indent(outdent: boolean): void {
    const ta = this.els.textarea;
    const { selectionStart: start, selectionEnd: end, value } = ta;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    if (!outdent && start === end) {
      this.replaceRange(start, end, INDENT, start + INDENT.length);
      return;
    }
    const block = value.slice(lineStart, end);
    const changed = block
      .split('\n')
      .map((line) => (outdent ? line.replace(/^ {1,4}/, '') : INDENT + line))
      .join('\n');
    this.replaceRange(lineStart, end, changed, null);
    ta.selectionStart = lineStart;
    ta.selectionEnd = lineStart + changed.length;
  }

  /** Enter mantém a indentação da linha atual e acrescenta um nível depois de ":". */
  private newlineKeepingIndent(): void {
    const ta = this.els.textarea;
    const { selectionStart: start, value } = ta;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const line = value.slice(lineStart, start);
    let indent = /^ */.exec(line)?.[0] ?? '';
    if (line.replace(/#.*$/, '').trimEnd().endsWith(':')) indent += INDENT;
    const insert = `\n${indent}`;
    this.replaceRange(start, ta.selectionEnd, insert, start + insert.length);
  }

  /** Troca um trecho preservando o Ctrl+Z nativo quando o navegador permite. */
  private replaceRange(start: number, end: number, text: string, caret: number | null): void {
    const ta = this.els.textarea;
    ta.setSelectionRange(start, end);
    // insertText dispara o evento "input", que já chama changed().
    const inserted = text !== '' && document.execCommand('insertText', false, text);
    if (!inserted) {
      ta.setRangeText(text, start, end, 'end');
      this.changed();
    }
    if (caret !== null) ta.selectionStart = ta.selectionEnd = caret;
  }

  // ---- Autocompletar ----

  private updateCompletions(force = false): void {
    const ta = this.els.textarea;
    if (ta.selectionStart !== ta.selectionEnd) return this.closeCompletions();
    const caret = ta.selectionStart;
    const before = this.value.slice(0, caret);
    const prefix = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? '';
    const start = caret - prefix.length;
    const lineBefore = before.slice(before.lastIndexOf('\n') + 1);
    if (lineBefore.includes('#')) return this.closeCompletions();

    let candidates: Completion[];
    const beforeDot = before.slice(0, start);
    if (beforeDot.endsWith('.')) {
      const fields = this.fieldsFor(beforeDot.slice(0, -1));
      if (!fields) return this.closeCompletions();
      candidates = fields.map((f) => ({ label: f, insert: f, detail: DETAILS[f] ?? '' }));
    } else {
      if (prefix.length === 0 && !force) return this.closeCompletions();
      candidates = this.vocabulary();
    }

    const lower = prefix.toLowerCase();
    this.completions = candidates
      .filter((c) => c.label.toLowerCase().startsWith(lower) && c.label !== prefix)
      .slice(0, MAX_COMPLETIONS);
    this.completionStart = start;
    this.activeCompletion = 0;
    if (this.completions.length === 0) return this.closeCompletions();
    this.renderCompletions();
  }

  private params(): string[] {
    const declared = /box\s+\w+\s*\(([^)]*)\)/.exec(this.value)?.[1];
    const names = declared?.split(',').map((p) => p.trim()).filter(Boolean);
    return names?.length ? names : signatureFor(this.box).params;
  }

  /**
   * Campos do objeto antes do ponto: parâmetros da caixa, itens de `hist`,
   * `evento.pulso` e variáveis de laço sobre `hist` ou `vizinhos(j)`.
   */
  private fieldsFor(objectText: string): string[] | null {
    const params = this.params();
    const byParam: Record<BoxId, (string[] | null)[]> = {
      classificar: [PULSE_FIELDS, null],
      rotear: [RELAY_FIELDS, [...PULSE_FIELDS, 'direcao'], DEST_FIELDS],
      prever: [null],
      vigiar: [EVENT_FIELDS, null],
      aprender: [PULSE_FIELDS, null],
    };
    const histIndex: Partial<Record<BoxId, number>> = { classificar: 1, prever: 0, vigiar: 1 };
    const index = histIndex[this.box];
    const hist = index !== undefined ? params[index] : null;
    const histFields = this.box === 'vigiar' ? EVENT_FIELDS : PULSE_FIELDS;

    if (this.box === 'vigiar' && /\bpulso$/.test(objectText)) return PULSE_FIELDS;
    const name = /([A-Za-z_]\w*)$/.exec(objectText)?.[1];
    if (name) {
      const at = params.indexOf(name);
      if (at !== -1) return byParam[this.box][at] ?? null;
      if (hist && new RegExp(`for\\s+${name}\\s+in\\s+${hist}\\b`).test(this.value)) return histFields;
      if (new RegExp(`for\\s+${name}\\s+in\\s+vizinhos\\b`).test(this.value)) return [...RELAY_FIELDS, 'via'];
      return null;
    }
    if (hist && new RegExp(`\\b${hist}\\s*\\[[^\\]]*\\]$`).test(objectText)) return histFields;
    return null;
  }

  /** Palavras da linguagem desta caixa mais as variáveis e parâmetros do jogador. */
  private vocabulary(): Completion[] {
    const declared = new Set<string>(this.params());
    for (const m of this.value.matchAll(/\b(?:let|const)\s+([A-Za-z_]\w*)/g)) declared.add(m[1]);
    for (const m of this.value.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) declared.add(m[1]);

    const box = this.box;
    const router = box === 'rotear';
    const f = this.features;
    const word = (label: string, detail = DETAILS[label] ?? '') => ({ label, insert: label, detail });
    const builtins = BUILTINS.filter((b) => {
      if (b === 'saida') return box === 'classificar';
      if (b === 'ocupado') return router;
      if (b === 'vizinhos' || b === 'dist') return router && f.sensores;
      return true;
    });
    const keywords = KEYWORDS.filter((k) => (k === 'match' || k === 'case' ? f.casamento : true));
    const constants = box === 'classificar' ? CONSTANTS : CONSTANTS.filter((c) => !['TERRA', 'MANUAL'].includes(c));
    return [
      ...keywords.map((k) => word(k, DETAILS[k] ?? 'palavra-chave')),
      ...(router ? DIRECTIONS.map((d) => word(d)) : []),
      ...(box === 'vigiar' ? EVENT_WORDS.map((e) => word(e, DETAILS[e] ?? 'tipo de evento')) : []),
      ...COLOR_WORDS.map((c) => word(c, DETAILS[c] ?? 'cor')),
      ...SHAPE_WORDS.map((s) => word(s, 'forma')),
      ...constants.map((c) => word(c, DETAILS[c] ?? 'constante')),
      ...builtins.map((b) => ({ label: b, insert: `${b}(`, detail: DETAILS[b] ?? '' })),
      ...(f.memoria ? [word('mem')] : []),
      ...[...declared].map((d) => word(d, 'sua variável')),
    ];
  }

  private acceptCompletion(index: number): void {
    const item = this.completions[index];
    if (!item) return;
    const caret = this.els.textarea.selectionStart;
    this.closeCompletions();
    this.replaceRange(this.completionStart, caret, item.insert, this.completionStart + item.insert.length);
    this.closeCompletions();
  }

  private closeCompletions(): void {
    this.completions = [];
    this.els.completions.hidden = true;
  }

  private renderCompletions(): void {
    const list = this.els.completions;
    list.replaceChildren(
      ...this.completions.map((c, i) => {
        const item = el('li', { role: 'option', 'aria-selected': String(i === this.activeCompletion) },
          el('span', { class: 'cmp-label' }, c.label),
          el('span', { class: 'detail' }, c.detail),
        );
        item.addEventListener('click', () => this.acceptCompletion(i));
        return item;
      }),
    );
    list.hidden = false;
    this.positionCompletions();
  }

  /** A fonte é monoespaçada: a posição do cursor sai de linha × coluna. */
  private positionCompletions(): void {
    const ta = this.els.textarea;
    const style = getComputedStyle(ta);
    const lineHeight = parseFloat(style.lineHeight);
    // O atalho `font` do estilo computado pode vir vazio: monta a fonte pelas partes.
    const charWidth = measureChar(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`);
    const before = this.value.slice(0, this.completionStart);
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    const x = parseFloat(style.paddingLeft) + col * charWidth - ta.scrollLeft;
    const y = parseFloat(style.paddingTop) + (line + 1) * lineHeight - ta.scrollTop + 2;
    const list = this.els.completions;
    list.style.left = `${Math.max(4, Math.min(x, ta.clientWidth - list.offsetWidth - 4))}px`;
    list.style.top = `${y}px`;
  }
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measureChar(font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 8;
  measureCtx.font = font;
  return measureCtx.measureText('M').width;
}
