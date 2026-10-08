import { createHash } from 'node:crypto';
import { isPhase, isPrimitive, isRequirementId } from '@inventarch/language';
import { canonicalRoot } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import { DbError, sourceTree } from '@inventarch/db';
import type { ReadHandle } from '@inventarch/db';
import { RUNTIME_CODES, RuntimeError } from './errors.js';
import type { RuntimeCode } from './errors.js';
import { bodyOf, statedText } from './render.js';
import { freeze } from './types.js';

/**
 * Locators and the body reader: position-and-projection §5's `ia read` and design row 23.
 *
 * A locator names one admitted record, or one part of it, in one of four forms:
 * - `<identity>`: the record, by its canonical `system/kind/facet/name` identity;
 * - `<identity>#<phase>/<Primitive>`: the text of the record's cells at that address, a playbook's step;
 * - `<identity>#<REQ-ID>`: the text of one of the record's requirements;
 * - `<path>:<line>`: the innermost admitted record whose source span holds that line of a workspace source.
 *
 * The body behind a record is the document its source locator names, when its word carries one (SOURCE_LOCATORS) and the
 * record states it; otherwise the record's own body (`bodyOf`). A fragment reads the record, never its document: the
 * text of its cells or of its requirement at the fragment. A body is text and the SHA-256 of its UTF-8 bytes, never a
 * certification: the reader neither admits the document nor judges what it says (IM-43). Structure (sections, fields,
 * relationships) is the inspector's and never a body.
 */

/**
 * The field whose text names each word's document body, as its schema declares it: `work.source` on every work word
 * that states one, @spec, @plan, @milestone, @task and @decision (position-and-projection rows 2d and 23, widened by
 * decision work-source-locator: all five schemas declare the one field, and a plan's records name their sections of
 * its document with it), `reference.document` on @authoring-guide (row 2h) and `template.resource`, a @template's
 * input. A record that states none reads its own body.
 */
export const SOURCE_LOCATORS: Readonly<Record<string, string>> = Object.freeze({
  'authoring-guide': 'reference.document',
  decision: 'work.source',
  milestone: 'work.source',
  plan: 'work.source',
  spec: 'work.source',
  task: 'work.source',
  template: 'template.resource',
});

export type Locator =
  | { readonly form: 'identity'; readonly identity: string }
  | { readonly form: 'cell' | 'requirement'; readonly identity: string; readonly fragment: string }
  | { readonly form: 'line'; readonly path: string; readonly line: number };

export type ReadCode = Extract<RuntimeCode, `IA-RUNTIME-READ-${string}`>;
/** The refusal codes a read can return; each is registered in RUNTIME_CODES. */
export const READ_CODES: readonly ReadCode[] = Object.freeze(
  RUNTIME_CODES.filter((code): code is ReadCode => code.startsWith('IA-RUNTIME-READ-')),
);

