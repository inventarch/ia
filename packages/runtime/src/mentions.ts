import { KINDS } from '@inventarch/language';
import type { EdgeReference } from '@inventarch/language';
import type { Node } from '@inventarch/graph';
import type { ReadHandle } from '@inventarch/db';
import { fragmentText } from './locator.js';

interface Mention {
  readonly address: string;
  readonly reference?: EdgeReference;
  readonly kind?: string;
  readonly name?: string;
  readonly fragment?: string;
}
const SIGIL = /^@([a-z][a-z0-9-]*)\s+("(?:\\.|[^"\\])*"|[^\s#]+)(?:#([^\s]+))?$/i;
export function subjectMention(subject: string | EdgeReference): Mention {
  if (typeof subject !== 'string')
    return {
      address: subject.kind === 'identity' ? subject.identity : `@${subject.discriminator} ${subject.name}`,
      reference: subject,
    };
  const sigil = SIGIL.exec(subject);
  if (sigil !== null) {
    let name = sigil[2]!;
    if (name.startsWith('"'))
      try {
        name = JSON.parse(name) as string;
      } catch {
        return { address: subject };
      }
    return {
      address: subject,
      reference: {
        kind: 'ref',
        discriminator: sigil[1]!.toLowerCase(),
        name,
        ...(sigil[3] === undefined ? {} : { fragment: sigil[3] }),
      },
    };
  }
  const [base = '', fragment] = subject.split('#'),
    pieces = base.split('/');
  if (pieces.length === 4)
    return {
      address: subject,
      reference: { kind: 'identity', identity: base, ...(fragment === undefined ? {} : { fragment }) },
    };
  return {
    address: subject,
    ...(pieces.length === 2 ? { kind: pieces[0]!, name: pieces[1]! } : { name: base }),
    ...(fragment === undefined ? {} : { fragment }),
  };
}
export function mentions(text: string): readonly Mention[] {
  const found: { start: number; end: number; mention: Mention }[] = [];
  const patterns = [
    /@[a-z][a-z0-9-]*\s+(?:"(?:\\.|[^"\\])*"|[a-z0-9][a-z0-9_-]*)(?:#[a-z0-9/-]+)?/gi,
    new RegExp(`\\b[a-z0-9-]+/(?:${KINDS.join('|')})/[a-z0-9-]+/[a-z0-9-]+(?:#[a-z0-9/-]+)?`, 'gi'),
    new RegExp(`(?<![a-z0-9/-])(?:${KINDS.join('|')})/[a-z0-9-]+(?:#[a-z0-9/-]+)?(?![a-z0-9/-])`, 'gi'),
  ];
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) {
      const start = match.index,
        end = start + match[0].length;
      if (!found.some((item) => start < item.end && end > item.start))
        found.push({ start, end, mention: subjectMention(match[0]) });
    }
  return found.sort((a, b) => a.start - b.start).map((item) => item.mention);
}
export function resolveMention(
  handle: ReadHandle,
  within: string,
  nodes: readonly Node[],
  mention: Mention,
): { readonly node: Node; readonly fragment?: string } | { readonly detail: string } {
  let identity: string,
    fragment = mention.fragment;
  if (mention.reference !== undefined) {
    const result = handle.resolve(mention.reference, { within });
    if (!result.ok) return { detail: result.code };
    identity = result.identity;
    fragment = result.fragment;
  } else {
    const matches = nodes.filter(
      (n) =>
        (n.name === mention.name?.toLowerCase() || n.displayName.toLowerCase() === mention.name?.toLowerCase()) &&
        (mention.kind === undefined || n.kind === mention.kind),
    );
    if (matches.length !== 1)
      return { detail: matches.length === 0 ? 'IA-GRAPH-TARGET-MISSING' : 'IA-GRAPH-TARGET-AMBIGUOUS' };
    identity = matches[0]!.identity;
  }
  const node = nodes.find((n) => n.identity === identity)!;
  if (fragment !== undefined && fragmentText(node, fragment) === undefined)
    return { detail: `No cell or requirement fragment '${fragment}'` };
  return { node, ...(fragment === undefined ? {} : { fragment }) };
}
