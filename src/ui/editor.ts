import { compileClassifier } from '../game/classifier';

const INDENT = '    ';

export interface EditorCallbacks {
  onChange: (source: string) => void;
  onApply: () => void;
  onTest: () => void;
}

/** Editor do script: textarea com numeração de linhas, indentação por Tab e validação ao digitar. */
export class CodeEditor {
  private validateTimer = 0;
  private errorLine: number | null = null;

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly gutter: HTMLElement,
    private readonly message: HTMLElement,
    private readonly callbacks: EditorCallbacks,
  ) {
    textarea.addEventListener('input', () => this.changed());
    textarea.addEventListener('scroll', () => (gutter.scrollTop = textarea.scrollTop));
    textarea.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  get value(): string {
    return this.textarea.value;
  }

  set value(source: string) {
    this.textarea.value = source;
    this.renderGutter();
    this.validate();
  }

  /** Mostra uma mensagem de erro externa (ex.: ao aplicar) marcando a linha. */
  showError(text: string, line: number | null): void {
    this.errorLine = line;
    this.message.className = 'editor-msg error';
    this.message.textContent = line ? `Linha ${line}: ${text}` : text;
    this.renderGutter();
  }

  private changed(): void {
    this.renderGutter();
    window.clearTimeout(this.validateTimer);
    this.validateTimer = window.setTimeout(() => this.validate(), 250);
    this.callbacks.onChange(this.value);
  }

  private validate(): void {
    const result = compileClassifier(this.value);
    if (result.ok) {
      this.errorLine = null;
      this.message.className = 'editor-msg ok';
      this.message.textContent = 'Sintaxe ok.';
      this.renderGutter();
    } else {
      this.showError(result.error.message, result.error.line);
    }
  }

  private renderGutter(): void {
    const lines = this.value.split('\n').length;
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= lines; i++) {
      const span = document.createElement('span');
      span.textContent = `${i}\n`;
      if (i === this.errorLine) span.className = 'err';
      frag.append(span);
    }
    this.gutter.replaceChildren(frag);
    this.gutter.scrollTop = this.textarea.scrollTop;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey) this.callbacks.onTest();
      else this.callbacks.onApply();
      return;
    }
    if (e.key === 'Escape') {
      this.textarea.blur();
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
    const ta = this.textarea;
    const { selectionStart: start, selectionEnd: end, value } = ta;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    if (!outdent && start === end) {
      this.replaceRange(start, end, INDENT, start + INDENT.length);
      return;
    }
    const block = value.slice(lineStart, end);
    const lines = block.split('\n');
    const changed = lines.map((line) => (outdent ? line.replace(/^ {1,4}/, '') : INDENT + line)).join('\n');
    this.replaceRange(lineStart, end, changed, null);
    ta.selectionStart = lineStart;
    ta.selectionEnd = lineStart + changed.length;
  }

  /** Enter mantém a indentação da linha atual e acrescenta um nível depois de ":". */
  private newlineKeepingIndent(): void {
    const ta = this.textarea;
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
    const ta = this.textarea;
    ta.setSelectionRange(start, end);
    // insertText dispara o evento "input", que já chama changed().
    const inserted = text !== '' && document.execCommand('insertText', false, text);
    if (!inserted) {
      ta.setRangeText(text, start, end, 'end');
      this.changed();
    }
    if (caret !== null) ta.selectionStart = ta.selectionEnd = caret;
  }
}
