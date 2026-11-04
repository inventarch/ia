/**
 * The console's full-screen session (consumer CLI contract §6): the alternate screen, a hidden cursor, bracketed paste
 * and raw mode while it is shown, and frames written as the rows that changed since the last one, each frame in one
 * write wrapped in synchronized-output markers (terminals that do not know the mode ignore it). A resize forces a full
 * repaint.
 *
 * Entering is transactional: each piece of terminal state is recorded as it is taken, so a failure part-way gives back
 * exactly what was taken. `leave()` gives back everything held, each piece on its own so one failure does not keep the
 * rest, turns off the mouse-reporting modes a child or injected text may have turned on, and is safe to call any number
 * of times from any handler; `leave(true)` writes synchronously, for the process `exit` handler. A frame that throws
 * leaves before the error goes on, so the terminal is never left in raw mode on the alternate screen.
 */
import type { Grid } from './grid.js';

export interface TerminalIO {
  write(data: string): void;
  /** A write that completes before it returns, for the `exit` handler; `write` is used when absent. */
  writeSync?(data: string): void;
  columns(): number;
  rows(): number;
  setRawMode(on: boolean): void;
  /** Subscribes to resizes; returns the unsubscribe. */
  onResize(listener: () => void): () => void;
  /** Subscribes to output failures (a closed pipe); returns the unsubscribe. */
  onError?(listener: (error: Error) => void): () => void;
}

const CSI = '\x1b[';
export const ESCAPES = {
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  pasteOn: `${CSI}?2004h`,
  pasteOff: `${CSI}?2004l`,
  /** Every mouse-reporting mode off: X10/normal, button-event, any-event and SGR encoding. */
  mouseOff: `${CSI}?1000l${CSI}?1002l${CSI}?1003l${CSI}?1006l`,
  syncOn: `${CSI}?2026h`,
  syncOff: `${CSI}?2026l`,
  clearScreen: `${CSI}2J`,
  clearRow: `${CSI}2K`,
  moveTo: (row: number, column: number): string => `${CSI}${row};${column}H`,
} as const;

type Piece = 'alt' | 'cursor' | 'paste' | 'raw';

export class Screen {
  private readonly held = new Set<Piece>();
  private last: { readonly columns: number; readonly rows: readonly string[] } | null = null;
  private unsubscribe: (() => void) | null = null;
  constructor(
    private readonly io: TerminalIO,
    private readonly color: boolean,
  ) {}
  /** True while the console owns the alternate screen. */
  get active(): boolean {
    return this.held.has('alt');
  }
  enter(): void {
    if (this.held.has('alt')) return;
    try {
      this.take('alt', ESCAPES.altScreenOn);
      this.take('cursor', ESCAPES.hideCursor);
      this.take('paste', ESCAPES.pasteOn);
      this.raw(true);
      this.last = null;
      this.unsubscribe = this.io.onResize(() => this.invalidate());
    } catch (error) {
      this.leave();
      throw error;
    }
  }
  private take(piece: Piece, sequence: string): void {
    this.io.write(sequence);
    this.held.add(piece);
  }
  /** Raw mode on or off, recorded so `leave()` gives it back; used alone for a one-key wait outside the screen. */
  raw(on: boolean): void {
    this.io.setRawMode(on);
    if (on) this.held.add('raw');
    else this.held.delete('raw');
  }
  /** Forgets the last frame, so the next one repaints every row. */
  invalidate(): void {
    this.last = null;
  }
  frame(grid: Grid): void {
    try {
      const rows = Array.from({ length: grid.rows }, (_, y) => grid.row(y, this.color));
      const full = this.last === null || this.last.columns !== grid.columns || this.last.rows.length !== rows.length;
      let out = full ? ESCAPES.clearScreen : '';
      rows.forEach((row, y) => {
        if (full || this.last!.rows[y] !== row) out += ESCAPES.moveTo(y + 1, 1) + ESCAPES.clearRow + row;
      });
      this.last = { columns: grid.columns, rows };
      if (out !== '') this.io.write(ESCAPES.syncOn + out + ESCAPES.syncOff);
    } catch (error) {
      this.leave();
      throw error;
    }
  }
  /** Gives back every piece held; `sync` writes with `writeSync`, for the process `exit` handler. Never throws. */
  leave(sync = false): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.last = null;
    if (this.held.has('raw'))
      try {
        this.raw(false);
      } catch {
        this.held.delete('raw');
      }
    const screen = this.held.has('alt') || this.held.has('cursor') || this.held.has('paste');
    if (!screen) return;
    const out =
      (this.held.has('paste') ? ESCAPES.pasteOff : '') +
      ESCAPES.mouseOff +
      (this.held.has('cursor') ? ESCAPES.showCursor : '') +
      (this.held.has('alt') ? ESCAPES.altScreenOff : '');
    this.held.delete('paste');
    this.held.delete('cursor');
    this.held.delete('alt');
    try {
      if (sync && this.io.writeSync !== undefined) this.io.writeSync(out);
      else this.io.write(out);
    } catch {
      // A terminal that cannot be written to is gone; raw mode, the part that outlives it, was given back above.
    }
  }
}
