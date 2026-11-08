import GithubSlugger from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { parseFragment } from 'parse5';

/** One link a Markdown document makes: the href as written, and the line it starts on. */
export interface MarkdownLink {
  readonly href: string;
  readonly kind: 'link' | 'image' | 'definition' | 'html';
  readonly line: number;
}
export interface ParsedMarkdown {
  readonly links: readonly MarkdownLink[];
  readonly ids: ReadonlySet<string>;
}

interface Tree {
  readonly type?: string;
  readonly nodeName?: string;
  readonly value?: string;
  readonly url?: string;
  readonly alt?: string | null;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly children?: readonly Tree[];
  readonly childNodes?: readonly Tree[];
  readonly position?: { readonly start: { readonly line: number } };
}

const grammar = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };

function walk(root: Tree, visit: (node: Tree) => void): void {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    visit(node);
    const children = node.children ?? node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
  }
}

function html(text: string): { links: string[]; ids: string[]; text: string } {
  const links: string[] = [],
    ids: string[] = [],
    words: string[] = [];
  walk(parseFragment(text) as unknown as Tree, (node) => {
    if (node.nodeName === '#text') words.push(node.value ?? '');
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === 'href' || attribute.name === 'src') links.push(attribute.value);
      if (attribute.name === 'id' || attribute.name === 'name') ids.push(attribute.value);
    }
  });
  return { links, ids, text: words.join('') };
}

function headingText(node: Tree): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'html') return html(node.value ?? '').text;
  if (node.type === 'break') return ' ';
  return (node.children ?? []).map(headingText).join('');
}

/** GFM syntax only: links (Markdown and raw HTML) and the section ids a link fragment may name. */
export function parseMarkdown(text: string): ParsedMarkdown {
  const tree = fromMarkdown(text, grammar) as unknown as Tree,
    links: MarkdownLink[] = [],
    ids = new Set<string>(),
    slugger = new GithubSlugger();
  walk(tree, (node) => {
    const line = node.position?.start.line ?? 1;
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition')
      links.push({ href: node.url ?? '', kind: node.type, line });
    if (node.type === 'html') {
      const parsed = html(node.value ?? '');
      for (const href of parsed.links) links.push({ href, kind: 'html', line });
      for (const id of parsed.ids) ids.add(id);
    }
    if (node.type === 'heading') ids.add(slugger.slug(headingText(node)));
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
