/** One link a Markdown document makes: the href as written, and the line it starts on. */
export interface MarkdownLink {
  readonly href: string;
  readonly kind: 'link' | 'image' | 'definition' | 'html';
  readonly line: number;
}
export interface ScannedMarkdown {
  readonly links: readonly MarkdownLink[];
  readonly ids: ReadonlySet<string>;
}

/**
 * A GitHub-style slugger: lower-case, punctuation other than `-` and `_` removed, spaces to `-`; a repeat gets `-1`,
 * `-2`, and so on.
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    let slug = base;
    while (seen.has(slug)) {
      const next = (seen.get(base) ?? 0) + 1;
      seen.set(base, next);
      slug = `${base}-${next}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

/*
 * The scanner reads Markdown that third-party kits ship, so every rule here runs in linear time on any input. Each
 * hand-written scan below replaces a backtracking regex that was quadratic on a crafted line, and states the regex whose
 * matches it reproduces exactly. The regexes kept are anchored or unambiguous, so they are linear too.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DEFINITION = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:\s*(<[^>\n]*>|\S+)/;
const ATTRIBUTE = /\b(href|src|id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/gi;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const SPACE = /\s/;

/** A character `\s` matches. */
const isSpace = (char: string | undefined): boolean => char !== undefined && SPACE.test(char);
/** A space or a tab, the blanks around an ATX heading's marks. */
const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t';
/** A character `.` does not match. */
const isTerminator = (char: string | undefined): boolean =>
  char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
/** `\\.` matches at `at`: a backslash and a character `.` matches. */
const isEscape = (text: string, at: number): boolean =>
  text[at] === '\\' && at + 1 < text.length && !isTerminator(text[at + 1]);

const unescape = (text: string): string => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const destination = (raw: string): string => unescape(raw.startsWith('<') ? raw.slice(1, -1) : raw);

/**
 * Code spans hold no links: each is blanked, keeping the columns. The matches of
 * `` /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g ``: an opening run (a whole backtick run, or failing that each shorter tail of it)
 * closes at the next whole run of the same length. Each run is visited once and each length's runs are consumed in
 * order, so the scan is linear.
 */
function withoutCodeSpans(line: string): string {
  const runs: { start: number; length: number }[] = [];
  for (let at = 0; at < line.length; ) {
    if (line[at] !== '`') {
      at++;
      continue;
    }
    const start = at;
    while (line[at] === '`') at++;
    runs.push({ start, length: at - start });
  }
  if (runs.length < 2) return line;
  const byLength = new Map<number, number[]>(),
    cursor = new Map<number, number>();
  runs.forEach((run, index) => {
    const same = byLength.get(run.length);
    if (same === undefined) byLength.set(run.length, [index]);
    else same.push(index);
  });
  /** The first run of `length` after run `after`; `after` never decreases, so each cursor only moves forward. */
  const following = (length: number, after: number): number | undefined => {
    const same = byLength.get(length);
    if (same === undefined) return undefined;
    let at = cursor.get(length) ?? 0;
    while (at < same.length && same[at]! <= after) at++;
    cursor.set(length, at);
    return same[at];
  };
  let blanked = '',
    copied = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    for (let length = run.length; length > 0; length--) {
      const closing = following(length, index);
      if (closing === undefined) continue;
      const from = run.start + run.length - length,
        to = runs[closing]!.start + length;
      blanked += line.slice(copied, from) + ' '.repeat(to - from);
      copied = to;
      index = closing;
      break;
    }
  }
  return blanked + line.slice(copied);
}

/**
 * The first index of `char` at or after `from`, for a caller whose `from` never decreases: a search resumes only once
 * `from` passes the last index found, so all the searches together read `text` once.
 */
function forward(text: string, char: string): (from: number) => number {
  let found = -2;
  return (from) => (found === -1 || found >= from ? found : (found = text.indexOf(char, from)));
}

/**
 * Each `<prefix><label>]<open><target><close>` as its label alone, where the label runs to the first `]` and the target
 * to the first `close`: one pass of `.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')` for `('![', '(', ')')`, of the same
 * without `!` for `('[', '(', ')')`, and of `/\[([^\]]*)\]\[[^\]]*\]/g` for `('[', '[', ']')`.
 */