export interface ReadBodyOptions {
  /**
   * The host's reader of one workspace file, given its canonical workspace-relative path. The host holds the root
   * boundary (R10): it returns the file's bytes, and throws for a path it does not admit (a link, a missing or irregular
   * file), which the read reports as an unreachable locator.
   */
  readonly read: (path: string) => Uint8Array;
  /**
   * The workspace directory each adopted mount is bound to, by the `.ia/adopted/<id>/<revision>` tree label its sources
   * carry (db `adoptedBindings`). A label is no directory, so the document of a record in an adopted mount is read from
   * the directory bound here, and refused as unreachable when none is.
   */
  readonly mounts?: ReadonlyMap<string, string>;
  /** Read a record at runtime placement (band 0), which is refused otherwise. */
  readonly includeRuntime?: boolean;
  /**
   * The scope token every lookup reads through, `get` and `records` alike, so the scope bounds the read by identity. In
   * a scope narrower than the whole workspace, a locator no admitted record in it answers gets one plain
   * IA-RUNTIME-READ-UNADMITTED, `The locator is not in this scope`, which names no path, line, identity or refused
   * record, as what lies outside a scope is not disclosed. A whole-workspace token (db `isCompleteScope`, PT5) reads
   * what the root view reads, so a miss there is refused as there, naming a record admission refused with its reason,
   * as deliveryView names one. Without it the read is in the handle's root view and says what the workspace's sources
   * hold.
   */
  readonly within?: string;
}
export interface ReadBody {
  /** The locator as given. */
  readonly locator: string;
  readonly identity: string;
  /** `record` for the record's own body or one of its fragments, `document` for the file its source locator names. */
  readonly kind: 'record' | 'document';
  /** A document's canonical workspace-relative path. */
  readonly path?: string;
  /** The SHA-256 of the body's UTF-8 bytes, in hex. */
  readonly digest: string;
  readonly body: string;
  /** A read returns bytes and a digest, never a certification. */
  readonly certified: false;
}
export interface ReadRefusal {
  readonly ok: false;
  readonly code: ReadCode;
  readonly message: string;
  /** The record the locator reached, once it reached one. */
  readonly identity?: string;
  /**
   * The workspace path the refusal concerns: a line locator's source, the source of a record whose fragment is missing
   * or whose placement is refused (with its line), or the file a source locator names.
   */
  readonly path?: string;
  readonly line?: number;
  /**
   * For a line no admitted record spans, what the workspace's sources hold in its file: `refused` when admission
   * refused records there, else `admitted` when admitted records there span other lines. Absent when no record of the
   * workspace's sources is in that file. For an identity, `refused` when a source holds it and admission refused it.
   */
  readonly file?: 'admitted' | 'refused';
  /** For an identity a source holds whose record admission refused, the reason admission gives (db `refused`). */
  readonly reason?: string;
}
export type ReadResult = { readonly ok: true; readonly body: ReadBody } | ReadRefusal;

const IDENTITY = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const LINE = /^(.+):([1-9][0-9]*)$/;
/** The locator `text` spells, or undefined when it spells none of the four forms. */
export function parseLocator(text: string): Locator | undefined {
  const line = LINE.exec(text);
  if (line !== null) {
    const number = Number(line[2]);
    return Number.isSafeInteger(number) ? freeze({ form: 'line', path: line[1]!, line: number }) : undefined;
  }
  const at = text.indexOf('#'),
    identity = at < 0 ? text : text.slice(0, at);
  if (!IDENTITY.test(identity)) return undefined;
  if (at < 0) return freeze({ form: 'identity', identity });
  const fragment = text.slice(at + 1),
    [phase, primitive, ...rest] = fragment.split('/');
  if (phase !== undefined && primitive !== undefined && rest.length === 0 && isPhase(phase) && isPrimitive(primitive))
    return freeze({ form: 'cell', identity, fragment });
  return isRequirementId(fragment) ? freeze({ form: 'requirement', identity, fragment }) : undefined;
}

/**
 * The text at `fragment` of `node`: its cells at a `phase/Primitive` address in source order, else its requirement with
 * that id. Undefined when the record has neither, which is also what a request mention's fragment is checked against.
 */
export function fragmentText(node: Node, fragment: string): string | undefined {
  const parts = [
    ...node.cells.filter((cell) => `${cell.phase}/${cell.primitive}` === fragment).map((cell) => cell.text),
    ...node.requirements.filter((requirement) => requirement.id === fragment).map((requirement) => requirement.text),
  ];
  return parts.length === 0 ? undefined : parts.join('\n');
}

/** A line terminator a regular expression's `.` does not match, which no heading text holds. */
const TERMINATOR = /[\n\r\u2028\u2029]/;
const blank = (character: string | undefined): boolean => character === ' ' || character === '\t';
/**
 * The ATX heading `line` opens, read in time linear in the line: up to three spaces, one to six `#` followed by a space,
 * a tab or the end, then the text with its surrounding spaces and tabs and a closing `#` run that a space or tab
 * precedes removed. Undefined for any other line.
 */
function atxHeading(line: string): { readonly depth: number; readonly text: string } | undefined {
  let at = 0;
  while (at < 3 && line[at] === ' ') at++;
  const open = at;
  while (line[at] === '#') at++;
  const depth = at - open;
  if (depth === 0 || depth > 6 || (at < line.length && !blank(line[at]))) return undefined;
  const rest = line.slice(at);
  if (TERMINATOR.test(rest)) return undefined;
  let start = 0,
    end = rest.length;
  while (start < end && blank(rest[start])) start++;
  while (end > start && blank(rest[end - 1])) end--;
  let run = end;
  while (run > start && rest[run - 1] === '#') run--;
  if (run < end && run > start && blank(rest[run - 1])) {
    end = run;
    while (end > start && blank(rest[end - 1])) end--;
  }
  return { depth, text: rest.slice(start, end) };
}
const SETEXT = /^ {0,3}(?:=+|-+) *$/;
type MarkdownContainer = { readonly indent: number; empty: boolean } | 'quote';

