/**
 * The console's cell grid and screen (console/grid.ts, console/terminal.ts): a frame is written as the rows that
 * changed, in one write wrapped in synchronized-output markers; a resize repaints everything; leaving restores raw mode,
 * the cursor and the main screen, also when a frame throws; and no escape sequence from data ever reaches the terminal.
 */
import { describe, expect, it } from 'vitest';
import { Grid } from '../src/console/grid.js';
import type { TerminalIO } from '../src/console/terminal.js';
import { Screen } from '../src/console/terminal.js';

const ESC = '\x1b';
const OFF = { paste: `${ESC}[?2004l`, mouse: `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l` };
class Recorder implements TerminalIO {
  writes: string[] = [];
  synced: string[] = [];
  raw: boolean[] = [];
  /** A write whose data contains this throws, as a closed or failing terminal does. */
  failOn: string | null = null;
  failRaw = false;
  size = { columns: 20, rows: 4 };
  listeners: (() => void)[] = [];
  write(data: string): void {
    if (this.failOn !== null && data.includes(this.failOn)) throw new Error('write failed');
    this.writes.push(data);
  }
  writeSync(data: string): void {
    this.synced.push(data);
  }
  columns(): number {
    return this.size.columns;
  }
  rows(): number {
    return this.size.rows;
  }
  setRawMode(on: boolean): void {
    if (on && this.failRaw) throw new Error('raw mode refused');
    this.raw.push(on);
  }
  onResize(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }
  resize(columns: number, rows: number): void {
    this.size = { columns, rows };
    for (const listener of this.listeners) listener();
  }
}
const grid = (lines: readonly string[], columns = 20): Grid => {
  const out = new Grid(columns, lines.length);
  lines.forEach((line, y) => out.put(0, y, line));
  return out;
};
/** The rows a write moved to, by 1-based row number. */
const rowsWritten = (data: string): number[] => [...data.matchAll(/\x1b\[(\d+);1H/g)].map((match) => Number(match[1]));

describe('screen', () => {
  it('enter writes alt screen, hides the cursor, raw on', () => {
    const io = new Recorder();
    const screen = new Screen(io, false);
    screen.enter();
    expect(io.writes.join('')).toBe(`${ESC}[?1049h${ESC}[?25l${ESC}[?2004h`);
    expect(io.raw).toEqual([true]);
    expect(screen.active).toBe(true);
  });
  it('the second identical frame writes nothing', () => {
    const io = new Recorder();
    const screen = new Screen(io, false);
    screen.enter();
    screen.frame(grid(['one', 'two', 'three', 'four']));
    const count = io.writes.length;
    screen.frame(grid(['one', 'two', 'three', 'four']));
    expect(io.writes.length).toBe(count);
  });
  it('one changed row writes one row inside sync markers', () => {
    const io = new Recorder();
    const screen = new Screen(io, false);
    screen.enter();
    screen.frame(grid(['one', 'two', 'three', 'four']));
    io.writes = [];
    screen.frame(grid(['one', 'TWO', 'three', 'four']));
    expect(io.writes).toHaveLength(1);
    const data = io.writes[0]!;
    expect(data.startsWith(`${ESC}[?2026h`)).toBe(true);
    expect(data.endsWith(`${ESC}[?2026l`)).toBe(true);
    expect(rowsWritten(data)).toEqual([2]);
    expect(data).toBe(`${ESC}[?2026h${ESC}[2;1H${ESC}[2KTWO${ESC}[?2026l`);
  });
  it('resize repaints fully', () => {
    const io = new Recorder();
    const screen = new Screen(io, false);
    screen.enter();
    screen.frame(grid(['one', 'two', 'three', 'four']));
    io.writes = [];
    io.resize(30, 4);
    screen.frame(grid(['one', 'two', 'three', 'four'], 30));
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0]).toContain(`${ESC}[2J`);
    expect(rowsWritten(io.writes[0]!)).toEqual([1, 2, 3, 4]);
    // invalidate() alone forces the same full repaint.
    io.writes = [];
    screen.invalidate();
    screen.frame(grid(['one', 'two', 'three', 'four'], 30));
    expect(rowsWritten(io.writes[0]!)).toEqual([1, 2, 3, 4]);
  });
  it('leave restores and is idempotent', () => {
    const io = new Recorder();
    const screen = new Screen(io, false);
    screen.enter();
    io.writes = [];
    screen.leave();
    screen.leave();
    expect(io.writes.join('')).toBe(`${OFF.paste}${OFF.mouse}${ESC}[?25h${ESC}[?1049l`);
    expect(io.raw).toEqual([true, false]);
    expect(screen.active).toBe(false);
    expect(io.listeners).toHaveLength(0);
  });
  it('a failure part-way through enter rolls back exactly what was acquired', () => {
    const refused = new Recorder();
    refused.failRaw = true;
    const screen = new Screen(refused, false);
    expect(() => screen.enter()).toThrow('raw mode refused');
    // Alternate screen, cursor and paste were taken, so all three are given back; raw mode never was, so it is left.
    expect(refused.writes.join('')).toBe(
      `${ESC}[?1049h${ESC}[?25l${ESC}[?2004h${OFF.paste}${OFF.mouse}${ESC}[?25h${ESC}[?1049l`,
    );
    expect(refused.raw).toEqual([]);
    expect(screen.active).toBe(false);
    expect(refused.listeners).toHaveLength(0);
    const halfway = new Recorder();
    halfway.failOn = '?2004h';
    const second = new Screen(halfway, false);
    expect(() => second.enter()).toThrow('write failed');
    expect(halfway.writes.join('')).toBe(`${ESC}[?1049h${ESC}[?25l${OFF.mouse}${ESC}[?25h${ESC}[?1049l`);
    expect(second.active).toBe(false);
    // Nothing is left held: a second leave writes nothing.
    halfway.writes = [];
    second.leave();
    expect(halfway.writes).toEqual([]);
  });
  it('leave keeps going when a piece fails, and a synchronous leave writes synchronously', () => {
    const io = new Recorder();
    const screen = new Screen(io, false);
    screen.enter();
    io.failOn = '?1049l';
    expect(() => screen.leave()).not.toThrow();
    expect(io.raw).toEqual([true, false]);
    expect(screen.active).toBe(false);
    const sync = new Recorder();
    const exiting = new Screen(sync, false);
    exiting.enter();
    sync.writes = [];
    exiting.leave(true);
    expect(sync.writes).toEqual([]);
    expect(sync.synced.join('')).toBe(`${OFF.paste}${OFF.mouse}${ESC}[?25h${ESC}[?1049l`);
  });
  it('raw mode taken outside the alternate screen is given back by leave', () => {
    const io = new Recorder();
    const screen = new Screen(io, false);
    screen.raw(true);
    expect(screen.active).toBe(false);
    screen.leave();
    expect(io.raw).toEqual([true, false]);
    expect(io.writes).toEqual([]);
  });
  it('restores on a throw during a frame', () => {
    const io = new Recorder();
    const screen = new Screen(io, false);
    screen.enter();
    const broken = grid(['one', 'two', 'three', 'four']);
    broken.row = () => {
      throw new Error('mid-frame');
    };
    expect(() => screen.frame(broken)).toThrow('mid-frame');
    expect(screen.active).toBe(false);
    expect(io.raw).toEqual([true, false]);
    expect(io.writes.join('')).toContain(`${ESC}[?25h${ESC}[?1049l`);
  });
});

