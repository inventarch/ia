/**
 * The one display-width function for terminal layout (consumer CLI contract §6), shared with render.ts. Text is measured by grapheme
 * cluster (`Intl.Segmenter`), never by code point, so a joined emoji, a flag or a keycap is one cell group and is never
 * split. A cluster's width follows Unicode 16.0.0 (width-table.ts): East Asian wide and fullwidth characters and emoji
 * presentation count 2, combining marks, format characters and controls 0, everything else 1. Ambiguous-width
 * characters count 1. Right-to-left and complex scripts are measured by the same rules and may misalign in a terminal
 * that shapes them differently.
 */
import type { Range } from './width-table.js';
import { CONTROL, EMOJI, EMOJI_MODIFIER, EMOJI_PRESENTATION, WIDE, ZERO } from './width-table.js';

export const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const has = (ranges: readonly Range[], point: number): boolean => {
  let low = 0,
    high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [first, last] = ranges[middle]!;
    if (point < first) high = middle - 1;
    else if (point > last) low = middle + 1;
    else return true;
  }
  return false;
};
const TEXT_SELECTOR = 0xfe0e,
  EMOJI_SELECTOR = 0xfe0f;
const regional = (point: number): boolean => point >= 0x1f1e6 && point <= 0x1f1ff;

/** The columns one grapheme cluster takes; the first rule that holds decides. */
export function clusterWidth(cluster: string): 0 | 1 | 2 {
  const points = [...cluster].map((character) => character.codePointAt(0)!);
  if (points.length === 0) return 0;
  // 1. A cluster that starts with a control character, or holds only zero-width code points, takes no column.
  if (has(CONTROL, points[0]!)) return 0;
  const at = points.findIndex((point) => !has(ZERO, point));
  if (at === -1) return 0;
  const base = points[at]!;
  // 2. A flag is two regional indicators; a lone one is narrow.
  if (regional(base)) return points.filter(regional).length >= 2 ? 2 : 1;
  // 3. Text presentation asked for: the base's own East Asian width, never wide from emoji data.
  if (points.includes(TEXT_SELECTOR)) return has(WIDE, base) ? 2 : 1;
  // 4. A base that presents as emoji by default.
  if (has(EMOJI_PRESENTATION, base)) return 2;
  // 5. An emoji base asked to present as emoji, or followed by a skin-tone modifier.
  const next = points[at + 1];
  if (has(EMOJI, base) && next !== undefined && (next === EMOJI_SELECTOR || has(EMOJI_MODIFIER, next))) return 2;
  // 6. Otherwise the base's East Asian width; a selector after a base that is not emoji adds nothing.
  return has(WIDE, base) ? 2 : 1;
}

const SGR = /\x1b\[[0-9;]*m/g;
/** The grapheme clusters of `text`, in order. */
export function graphemes(text: string): readonly string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}
/** Text as runs: SGR sequences kept whole and zero-width, everything else as grapheme clusters. */
function units(text: string): readonly { readonly text: string; readonly width: number }[] {
  const out: { text: string; width: number }[] = [];
  let at = 0;
  for (const match of text.matchAll(SGR)) {
    for (const cluster of graphemes(text.slice(at, match.index)))
      out.push({ text: cluster, width: clusterWidth(cluster) });
    out.push({ text: match[0], width: 0 });
    at = match.index + match[0].length;
  }
  for (const cluster of graphemes(text.slice(at))) out.push({ text: cluster, width: clusterWidth(cluster) });
  return out;
}
/** Display columns: SGR sequences and control characters count 0. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const cluster of graphemes(text.replace(SGR, ''))) width += clusterWidth(cluster);
  return width;
}
/** `text` cut to at most `width` columns, ending with `…` (ASCII `~`) when cut; a cluster is kept whole or dropped. */
export function truncate(text: string, width: number, ascii = false): string {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  const budget = width - 1;
  let used = 0,
    out = '';
  for (const unit of units(text)) {
    if (used + unit.width > budget) break;
    used += unit.width;
    out += unit.text;
  }
  return out + (ascii ? '~' : '…');
}
/** `text` truncated, then padded with spaces to exactly `width` columns. */
export function pad(text: string, width: number, ascii = false): string {
  const cut = truncate(text, width, ascii);
  return cut + ' '.repeat(Math.max(0, width - stringWidth(cut)));
}
/**
 * A path shortened in the middle: its first segment, an ellipsis, then as many last segments as fit
 * (`/…/inventarch/notes`, or a drive and backslashes on Windows). When not even the last segment fits, it is truncated at
 * its end like any text.
 */
export function truncateMiddle(path: string, width: number, ascii = false): string {
  if (stringWidth(path) <= width) return path;
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(separator);
  const head = parts[0]!,
    mark = ascii ? '~' : '…';
  let tail = '';
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const next = tail === '' ? parts[index]! : parts[index]! + separator + tail;
    if (stringWidth(head + separator + mark + separator + next) > width) break;
    tail = next;
  }
  return tail === '' ? truncate(path, width, ascii) : head + separator + mark + separator + tail;
}
