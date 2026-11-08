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

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE =
  /(!?)\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const DEFINITION = /^ {0,3}\[(?:[^\]\\]|\\.)+\]:\s*(<[^>\n]*>|\S+)/;
const ATTRIBUTE = /\b(href|src|id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/gi;
const ATX = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;

const unescape = (text: string): string => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const destination = (raw: string): string => unescape(raw.startsWith('<') ? raw.slice(1, -1) : raw);
/** Code spans hold no links: each is blanked, keeping the columns. */
function withoutCodeSpans(line: string): string {
  return line.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) => ' '.repeat(span.length));
}
/** The text a heading contributes to its slug: links and images as their text, code and emphasis marks bare. */
function headingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=$|[^\p{L}\p{N}])/gu, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .trim();
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
    const heading = ATX.exec(raw);
    if (heading !== null) ids.add(slug(headingText(heading[1] ?? '')));
    else if (SETEXT.test(raw) && index > 0 && /\S/.test(lines[index - 1]!) && !/^\s{4}/.test(lines[index - 1]!)) {
      const previous = lines[index - 1]!;
      if (!ATX.test(previous) && !FENCE.test(previous)) ids.add(slug(headingText(previous.trim())));
    }
    const code = withoutCodeSpans(raw);
    const definition = DEFINITION.exec(code);
    if (definition !== null) links.push({ href: destination(definition[1]!), kind: 'definition', line });
    for (const match of code.matchAll(INLINE))
      links.push({ href: destination(match[3]!), kind: match[1] === '!' ? 'image' : 'link', line });
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