/** Structural tabs use four-column stops; the original line, heading text and returned bytes are never expanded. */
function blockLine(line: string): string {
  let added = 0;
  return line.replace(/\t/g, (_, offset: number) => {
    const width = 4 - ((offset + added) % 4);
    added += width - 1;
    return ' '.repeat(width);
  });
}
/**
 * One structural line, its tabs expanded, with what one backward pass learns of it, so each question asked of the text
 * from an offset (the content left after its container prefixes) is answered without rereading the rest of the line:
 * the last character that is not a space, the last line terminator, and where a thematic break may start.
 */
interface ScannedLine {
  readonly text: string;
  /** The index of the last character that is not a space, -1 when there is none: the text from `at` is blank past it. */
  readonly last: number;
  /** The index of the last terminator `.` does not match, -1 when there is none. */
  readonly terminator: number;
  /** The least index from which the text holds only spaces and one of `*`, `-` or `_`. */
  readonly rule: number;
  /** The index of the third-last such character from `rule` on, -1 when there are fewer than three. */
  readonly third: number;
}
function scan(text: string): ScannedLine {
  let last = -1,
    terminator = -1,
    rule = text.length,
    third = -1,
    kind: string | undefined,
    count = 0,
    uniform = true;
  for (let at = text.length - 1; at >= 0; at--) {
    const character = text[at]!;
    if (last < 0 && character !== ' ') last = at;
    if (terminator < 0 && TERMINATOR.test(character)) terminator = at;
    if (!uniform) continue;
    if (character === ' ') rule = at;
    else if (
      character === kind ||
      (kind === undefined && (character === '*' || character === '-' || character === '_'))
    ) {
      kind = character;
      rule = at;
      if (++count === 3) third = at;
    } else uniform = false;
  }
  return { text, last, terminator, rule, third };
}
/** The index past up to three spaces at `at`. */
function indented(text: string, at: number): number {
  let end = at;
  while (end < at + 3 && text[end] === ' ') end++;
  return end;
}
/** A thematic break from `at`: up to three spaces, then three or more of one of `*`, `-` or `_`, with spaces only. */
function breakAt(line: ScannedLine, at: number): boolean {
  if (at < line.rule || line.third < 0) return false;
  const first = indented(line.text, at);
  return first < line.text.length && line.text[first] !== ' ' && first <= line.third;
}
/** The width of the block quote marker at `at` (up to three spaces, `>` and one optional space), or -1. */
function quoteAt(text: string, at: number): number {
  const start = indented(text, at);
  return text[start] !== '>' ? -1 : start + 1 - at + (text[start + 1] === ' ' ? 1 : 0);
}
/**
 * The code fence at `at`: up to three spaces, then three or more backticks or tildes, the marker, and the rest of the
 * line, which holds no terminator; undefined for any other text.
 */
function fenceAt(line: ScannedLine, at: number): { readonly marker: string; readonly rest: number } | undefined {
  const { text } = line,
    start = indented(text, at),
    character = text[start];
  if (character !== '`' && character !== '~') return undefined;
  let end = start;
  while (text[end] === character) end++;
  return end - start < 3 || line.terminator >= end ? undefined : { marker: text.slice(start, end), rest: end };
}
/** The opening code fence at `at`; a backtick fence's rest holds no backtick. */
function openingFence(line: ScannedLine, at: number): string | undefined {
  const fence = fenceAt(line, at);
  return fence === undefined || (fence.marker[0] === '`' && line.text.indexOf('`', fence.rest) >= 0)
    ? undefined
    : fence.marker;
}
/**
 * The list item at `at`, read in time linear in its marker and padding: up to three spaces, then `*`, `+` or `-`, or
 * one to nine digits and `.` or `)`, then a space or the end, and no thematic break. Its content indentation includes
 * its marker and one to four padding spaces (one for empty/code items). While a paragraph is open, an empty item or an
 * ordered item that does not start at 1 cannot interrupt it.
 */
