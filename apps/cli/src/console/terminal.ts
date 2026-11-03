/**
 * The console's full-screen session (consumer CLI contract §6): the alternate screen, a hidden cursor and raw mode while it is
 * shown, and frames written as the rows that changed since the last one, each frame in one write wrapped in
 * synchronized-output markers (terminals that do not know the mode ignore it). A resize forces a full repaint.
 * `leave()` restores all three and is safe to call any number of times, from any handler; a frame that throws leaves
 * before the error goes on, so the terminal is never left in raw mode on the alternate screen.
 */
import type { Grid } from './grid.js';

export interface TerminalIO {
  write(data: string): void;
  columns(): number;
  rows(): number;
  setRawMode(on: boolean): void;
  /** Subscribes to resizes; returns the unsubscribe. */
  onResize(listener: () => void): () => void;
}

const CSI = '\x1b[';
export const ESCAPES = {
  altScreenOn: `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  syncOn: `${CSI}?2026h`,
  syncOff: `${CSI}?2026l`,
  clearScreen: `${CSI}2J`,
  clearRow: `${CSI}2K`,
  moveTo: (row: number, column: number): string => `${CSI}${row};${column}H`,
} as const;

export class Screen {
  private shown = false;
  private last: { readonly columns: number; readonly rows: readonly string[] } | null = null;
  private unsubscribe: (() => void) | null = null;
  constructor(
    private readonly io: TerminalIO,
    private readonly color: boolean,
  ) {}
  get active(): boolean {
    return this.shown;
  }
  enter(): void {
    if (this.shown) return;
    this.io.write(ESCAPES.altScreenOn + ESCAPES.hideCursor);
    this.io.setRawMode(true);
    this.shown = true;
    this.last = null;
    this.unsubscribe = this.io.onResize(() => this.invalidate());
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
  leave(): void {
    if (!this.shown) return;
    this.shown = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.last = null;
    try {
      this.io.setRawMode(false);
    } finally {
      this.io.write(ESCAPES.showCursor + ESCAPES.altScreenOff);
    }
  }
}