describe('grid', () => {
  it('a wide char at the last column is not split', () => {
    const cells = new Grid(5, 1);
    // The wide character would end past the edge, so the text is cut before it, never through it.
    expect(cells.put(0, 0, 'abcd用')).toBe(5);
    expect(cells.lines()).toEqual(['abcd…']);
    const last = new Grid(5, 1);
    expect(last.put(4, 0, '用')).toBe(1);
    expect(last.lines()).toEqual(['    …']);
    const fits = new Grid(6, 1);
    fits.put(0, 0, 'abcd用');
    expect(fits.lines()).toEqual(['abcd用']);
    // Overwriting half of a wide cell blanks its other half.
    fits.put(5, 0, 'x');
    expect(fits.lines()).toEqual(['abcd x']);
  });
  it('truncates at maxWidth with an ellipsis and never wraps', () => {
    const cells = new Grid(20, 1);
    cells.put(2, 0, 'ab🚀cd', null, 4);
    expect(cells.lines()).toEqual(['  ab…']);
    cells.put(0, 0, 'z'.repeat(30));
    expect(cells.lines()).toEqual(['z'.repeat(19) + '…']);
    const ascii = new Grid(6, 1);
    ascii.put(0, 0, 'abcdefgh', null, undefined, true);
    expect(ascii.lines()).toEqual(['abcde~']);
  });
  it('an escape sequence in data is never written', () => {
    const io = new Recorder();
    const screen = new Screen(io, true);
    screen.enter();
    const cells = new Grid(20, 2);
    cells.put(0, 0, `${ESC}[2Jboom\x07\x9b`, 'red');
    cells.put(0, 1, 'tab\there');
    io.writes = [];
    screen.frame(cells);
    const data = io.writes.join('');
    // Strip the screen's own sequences: cursor moves, row clears, SGR and the sync markers.
    const rest = data.replace(/\x1b\[(?:\?2026[hl]|2J|\d+;1H|2K|[0-9;]*m)/g, '');
    expect(rest).not.toContain(ESC);
    expect(rest).not.toContain('\x9b');
    expect(cells.lines()).toEqual(['�[2Jboom��', 'tab here']);
    const ascii = new Grid(10, 1);
    ascii.put(0, 0, `${ESC}x`, null, undefined, true);
    expect(ascii.lines()).toEqual(['?x']);
  });
  it('rows carry their role only when colour is on', () => {
    const cells = new Grid(10, 1);
    cells.put(0, 0, 'ok', 'green');
    cells.put(3, 0, 'no');
    expect(cells.row(0, false)).toBe('ok no');
    expect(cells.row(0, true)).toBe(`${ESC}[32mok${ESC}[0m no`);
  });
});