function listItem(line: ScannedLine, at: number, paragraph: boolean): Exclude<MarkdownContainer, string> | undefined {
  const { text } = line,
    start = indented(text, at),
    first = text[start];
  let end = start;
  if (first === '*' || first === '+' || first === '-') end++;
  else {
    while (end < start + 10 && text[end]! >= '0' && text[end]! <= '9') end++;
    if (end === start || end - start > 9 || (text[end] !== '.' && text[end] !== ')')) return undefined;
    end++;
  }
  if ((end < text.length && text[end] !== ' ') || breakAt(line, at)) return undefined;
  let content = end;
  while (text[content] === ' ') content++;
  const empty = content >= text.length || TERMINATOR.test(text[content]!),
    marker = text.slice(start, end);
  if (paragraph && (empty || (marker.length > 1 && Number(marker.slice(0, -1)) !== 1))) return undefined;
  const padding = content - end;
  return { indent: end - at + (empty || padding > 4 ? 1 : padding), empty };
}
/** A missing container prefix can continue only a paragraph, not a heading, fence, quote or new list. */
function startsBlock(line: ScannedLine, at: number): boolean {
  return (
    atxHeading(line.text.slice(at)) !== undefined ||
    openingFence(line, at) !== undefined ||
    quoteAt(line.text, at) >= 0 ||
    breakAt(line, at) ||
    listItem(line, at, false) !== undefined
  );
}
/**
 * The first index of `character` in `text` at or after a position, asked for positions that never decrease, as one
 * scan: a position past the last found is searched from there, and every other answer is the one already found.
 */
function scanner(text: string, character: string): (from: number) => number {
  let searched = 0,
    found = text.indexOf(character);
  return (from) => {
    if (from < searched || (found >= 0 && found < from)) found = text.indexOf(character, (searched = from));
    return found;
  };
}
/**
 * `heading` with each inline link or image, `[text](destination)` or `![text](destination)`, replaced by its text:
 * the text runs to the first `]`, which `(` must follow, and the destination to the first `)` after it. Each `]` and
 * `)` is found once, by scanners that only move forward, so the time is linear however many brackets stay unclosed.
 */
function linkText(heading: string): string {
  const close = scanner(heading, ']'),
    paren = scanner(heading, ')'),
    parts: string[] = [];
  let kept = 0,
    open = heading.indexOf('[');
  while (open >= 0) {
    const shut = close(open + 1),
      end = shut < 0 || heading[shut + 1] !== '(' ? -1 : paren(shut + 2);
    if (end < 0) open = heading.indexOf('[', open + 1);
    else {
      // An image's `!` belongs to the link when it follows the previous link.
      parts.push(heading.slice(kept, open > kept && heading[open - 1] === '!' ? open - 1 : open));
      parts.push(heading.slice(open + 1, shut));
      kept = end + 1;
      open = heading.indexOf('[', kept);
    }
  }
  parts.push(heading.slice(kept));
  return parts.join('');
}
/**
 * The anchor of one plain-text ATX heading, as GitHub's slugger gives it: an inline link keeps its text, letters are
 * lowercased, every character other than a letter, mark, decimal or letter number, connector punctuation, `-` or space
 * is dropped, and each space becomes `-`. Code spans and `*` emphasis come out as GitHub's, because their delimiters
 * are dropped. The heading is not rendered first, so underscore emphasis, entity and character references, inline HTML
 * and reference links keep their markup here, and such a heading may have another anchor on GitHub.
 */
