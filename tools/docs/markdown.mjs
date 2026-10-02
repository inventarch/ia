import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { parseFragment } from 'parse5';
import GithubSlugger from 'github-slugger';

const grammar = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };

function walk(root, visit) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    const children = node.children ?? node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
}

function html(text) {
  const links = [],
    ids = [],
    words = [];
  walk(parseFragment(text, { sourceCodeLocationInfo: true }), (node) => {
    if (node.nodeName === '#text') words.push(node.value);
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === 'href' || attribute.name === 'src')
        links.push({
          href: attribute.value,
          attribute: attribute.name,
          offset: node.sourceCodeLocation?.attrs?.[attribute.name]?.startOffset ?? 0,
        });
      if (attribute.name === 'id' || attribute.name === 'name') ids.push(attribute.value);
    }
  });
  return { links, ids, text: words.join('') };
}

function headingText(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'html') return html(node.value).text;
  if (node.type === 'break') return ' ';
  return (node.children ?? []).map(headingText).join('');
}

/** GFM syntax only: no filesystem, network, rendering, or reader-specific access policy. */
export function parseMarkdown(text) {
  const tree = fromMarkdown(text, grammar),
    links = [],
    ids = new Set(),
    slugger = new GithubSlugger();
  walk(tree, (node) => {
    const position = node.position?.start;
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      // Definitions remain authored obligations, even if unused. Reference uses need not duplicate them.
      links.push({ href: node.url, kind: node.type, position });
    }
    if (node.type === 'html') {
      const parsed = html(node.value);
      for (const link of parsed.links)
        links.push({
          href: link.href,
          kind: 'html',
          attribute: link.attribute,
          position,
          offset: (position?.offset ?? 0) + link.offset,
        });
      for (const id of parsed.ids) ids.add(id);
    }
    if (node.type === 'heading') ids.add(slugger.slug(headingText(node)));
  });
  return { links, ids };
}

/** HTML documents have explicit IDs/names, not Markdown headings or examples. */
export function htmlIds(text) {
  return new Set(html(text).ids);
}

/** Split URI components before percent-decoding: an encoded # or ? is part of the filename. */
export function localTarget(href) {
  if (/^[a-z][a-z0-9+.-]*:|^\//i.test(href) || href.includes('${') || href.startsWith('{')) return null;
  const hash = href.indexOf('#'),
    beforeFragment = hash < 0 ? href : href.slice(0, hash);
  const query = beforeFragment.indexOf('?');
  return {
    pathname: decodeURIComponent(query < 0 ? beforeFragment : beforeFragment.slice(0, query)),
    fragment: hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1)),
  };
}