function labelsOnly(text: string, prefix: string, open: string, close: string): string {
  const label = forward(text, ']'),
    target = forward(text, close);
  let kept = '',
    copied = 0,
    at = text.indexOf(prefix);
  while (at >= 0) {
    const end = label(at + prefix.length);
    // No `]` is left, or none of the later openers can find a `close`: nothing further matches.
    if (end < 0) break;
    if (text[end + 1] !== open) {
      at = text.indexOf(prefix, at + 1);
      continue;
    }
    const stop = target(end + 2);
    if (stop < 0) break;
    kept += text.slice(copied, at) + text.slice(at + prefix.length, end);
    copied = stop + 1;
    at = text.indexOf(prefix, copied);
  }
  return kept + text.slice(copied);
}

/**
 * Every `<...>` span removed, from each `<` to the first `>` after it: what `.replace(/<[^>]*>/g, '')` removes, and
 * complete in one pass, since a `<` that is kept has no `>` after it and so cannot start a tag.
 */
function withoutTags(text: string): string {
  let kept = '',
    copied = 0,
    open = text.indexOf('<');
  while (open >= 0) {
    const close = text.indexOf('>', open + 1);
    if (close < 0) break;
    kept += text.slice(copied, open);
    copied = close + 1;
    open = text.indexOf('<', copied);
  }
  return kept + text.slice(copied);
}

/** The text a heading contributes to its slug: links and images as their text, code and emphasis marks bare. */
function headingText(raw: string): string {
  return withoutTags(labelsOnly(labelsOnly(labelsOnly(raw, '![', '(', ')'), '[', '(', ')'), '[', '[', ']'))
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=$|[^\p{L}\p{N}])/gu, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .trim();
}

/**
 * An ATX heading's content, or null when `line` is none: what group 1 of
 * `/^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/` captures (`''` when it captures nothing). Up to three spaces,
 * one to six `#`, then the end or a blank; the content runs from the first non-blank to the end without trailing blanks
 * and without a closing `#` run that a blank precedes. A line `.` cannot cross after the marks is none.
 */
function atxContent(line: string): string | null {
  let at = 0;
  while (line[at] === ' ') at++;
  if (at > 3) return null;
  const marks = at;
  while (line[at] === '#') at++;
  if (at === marks || at - marks > 6) return null;
  if (at === line.length) return '';
  if (!isBlank(line[at])) return null;
  for (let index = at; index < line.length; index++) if (isTerminator(line[index])) return null;
  while (isBlank(line[at])) at++;
  let end = line.length;
  while (end > at && isBlank(line[end - 1])) end--;
  let closing = end;
  while (closing > at && line[closing - 1] === '#') closing--;
  if (closing < end && closing > at && isBlank(line[closing - 1])) {
    end = closing;
    while (end > at && isBlank(line[end - 1])) end--;
  }
  return line.slice(at, end);
}

/** For each index of `text` and its end, the first index at or after it holding `char`, else -1. */
function nextIndex(text: string, char: string): Int32Array {
  const next = new Int32Array(text.length + 1).fill(-1);
  for (let at = text.length - 1; at >= 0; at--) next[at] = text[at] === char ? at : next[at + 1]!;
  return next;
}

/**
 * The inline links and images of a line, as the global regex
 * `/(!?)\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g`
 * matches them, with its destination (group 3) as written. Each repeated part of that regex is deterministic, so where a
 * scan of it stops from each index is computed once, right to left; each `[` is then tried in constant time.
 */