export function headingAnchor(heading: string): string {
  return linkText(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');
}
/**
 * The section of markdown `text` under the ATX heading whose `headingAnchor` is `anchor`: from that heading to the next
 * heading of the same or a higher level, headings in fenced code ignored. A repeated anchor takes GitHub's `-1`, `-2`,
 * ... in document order. A leading byte order mark is not part of the first line's heading, as GitHub skips it, and
 * stays in the section. Setext headings and headings inside list items or block quotes are not read. Undefined when no
 * heading has the anchor.
 *
 * A document may be 4 MiB and is read on the long-lived MCP door, so the read takes time linear in the document, up to
 * a logarithmic factor in how deeply its containers nest, whatever it holds before the anchor: each line is scanned
 * once from its end, each list or quote marker it opens or continues is read in time linear in its own width, and a
 * line left blank after its container prefixes continues every open list item up to the first quote or empty item
 * (the only containers a blank line ends), found by a binary search over the open quotes, never by walking the items.
 */
export function markdownSection(text: string, anchor: string): string | undefined {
  const lines = text.split(/(?<=\n)/),
    occurrences = new Map<string, number>(),
    containers: MarkdownContainer[] = [],
    // The indices in `containers` of its block quotes, ascending. An empty list item is always the innermost container:
    // no line opens a container inside one, since a line that continues it is blank or makes it nonempty.
    quotes: number[] = [];
  const unique = (base: string): string => {
    let result = base;
    while (occurrences.has(result)) {
      const count = occurrences.get(base)! + 1;
      occurrences.set(base, count);
      result = `${base}-${count}`;
    }
    occurrences.set(result, 0);
    return result;
  };
  /** The first container from `from` on that a blank line ends, a block quote or an empty item, else their count. */
  const blankStop = (from: number): number => {
    let low = 0,
      high = quotes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (quotes[middle]! < from) low = middle + 1;
      else high = middle;
    }
    const top = containers.length - 1,
      innermost = containers[top],
      stop = low < quotes.length ? quotes[low]! : containers.length;
    return top >= from && top < stop && innermost !== undefined && innermost !== 'quote' && innermost.empty
      ? top
      : stop;
  };
  const truncate = (count: number): void => {
    containers.length = count;
    while (quotes.length > 0 && quotes[quotes.length - 1]! >= count) quotes.pop();
  };
  let fence: string | undefined,
    start: number | undefined,
    level = 0,
    paragraph = false;
  for (const [index, raw] of lines.entries()) {
    const line = (index === 0 ? raw.replace(/^\uFEFF/, '') : raw).replace(/\r?\n$/, ''),
      scanned = scan(blockLine(line)),
      content = scanned.text;
    let at = 0,
      matched = 0;
    // Match existing containers before their leaf block. A fence ends when its containing list or quote ends.
    while (matched < containers.length) {
      if (at > scanned.last) {
        // Blank from here: a quote ends, an empty item's own blank content was the one blank line it may start with,
        // and every other item continues without consuming anything.
        matched = blankStop(matched);
        break;
      }
      const container = containers[matched]!;
      if (container === 'quote') {
        const width = quoteAt(content, at);
        if (width < 0) break;
        at += width;
      } else {
        let spaces = 0;
        while (spaces < container.indent && content[at + spaces] === ' ') spaces++;
        if (spaces < container.indent) break;
        at += container.indent;
        container.empty = false;
      }
      matched++;
    }
    if (matched < containers.length) {
      // The open paragraph belongs to an unmatched container. A new block at the matched level can start any list;
      // the ordered-1/nonempty interruption rule applies only while that paragraph's containers remain matched.
      if (paragraph && at <= scanned.last && !startsBlock(scanned, at)) continue;
      truncate(matched);
      fence = undefined;
      paragraph = false;
    }
    if (fence !== undefined) {
      const closing = fenceAt(scanned, at);
      if (
        closing !== undefined &&
        closing.marker[0] === fence[0] &&
        closing.marker.length >= fence.length &&
        scanned.last < closing.rest
      )
        fence = undefined;
      continue;
    }
    // New containers may nest on one line, but cannot arise inside fenced or indented code.
    for (;;) {
      const quote = quoteAt(content, at);
      if (quote >= 0) {
        quotes.push(containers.length);
        containers.push('quote');
        at += quote;
      } else {
        const item = listItem(scanned, at, paragraph);
        if (item === undefined) break;
        containers.push(item);
        at += item.indent;
      }
      paragraph = false;
    }
    fence = openingFence(scanned, at);
    if (fence !== undefined) {
      paragraph = false;
      continue;
    }
    const heading = atxHeading(content.slice(at));
    if (heading === undefined) {
      paragraph =
        at <= scanned.last &&
        !breakAt(scanned, at) &&
        !(paragraph && SETEXT.test(content.slice(at))) &&
        (paragraph || !content.startsWith('    ', at));
      continue;
    }
    paragraph = false;
    if (containers.length > 0) continue;
    const depth = heading.depth;
    if (start !== undefined) {
      if (depth <= level) return lines.slice(start, index).join('');
    } else if (unique(headingAnchor(atxHeading(line)!.text)) === anchor) {
      start = index;
      level = depth;
    }
  }
  return start === undefined ? undefined : lines.slice(start).join('');
}

