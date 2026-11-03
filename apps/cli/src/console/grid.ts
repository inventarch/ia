/**
 * The console's in-memory frame: a grid of cells, one grapheme cluster each, a wide cluster filling its cell and a
 * continuation. Everything drawn goes through `put`, which is the one place untrusted text (paths, details, remedies,
 * another program's output) meets the terminal: every C0 and C1 control character, ESC included, becomes U+FFFD
 * (ASCII `?`), a tab or line break becomes a space, and text is cut to its column, never wrapped.
 */
import type { Role } from '../render.js';
import { style } from '../render.js';
import { clusterWidth, graphemes, truncate } from './width.js';

export interface Cell {
  /** One grapheme cluster; empty for the continuation of a wide cell. */
  readonly text: string;
  /** 0 marks the continuation of the wide cell to its left. */
  readonly width: 1 | 2 | 0;
  readonly role: Role | null;
}
const BLANK: Cell = { text: ' ', width: 1, role: null };

/** Control characters out, so no escape sequence carried by data can reach the terminal. */
export function sanitize(text: string, ascii = false): string {
  let out = '';
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point === 0x09 || point === 0x0a || point === 0x0d) out += ' ';
    else if (point < 0x20 || (point >= 0x7f && point <= 0x9f)) out += ascii ? '?' : '�';
    else out += character;
  }
  return out;
}

export class Grid {
  readonly columns: number;
  readonly rows: number;
  private readonly cells: Cell[][];
  constructor(columns: number, rows: number) {
    this.columns = Math.max(0, columns);
    this.rows = Math.max(0, rows);
    this.cells = Array.from({ length: this.rows }, () => Array.from({ length: this.columns }, () => BLANK));
  }
  /** Writes `text` at (x, y), cut to `maxWidth` and the grid's edge; returns the columns written. */
  put(x: number, y: number, text: string, role: Role | null = null, maxWidth?: number, ascii = false): number {
    if (y < 0 || y >= this.rows || x < 0 || x >= this.columns) return 0;
    const room = Math.min(maxWidth ?? Number.POSITIVE_INFINITY, this.columns - x);
    if (room <= 0) return 0;
    const fitted = truncate(sanitize(text, ascii), room, ascii);
    let column = x;
    for (const cluster of graphemes(fitted)) {
      const width = clusterWidth(cluster);
      if (width === 0) continue;
      if (column + width > x + room) {
        // A wide cluster that does not fit in the last column is a space, never half a character.
        this.set(column, y, { text: ' ', width: 1, role });
        column += 1;
        break;
      }
      this.set(column, y, { text: cluster, width, role });
      if (width === 2) this.set(column + 1, y, { text: '', width: 0, role });
      column += width;
    }
    return column - x;
  }
  private set(x: number, y: number, cell: Cell): void {
    const row = this.cells[y]!;
    const old = row[x]!;
    // Never leave half a wide character behind: blank the partner of a wide cell this one overwrites.
    if (old.width === 0 && cell.width !== 0 && x > 0 && row[x - 1]!.width === 2) row[x - 1] = BLANK;
    if (old.width === 2 && cell.width !== 2 && x + 1 < this.columns && row[x + 1]!.width === 0) row[x + 1] = BLANK;
    row[x] = cell;
  }
  /** One row as written: styled runs when `color` is on, trailing blank cells dropped. */
  row(y: number, color: boolean): string {
    const row = this.cells[y] ?? [];
    let end = row.length;
    while (end > 0 && row[end - 1]!.text === ' ' && row[end - 1]!.role === null) end -= 1;
    let out = '',
      run = '',
      role: Role | null = null;
    for (const cell of row.slice(0, end)) {
      if (cell.width === 0) continue;
      if (cell.role !== role) {
        out += style(run, role, color);
        run = '';
        role = cell.role;
      }
      run += cell.text;
    }
    return out + style(run, role, color);
  }
  /** The plain text of every row, for golden frames. */
  lines(): string[] {
    return Array.from({ length: this.rows }, (_, y) => this.row(y, false).trimEnd());
  }
}
