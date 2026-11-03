/**
 * The console's key decoder (consumer CLI contract §6). It buffers: an escape sequence split across stdin chunks (`\x1b` then
 * `[A`) is one key, never Escape followed by letters, because a chunk ending in an incomplete sequence is held until
 * the next chunk or until the caller's escape timer calls `flush()`, which reads a lone ESC as Escape. In `text` mode,
 * used while a one-line input is open, printable characters are text, so `j` or `q` are typed, not commands. The
 * stream feeding it is decoded as UTF-8, which owns byte splits: a multi-byte character always arrives whole.
 */
export type Key =
  | 'up'
  | 'down'
  | 'page-up'
  | 'page-down'
  | 'enter'
  | 'tab'
  | 'space'
  | 'escape'
  | 'backspace'
  | 'quit'
  | 'help'
  | 'refresh'
  | 'select-all'
  | 'batch'
  | 'find'
  | 'interrupt'
  | 'other';
export type Input = { readonly kind: 'key'; readonly key: Key } | { readonly kind: 'text'; readonly text: string };
export type Mode = 'keys' | 'text';

const LETTERS: Readonly<Record<string, Key>> = {
  k: 'up',
  j: 'down',
  q: 'quit',
  '?': 'help',
  r: 'refresh',
  a: 'select-all',
  b: 'batch',
  f: 'find',
  ' ': 'space',
};
const SEQUENCES: Readonly<Record<string, Key>> = {
  '\x1b[A': 'up',
  '\x1bOA': 'up',
  '\x1b[B': 'down',
  '\x1bOB': 'down',
  '\x1b[5~': 'page-up',
  '\x1b[6~': 'page-down',
};
const key = (name: Key): Input => ({ kind: 'key', key: name });

/** The length of the escape sequence at the start of `text`, or 0 when it is incomplete. */
function sequenceLength(text: string): number {
  if (text.length < 2) return 0;
  const second = text[1]!;
  if (second === '[') {
    // CSI: parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, then one final byte 0x40-0x7E.
    for (let index = 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
      if (code < 0x20 || code > 0x3f) return index;
    }
    return 0;
  }
  if (second === 'O') return text.length >= 3 ? 3 : 0;
  // ESC and any other character (alt and a key) is one key.
  return 2;
}

export class KeyDecoder {
  mode: Mode = 'keys';
  private buffer = '';
  /** Every complete key in the buffer and this chunk; an incomplete escape sequence stays buffered. */
  push(chunk: string): readonly Input[] {
    this.buffer += chunk;
    const out: Input[] = [];
    let text = '';
    const emit = (input: Input): void => {
      if (text !== '') out.push({ kind: 'text', text });
      text = '';
      out.push(input);
    };
    while (this.buffer.length > 0) {
      const first = this.buffer[0]!;
      if (first === '\x1b') {
        const length = sequenceLength(this.buffer);
        if (length === 0) break;
        // In text mode a sequence is swallowed whole; the input line has no cursor movement.
        emit(key(this.mode === 'text' ? 'other' : (SEQUENCES[this.buffer.slice(0, length)] ?? 'other')));
        this.buffer = this.buffer.slice(length);
        continue;
      }
      let consumed = first.length;
      const code = first.charCodeAt(0);
      if (first === '\r' || first === '\n') {
        if (first === '\r' && this.buffer[1] === '\n') consumed = 2;
        emit(key('enter'));
      } else if (first === '\t') emit(key('tab'));
      else if (first === '\x7f' || first === '\b') emit(key('backspace'));
      else if (first === '\x03') emit(key('interrupt'));
      else if (code < 0x20) emit(key('other'));
      else if (this.mode === 'text') {
        const character = String.fromCodePoint(this.buffer.codePointAt(0)!);
        consumed = character.length;
        text += character;
      } else emit(key(LETTERS[first] ?? 'other'));
      this.buffer = this.buffer.slice(consumed);
    }
    if (text !== '') out.push({ kind: 'text', text });
    return out;
  }
  /** Called when the escape timer fires: a held lone ESC is Escape, a partial sequence is dropped as `other`. */
  flush(): readonly Input[] {
    if (this.buffer === '') return [];
    const held = this.buffer;
    this.buffer = '';
    return [key(held === '\x1b' ? 'escape' : 'other')];
  }
  /** True while a buffered ESC could still start a sequence. */
  pending(): boolean {
    return this.buffer !== '';
  }
}