function inlineLinks(line: string): { raw: string; image: boolean }[] {
  const found: { raw: string; image: boolean }[] = [];
  if (!line.includes('](')) return found;
  const size = line.length,
    space = new Int32Array(size + 1),
    label = new Int32Array(size + 1),
    inner = new Int32Array(size + 1),
    plain = new Int32Array(size + 1),
    bracket = nextIndex(line, ']'),
    quote = nextIndex(line, '"'),
    apostrophe = nextIndex(line, "'"),
    paren = nextIndex(line, ')'),
    angle = nextIndex(line, '>');
  /** Where a title that opens with `opener` looks for its close. */
  const closes = (opener: string | undefined): Int32Array | undefined =>
    opener === '"' ? quote : opener === "'" ? apostrophe : opener === '(' ? paren : undefined;
  space[size] = label[size] = inner[size] = plain[size] = size;
  for (let at = size - 1; at >= 0; at--) {
    const char = line[at]!,
      escape = isEscape(line, at);
    // `\s*`: the first index that is not a space.
    space[at] = isSpace(char) ? space[at + 1]! : at;
    // The label, `(?:[^[\]\\]|\\.|\[[^\]]*\])*`.
    if (char === ']') label[at] = at;
    else if (char === '\\') label[at] = escape ? label[at + 2]! : at;
    else if (char === '[') label[at] = bracket[at + 1]! < 0 ? at : label[bracket[at + 1]! + 1]!;
    else label[at] = label[at + 1]!;
    // Inside a bracketed destination part, `(?:[^\s()\\]|\\.)*`.
    if (isSpace(char) || char === '(' || char === ')') inner[at] = at;
    else if (char === '\\') inner[at] = escape ? inner[at + 2]! : at;
    else inner[at] = inner[at + 1]!;
    // A plain destination, `(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*`.
    if (isSpace(char) || char === ')') plain[at] = at;
    else if (char === '\\') plain[at] = escape ? plain[at + 2]! : at;
    else if (char === '(') plain[at] = line[inner[at + 1]!] === ')' ? plain[inner[at + 1]! + 1]! : at;
    else plain[at] = plain[at + 1]!;
  }
  /** Where `(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)` ends when it starts at `from`, else -1. */
  const tail = (from: number): number => {
    const after = space[from]!,
      opener = line[after];
    const titled = after > from ? closes(opener) : undefined;
    if (titled !== undefined) {
      const close = titled[after + 1]!;
      if (close >= 0 && line[space[close + 1]!] === ')') return space[close + 1]! + 1;
    }
    return opener === ')' ? after + 1 : -1;
  };
  let from = 0,
    at = line.indexOf('[');
  while (at >= 0) {
    const end = label[at + 1]!;
    let stop = -1,
      raw = '';
    if (line[end] === ']' && line[end + 1] === '(') {
      const open = end + 2,
        start = space[open]!;
      // The destination in the regex's order: `<...>`, then the plain form, then empty after the leading spaces.
      if (line[start] === '<' && angle[start + 1]! >= 0) {
        stop = tail(angle[start + 1]! + 1);
        raw = line.slice(start, angle[start + 1]! + 1);
      }
      if (stop < 0) {
        stop = tail(plain[start]!);
        raw = line.slice(start, plain[start]!);
      }
      if (stop < 0 && start > open) {
        stop = tail(start - 1);
        raw = '';
      }
    }
    if (stop < 0) {
      at = line.indexOf('[', at + 1);
      continue;
    }
    found.push({ raw, image: at > from && line[at - 1] === '!' });
    from = stop;
    at = line.indexOf('[', stop);
  }
  return found;
}

/** Links (Markdown and raw HTML attributes) and section ids of a GFM document, without a parser; fenced code is skipped. */
export function scanMarkdown(text: string): ScannedMarkdown {
  const links: MarkdownLink[] = [],
    ids = new Set<string>(),
    slug = createSlugger(),
    lines = text.split(/\r\n|\r|\n/);
  let fence: { char: string; length: number } | null = null;
  lines.forEach((raw, index) => {
    const line = index + 1;
    const opening = FENCE.exec(raw);
    if (fence !== null) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw);
      if (closing !== null && closing[1]![0] === fence.char && closing[1]!.length >= fence.length) fence = null;
      return;
    }
    if (opening !== null && !(opening[1]![0] === '`' && raw.slice(opening[0].length).includes('`'))) {
      fence = { char: opening[1]![0]!, length: opening[1]!.length };
      return;
    }
    const heading = atxContent(raw);
    if (heading !== null) ids.add(slug(headingText(heading)));
    else if (SETEXT.test(raw) && index > 0 && /\S/.test(lines[index - 1]!) && !/^\s{4}/.test(lines[index - 1]!)) {
      const previous = lines[index - 1]!;
      if (atxContent(previous) === null && !FENCE.test(previous)) ids.add(slug(headingText(previous.trim())));
    }
    const code = withoutCodeSpans(raw);
    const definition = DEFINITION.exec(code);
    if (definition !== null) links.push({ href: destination(definition[1]!), kind: 'definition', line });
    for (const link of inlineLinks(code))
      links.push({ href: destination(link.raw), kind: link.image ? 'image' : 'link', line });
    for (const match of code.matchAll(ATTRIBUTE)) {
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      const name = match[1]!.toLowerCase();
      if (name === 'href' || name === 'src') links.push({ href: value, kind: 'html', line });
      else ids.add(value);
    }
  });
  return { links, ids };
}

/** Split URI components before percent-decoding: an encoded # or ? is part of the filename. Null for a non-local href. */
export function localTarget(href: string): { pathname: string; fragment: string } | null {
  if (/^[a-z][a-z0-9+.-]*:|^\//i.test(href) || href.includes('${') || href.startsWith('{')) return null;
  const hash = href.indexOf('#'),
    beforeFragment = hash < 0 ? href : href.slice(0, hash),
    query = beforeFragment.indexOf('?');
  return {
    pathname: decodeURIComponent(query < 0 ? beforeFragment : beforeFragment.slice(0, query)),
    fragment: hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1)),
  };
}
