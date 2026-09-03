export function selectedTextOrCurrentLine(documentText: string, selectionText: string, cursorLine: number): string {
  if (selectionText.length > 0) {
    return selectionText;
  }

  const lines = documentText.split(/\r?\n/);
  if (lines.length === 0) {
    return '';
  }

  const clampedLine = Math.min(Math.max(cursorLine, 0), lines.length - 1);
  return lines[clampedLine] || '';
}

export function qSelectionExecutionKind(selectionText: string): 'query' | 'script' {
  return /[\r\n]/.test(selectionText) ? 'script' : 'query';
}

export function selectedTextOrCurrentBlock(documentText: string, selectionText: string, cursorLine: number): string {
  return selectionText.length > 0 ? selectionText : currentQBlock(documentText, cursorLine);
}

export function currentQBlock(documentText: string, cursorLine: number): string {
  const lines = documentText.split(/\r?\n/);
  if (lines.length === 0) return '';
  const line = Math.min(Math.max(cursorLine, 0), lines.length - 1);
  if (lines[line].trim().length === 0) return '';
  let start = line;
  let end = line;
  while (start > 0 && lines[start - 1].trim().length > 0) start -= 1;
  while (end < lines.length - 1 && lines[end + 1].trim().length > 0) end += 1;
  return lines.slice(start, end + 1).join('\n');
}

export type QTextTokenKind =
  | 'plain'
  | 'comment'
  | 'command'
  | 'system'
  | 'namespace'
  | 'string'
  | 'symbol'
  | 'temporal'
  | 'number'
  | 'keyword'
  | 'builtin'
  | 'operator';