/** The record's source locator: the field its word names in SOURCE_LOCATORS, when the record states it unconditionally. */
function sourceOf(node: Node): { readonly field: string; readonly value: string } | undefined {
  if (!Object.hasOwn(SOURCE_LOCATORS, node.discriminator)) return undefined;
  const field = SOURCE_LOCATORS[node.discriminator];
  if (field === undefined) return undefined;
  const value = statedText(node, field);
  return value === undefined ? undefined : { field, value };
}
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const refuse = (code: ReadCode, message: string, where: Omit<ReadRefusal, 'ok' | 'code' | 'message'>): ReadRefusal =>
  freeze({ ok: false, code, message, ...where });
/** A scoped read's one refusal for a locator no admitted record in the scope answers, whatever lies outside it. */
const SCOPED_MISS: ReadRefusal = refuse('IA-RUNTIME-READ-UNADMITTED', 'The locator is not in this scope', {});
/** The record `identity` names in the scope `within`, or undefined for one outside it; a token failure keeps its code. */
function scopedGet(handle: ReadHandle, identity: string, within: string): Node | undefined {
  try {
    return handle.get(identity, { within });
  } catch (error) {
    if (error instanceof DbError && error.code === 'IA-DB-OUT-OF-SCOPE') return undefined;
    throw error;
  }
}

/**
 * The body behind `locator` in the root view of `handle`, or in the scope `within` names, or one refusal:
 * IA-RUNTIME-READ-UNADMITTED when no admitted record answers it (in a scope narrower than the whole workspace, the
 * plain `SCOPED_MISS`; in the root view or a whole-workspace scope, what the workspace's sources hold there),
 * IA-RUNTIME-READ-PLACEMENT for a record at runtime placement unless `includeRuntime` is set,
 * IA-RUNTIME-READ-FRAGMENT when the record has no cell or requirement at the fragment, and IA-RUNTIME-READ-UNREACHABLE
 * when its source locator names a file outside the workspace (or the record's tree), a record of an adopted mount
 * `mounts` binds to no directory, a file the host's reader does not return, bytes that are not UTF-8, or an anchor that
 * no markdown heading of the file has. A locator that spells none of the four forms is IA-RUNTIME-REQUEST-INVALID.
 * A document path is read relative to the record's tree (db `sourceTree`): the workspace root for its own `.ia/src`,
 * a package or installed store directory as it is, and for an adopted mount the directory `mounts` binds its label to.
 */