export interface QTextToken {
  readonly kind: QTextTokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface QTextLexResult {
  readonly tokens: readonly QTextToken[];
  readonly valid: boolean;
}

export interface QTextDisplayFormatResult {
  readonly text: string;
  readonly applied: boolean;
}

export interface QTextRenderSegment {
  readonly kind: QTextTokenKind;
  readonly text: string;
}

export interface QTextRenderModel {
  readonly text: string;
  readonly formatted: boolean;
  readonly highlighted: boolean;
  readonly segments: readonly QTextRenderSegment[];
}

export interface QTextRenderOptions {
  readonly syntaxHighlighting: boolean;
  readonly displayFormatting: boolean;
}

const Q_KEYWORDS = new Set([
  'boolean', 'by', 'byte', 'char', 'date', 'datetime', 'delete', 'do', 'exec', 'fby', 'float',
  'from', 'if', 'int', 'long', 'minute', 'month', 'real', 'second', 'select', 'short', 'string',
  'symbol', 'time', 'timespan', 'timestamp', 'update', 'where', 'while',
]);

const Q_BUILTINS = new Set([
  'abs', 'acos', 'aj', 'aj0', 'all', 'and', 'any', 'asc', 'asin', 'asof', 'atan', 'attr', 'avg',
  'avgs', 'bin', 'binr', 'ceiling', 'cols', 'cor', 'cos', 'count', 'cov', 'cross', 'csv', 'cut',
  'deltas', 'desc', 'dev', 'differ', 'distinct', 'div', 'dsave', 'each', 'ej', 'enlist', 'eval',
  'except', 'exit', 'exp', 'fills', 'first', 'fkeys', 'flip', 'floor', 'get', 'group', 'gtime',
  'hclose', 'hcount', 'hdel', 'hopen', 'hsym', 'iasc', 'idesc', 'ij', 'ijf', 'in', 'inter', 'inv',
  'key', 'keys', 'last', 'like', 'lj', 'ljf', 'load', 'log', 'lower', 'lsq', 'ltrim', 'mavg',
  'max', 'maxs', 'mcount', 'md5', 'mdev', 'med', 'meta', 'min', 'mins', 'msum', 'neg', 'next',
  'not', 'null', 'or', 'over', 'parse', 'peach', 'pj', 'prd', 'prds', 'prev', 'prior', 'rand',
  'rank', 'ratios', 'raze', 'read0', 'read1', 'reciprocal', 'reval', 'reverse', 'rload', 'rotate',
  'rsave', 'save', 'scan', 'set', 'show', 'signum', 'sin', 'sqrt', 'ss', 'ssr', 'sublist', 'sum',
  'sums', 'sv', 'system', 'tables', 'tan', 'til', 'trim', 'type', 'uj', 'ujf', 'union', 'upper',
  'value', 'var', 'vs', 'wavg', 'within', 'wsum', 'xasc', 'xbar', 'xcol', 'xcols', 'xdesc', 'xexp',
  'xgroup', 'xkey', 'xlog', 'xprev', 'xrank',
]);

const TEMPORAL_PATTERNS = [
  /^\d{4}\.\d{2}\.\d{2}D\d{2}:\d{2}:\d{2}(?:\.\d+)?/,
  /^\d{4}\.\d{2}\.\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?/,
  /^[-+]?\d+D\d{2}:\d{2}:\d{2}(?:\.\d+)?/,
  /^\d{4}\.\d{2}\.\d{2}/,
  /^\d{4}\.\d{2}m/,
  /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[uvt]?/,
];

const NUMERIC_PATTERNS = [
  /^0x[0-9A-Fa-f]+/,
  /^[01]+b/,
  /^-?0[NW][ghijefpmdznuvt]?/,
  /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?[hijef]?/,
];

const OPERATOR_PATTERN = /^(?:0:|1:|2:|::|[+\-*%=<>~,^#_?@.!|&:\\/])/;

/**
 * Tokenizes qText output for the result viewer. This is deliberately a small,
 * non-evaluating lexer aligned with this extension's first-party q grammar.
 */
export function lexQText(text: string): QTextLexResult {
  const tokens: QTextToken[] = [];
  let index = 0;
  let valid = true;
  let onlyWhitespaceOnLine = true;

  const emit = (kind: QTextTokenKind, start: number, end: number): void => {
    if (end <= start) {
      return;
    }
    const tokenText = text.slice(start, end);
    const previous = tokens[tokens.length - 1];
    if (previous && previous.kind === kind && previous.end === start) {
      tokens[tokens.length - 1] = {
        kind,
        text: previous.text + tokenText,
        start: previous.start,
        end,
      };
      return;
    }
    tokens.push({ kind, text: tokenText, start, end });
  };

  while (index < text.length) {
    const start = index;
    const char = text[index];

    if (char === '\r' || char === '\n' || char === ' ' || char === '\t') {
      while (index < text.length && /[\r\n \t]/.test(text[index])) {
        if (text[index] === '\r' || text[index] === '\n') {
          onlyWhitespaceOnLine = true;
        }
        index += 1;
      }
      emit('plain', start, index);
      continue;
    }

    if (char === '/' && (onlyWhitespaceOnLine || isHorizontalWhitespace(text[index - 1]))) {
      const lineEnd = lineEndIndex(text, index);
      const lineText = text.slice(index, lineEnd);
      if (onlyWhitespaceOnLine && lineText.trim() === '/') {
        let blockEnd = lineEndingEndIndex(text, lineEnd);
        let closed = false;
        while (blockEnd < text.length) {
          const candidateEnd = lineEndIndex(text, blockEnd);
          if (text.slice(blockEnd, candidateEnd).trim() === '\\') {
            blockEnd = candidateEnd;
            closed = true;
            break;
          }
          blockEnd = lineEndingEndIndex(text, candidateEnd);
        }
        if (!closed) {
          blockEnd = text.length;
          valid = false;
        }
        emit('comment', start, blockEnd);
        updateLineWhitespaceState(text.slice(start, blockEnd), value => { onlyWhitespaceOnLine = value; });
        index = blockEnd;
        continue;
      }
      emit('comment', start, lineEnd);
      index = lineEnd;
      onlyWhitespaceOnLine = false;
      continue;
    }

    if (onlyWhitespaceOnLine && char === '\\') {
      const end = lineEndIndex(text, index);
      emit('command', start, end);
      index = end;
      onlyWhitespaceOnLine = false;
      continue;
    }

    onlyWhitespaceOnLine = false;

    if (char === '"') {
      const quoted = quotedEnd(text, index);
      valid = valid && quoted.valid;
      index = quoted.end;
      emit('string', start, index);
      continue;
    }

    if (char === '`') {
      index += 1;
      if (text[index] === '"') {
        const quoted = quotedEnd(text, index);
        valid = valid && quoted.valid;
        index = quoted.end;
      } else {
        const symbol = /^(?:\.?[A-Za-z_][A-Za-z0-9_.]*)/.exec(text.slice(index));
        if (symbol) {
          index += symbol[0].length;
        }
      }
      emit('symbol', start, index);
      continue;
    }

    const rest = text.slice(index);
    if (char === '.') {
      const system = /^\.(?:Q|q|z)(?:\.[A-Za-z_][A-Za-z0-9_]*)+/.exec(rest);
      if (system && hasTokenBoundary(text, index, system[0].length)) {
        index += system[0].length;
        emit('system', start, index);
        continue;
      }
      const namespace = /^\.[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
      if (namespace && hasTokenBoundary(text, index, namespace[0].length)) {
        index += namespace[0].length;
        emit('namespace', start, index);
        continue;
      }
    }

    const temporal = firstBoundaryMatch(TEMPORAL_PATTERNS, text, index);
    if (temporal) {
      index += temporal.length;
      emit('temporal', start, index);
      continue;
    }

    const number = firstBoundaryMatch(NUMERIC_PATTERNS, text, index);
    if (number) {
      index += number.length;
      emit('number', start, index);
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (identifier) {
      index += identifier[0].length;
      const kind = Q_KEYWORDS.has(identifier[0])
        ? 'keyword'
        : Q_BUILTINS.has(identifier[0])
          ? 'builtin'
          : 'plain';
      emit(kind, start, index);
      continue;
    }

    const operator = OPERATOR_PATTERN.exec(rest);
    if (operator) {
      index += operator[0].length;
      emit('operator', start, index);
      continue;
    }

    index += 1;
    emit('plain', start, index);
  }

  return { tokens, valid };
}

export function tokenizeQText(text: string): readonly QTextToken[] {
  return lexQText(text).tokens;
}

/**
 * Adds display-only layout to balanced q lambda/block text. It never evaluates
 * q and returns the original bytes whenever lexical or structural safety is not
 * established.
 */
export function formatQTextForDisplay(text: string): QTextDisplayFormatResult {
  const lexed = lexQText(text);
  if (!lexed.valid || !isSafeFormattingInput(text)) {
    return { text, applied: false };
  }

  const protectedRanges = lexed.tokens
    .filter(token => token.kind === 'string' || token.kind === 'symbol' || token.kind === 'comment' || token.kind === 'command')
    .map(token => ({ start: token.start, end: token.end }));
  const validation = validateQTextStructure(text, protectedRanges);
  if (!validation.valid || validation.braceCount === 0) {
    return { text, applied: false };
  }

  const output: string[] = [];
  const stack: Array<{ delimiter: string; squareDepth: number; parenDepth: number }> = [];
  let squareDepth = 0;
  let parenDepth = 0;
  let rangeIndex = 0;
  let index = 0;

  while (index < text.length) {
    const range = protectedRanges[rangeIndex];
    if (range && index === range.start) {
      output.push(text.slice(range.start, range.end));
      index = range.end;
      rangeIndex += 1;
      continue;
    }

    const char = text[index];
    if (char === '[') {
      squareDepth += 1;
      output.push(char);
      index += 1;
      continue;
    }
    if (char === ']') {
      squareDepth -= 1;
      output.push(char);
      index += 1;
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
      output.push(char);
      index += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      output.push(char);
      index += 1;
      continue;
    }
    if (char === '{') {
      stack.push({ delimiter: char, squareDepth, parenDepth });
      output.push(char);
      index += 1;
      const next = skipFormattingWhitespace(text, index);
      if (text[next] !== '}') {
        output.push('\n', indent(stack.length));
        index = next;
      }
      continue;
    }
    if (char === '}') {
      stack.pop();
      trimTrailingFormattingWhitespace(output);
      output.push('\n', indent(stack.length), char);
      index += 1;
      continue;
    }
    const frame = stack[stack.length - 1];
    if (char === ';' && frame && squareDepth === frame.squareDepth && parenDepth === frame.parenDepth) {
      trimTrailingHorizontalWhitespace(output);
      output.push(char, '\n', indent(stack.length));
      index = skipFormattingWhitespace(text, index + 1);
      continue;
    }

    output.push(char);
    index += 1;
  }

  const formatted = output.join('');
  return formatted === text ? { text, applied: false } : { text: formatted, applied: true };
}

export function qTextRenderModel(text: string, options: QTextRenderOptions): QTextRenderModel {
  const formatted = options.displayFormatting
    ? formatQTextForDisplay(text)
    : { text, applied: false };
  if (!options.syntaxHighlighting) {
    return {
      text: formatted.text,
      formatted: formatted.applied,
      highlighted: false,
      segments: [{ kind: 'plain', text: formatted.text }],
    };
  }

  const lexed = lexQText(formatted.text);
  if (!lexed.valid) {
    return {
      text: formatted.text,
      formatted: formatted.applied,
      highlighted: false,
      segments: [{ kind: 'plain', text: formatted.text }],
    };
  }
  const segments = lexed.tokens.map(token => ({ kind: token.kind, text: token.text }));
  return {
    text: formatted.text,
    formatted: formatted.applied,
    highlighted: true,
    segments,
  };
}

function lineEndIndex(text: string, start: number): number {
  let index = start;
  while (index < text.length && text[index] !== '\r' && text[index] !== '\n') {
    index += 1;
  }
  return index;
}

function lineEndingEndIndex(text: string, start: number): number {
  let index = start;
  if (text[index] === '\r') {
    index += 1;
  }
  if (text[index] === '\n') {
    index += 1;
  }
  return index;
}

function updateLineWhitespaceState(value: string, update: (onlyWhitespace: boolean) => void): void {
  const lastNewline = Math.max(value.lastIndexOf('\n'), value.lastIndexOf('\r'));
  const tail = lastNewline >= 0 ? value.slice(lastNewline + 1) : value;
  update(lastNewline >= 0 ? /^[ \t]*$/.test(tail) : false);
}

function quotedEnd(text: string, start: number): { end: number; valid: boolean } {
  let index = start + 1;
  let valid = true;
  while (index < text.length) {
    if (text[index] === '\r' || text[index] === '\n') {
      return { end: index, valid: false };
    }
    if (text[index] === '\\') {
      const escapeStart = index;
      const escaped = text[index + 1];
      if (escaped === '\r' || escaped === '\n' || escaped === undefined) {
        return { end: escaped === undefined ? text.length : index + 1, valid: false };
      }
      if (escaped === '\\' || escaped === '"' || escaped === 'n' || escaped === 'r' || escaped === 't') {
        index += 2;
        continue;
      }
      if (/^[0-3][0-7]{2}/.test(text.slice(index + 1))) {
        index += 4;
        continue;
      }
      valid = false;
      index = Math.min(text.length, escapeStart + 2);
      continue;
    }
    if (text[index] === '"') {
      return { end: index + 1, valid };
    }
    index += 1;
  }
  return { end: text.length, valid: false };
}

function isHorizontalWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t';
}

function firstBoundaryMatch(patterns: readonly RegExp[], text: string, start: number): string | null {
  if (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1])) {
    return null;
  }
  for (const pattern of patterns) {
    const match = pattern.exec(text.slice(start));
    if (match && hasTokenBoundary(text, start, match[0].length)) {
      return match[0];
    }
  }
  return null;
}

function hasTokenBoundary(text: string, start: number, length: number): boolean {
  const previous = start > 0 ? text[start - 1] : '';
  const next = text[start + length] || '';
  return !/[A-Za-z0-9_.]/.test(previous) && !/[A-Za-z0-9_.]/.test(next);
}

function isSafeFormattingInput(text: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

function validateQTextStructure(
  text: string,
  protectedRanges: ReadonlyArray<{ start: number; end: number }>
): { valid: boolean; braceCount: number } {
  const stack: string[] = [];
  let braceCount = 0;
  let rangeIndex = 0;
  const closing: { [delimiter: string]: string } = { ']': '[', ')': '(', '}': '{' };
  for (let index = 0; index < text.length; index++) {
    const range = protectedRanges[rangeIndex];
    if (range && index === range.start) {
      index = range.end - 1;
      rangeIndex += 1;
      continue;
    }
    const char = text[index];
    if (char === '[' || char === '(' || char === '{') {
      stack.push(char);
      if (char === '{') {
        braceCount += 1;
      }
    } else if (char === ']' || char === ')' || char === '}') {
      if (stack.pop() !== closing[char]) {
        return { valid: false, braceCount };
      }
    }
  }
  return { valid: stack.length === 0, braceCount };
}

function skipFormattingWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[\r\n \t]/.test(text[index])) {
    index += 1;
  }
  return index;
}

function trimTrailingHorizontalWhitespace(output: string[]): void {
  trimTrailingWhitespace(output, /[ \t]/);
}

function trimTrailingFormattingWhitespace(output: string[]): void {
  trimTrailingWhitespace(output, /[\r\n \t]/);
}

function trimTrailingWhitespace(output: string[], pattern: RegExp): void {
  while (output.length > 0) {
    const last = output[output.length - 1];
    if (![...last].every(char => pattern.test(char))) {
      return;
    }
    output.pop();
  }
}

function indent(depth: number): string {
  return '  '.repeat(Math.max(0, depth));
}