export function readBody(handle: ReadHandle, locator: string, options: ReadBodyOptions): ReadResult {
  const parsed = parseLocator(locator);
  if (parsed === undefined)
    throw new RuntimeError(
      'IA-RUNTIME-REQUEST-INVALID',
      `Locator '${locator}' is not <identity>, <identity>#<phase>/<Primitive>, <identity>#<REQ-ID> or <path>:<line>`,
    );
  const { within } = options,
    // One disclosure rule for the version 2 Door operations (R12): a whole-workspace token (db PT5) reads what the root
    // view reads, so its misses are the root view's, a record admission refused named with its reason; any narrower
    // scope answers every miss with the one plain refusal, which names nothing beyond it.
    narrowed = within !== undefined && !handle.isCompleteScope(within);
  let node: Node | undefined;
  if (parsed.form === 'line') {
    let path: string | undefined;
    try {
      path = canonicalRoot(parsed.path);
    } catch {
      path = undefined;
    }
    node = handle
      .records(within === undefined ? undefined : { within })
      .filter((r) => r.source.path === path && r.source.line <= parsed.line && parsed.line <= r.source.endLine)
      .sort((a, b) => a.source.endLine - a.source.line - (b.source.endLine - b.source.line))[0];
    if (node === undefined && narrowed) return SCOPED_MISS;
    if (node === undefined) {
      const at = path ?? parsed.path,
        file = handle.refused.some((r) => r.path === path)
          ? 'refused'
          : handle.records().some((r) => r.source.path === path)
            ? 'admitted'
            : undefined;
      return refuse(
        'IA-RUNTIME-READ-UNADMITTED',
        `No admitted record spans ${parsed.path}:${parsed.line}; ${
          file === 'refused'
            ? `admission refused records of ${at}`
            : file === 'admitted'
              ? `the admitted records of ${at} span other lines`
              : path === undefined
                ? `${parsed.path} is not a path relative to the workspace root`
                : path === ''
                  ? `${parsed.path} is the workspace root, a directory and no source`
                  : `no record of this workspace's sources is in ${at}`
        }`,
        { path: at, line: parsed.line, ...(file === undefined ? {} : { file }) },
      );
    }
  } else {
    node = within === undefined ? handle.get(parsed.identity) : scopedGet(handle, parsed.identity, within);
    if (node === undefined && narrowed) return SCOPED_MISS;
    // A source holding the identity whose record admission refused is in the workspace's sources; only an identity no
    // source holds is not.
    const refused = node === undefined ? handle.refused.find((r) => r.identity === parsed.identity) : undefined;
    if (refused !== undefined)
      return refuse(
        'IA-RUNTIME-READ-UNADMITTED',
        `${parsed.identity} is in this workspace's sources, but admission refused it`,
        { identity: parsed.identity, path: refused.path, line: refused.line, file: 'refused', reason: refused.reason },
      );
    if (node === undefined)
      return refuse('IA-RUNTIME-READ-UNADMITTED', `${parsed.identity} is not in this workspace's sources`, {
        identity: parsed.identity,
      });
  }
  const { identity } = node;
  if (node.placement.kind === 'runtime' && options.includeRuntime !== true)
    return refuse(
      'IA-RUNTIME-READ-PLACEMENT',
      `${identity} is at runtime placement (band 0), which a read includes only when asked to`,
      { identity, path: node.source.path, line: node.source.line },
    );
  const found = (kind: ReadBody['kind'], body: string, path?: string): ReadResult =>
    freeze({
      ok: true,
      body: {
        locator,
        identity,
        kind,
        ...(path === undefined ? {} : { path }),
        digest: sha256(body),
        body,
        certified: false,
      },
    });
  if (parsed.form === 'cell' || parsed.form === 'requirement') {
    const body = fragmentText(node, parsed.fragment);
    return body === undefined
      ? refuse('IA-RUNTIME-READ-FRAGMENT', `${identity} has no ${parsed.form} ${parsed.fragment}`, {
          identity,
          path: node.source.path,
          line: node.source.line,
        })
      : found('record', body);
  }
  const source = sourceOf(node);
  if (source === undefined) return found('record', bodyOf(node));
  const { field, value } = source,
    at = value.indexOf('#'),
    file = at < 0 ? value : value.slice(0, at),
    anchor = at < 0 ? undefined : value.slice(at + 1);
  const unreachable = (reason: string, path?: string): ReadRefusal =>
    refuse('IA-RUNTIME-READ-UNREACHABLE', `The ${field} of ${identity}, ${value}, ${reason}`, {
      identity,
      ...(path === undefined ? {} : { path }),
    });
  // A scheme names a resource a read never fetches; it is no workspace path, so it is not canonicalized into one.
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(file)) return unreachable('is a URL, and a read fetches nothing');
  let relative: string;
  try {
    relative = canonicalRoot(file);
  } catch {
    return unreachable('is outside the workspace');
  }
  if (relative === '') return unreachable('names no file');
  // An adopted mount's sources carry the label of its tree, so its documents are read from the directory bound to it;
  // they are outside the mount's revision pin, which covers its `.ia/src` sources only.
  const tree = sourceTree(node.source.path),
    directory = tree.startsWith('.ia/adopted/') ? options.mounts?.get(tree) : tree;
  if (directory === undefined) return unreachable(`is in adopted mount ${tree}, which the read binds to no directory`);
  const path = directory === '' ? relative : `${directory}/${relative}`;
  let bytes: Uint8Array, content: string;
  try {
    bytes = options.read(path);
  } catch (error) {
    return unreachable(`cannot be read: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return unreachable('is not UTF-8 text', path);
  }
  if (anchor === undefined) return found('document', content, path);
  if (!/\.(?:md|markdown)$/i.test(relative))
    return unreachable('has an anchor, but only a markdown file has headings to select', path);
  const section = markdownSection(content, anchor);
  return section === undefined
    ? unreachable(`selects heading #${anchor}, which ${path} does not have`, path)
    : found('document', section, path);
}
