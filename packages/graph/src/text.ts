import type { CompiledChild, CompiledRecord, CompiledValue } from '@ia/language';
import { snapshot } from './immutable.js';
import { compare } from './revision.js';
import type { Graph } from './types.js';

// Donor store/text.ts normalization, stopwords and BM25 constants; no source lexer.
const STOPWORDS = new Set(
  'the and for that this with was are has have had not but you your our its all any can did does how what when where which who why will would should could into about from they them then than there here still yet were been being just like make made need want'.split(
    ' ',
  ),
);
export function fold(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}
export function tokenize(text: string): readonly string[] {
  return Object.freeze(
    fold(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 2)
      .map((word) => word.slice(0, 64))
      .filter((word) => !STOPWORDS.has(word)),
  );
}
export interface TextIndex {
  readonly postings: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly lengths: ReadonlyMap<string, number>;
}
export interface SearchHit {
  readonly identity: string;
  readonly score: number;
  readonly terms: readonly string[];
}

function valueText(value: CompiledValue): string {
  switch (value.kind) {
    case 'scalar':
    case 'string':
    case 'prose':
      return value.text;
    case 'ref':
      return `${value.discriminator} ${value.name} ${value.fragment ?? ''}`;
    case 'list':
      return value.items.map(valueText).join(' ');
    case 'block':
    case 'none':
      return '';
  }
}
function recordText(record: CompiledRecord): string {
  const parts = [record.displayName, record.discriminator],
    seen = new Set<number>();
  const collect = (children: readonly CompiledChild[]): void => {
    for (const child of children) {
      const text = valueText('key' in child ? child.value : child.item);
      if (text !== '') {
        parts.push(text);
        seen.add(child.span.line);
      }
      if ('key' in child && child.fields !== undefined) collect(child.fields);
    }
  };
  collect(record.head);
  for (const section of record.sections) collect(section.fields);
  // Semantic products retain body spans. Count their text only if the structured
  // field did not already carry it; never double the weight of a cognition cell.
  for (const product of [...record.cells, ...record.variants, ...record.requirements]) {
    if (seen.has(product.span.line)) continue;
    parts.push('value' in product ? valueText(product.value) : product.text);
    seen.add(product.span.line);
  }
  return parts.join(' ');
}
export function buildTextIndex(records: Iterable<CompiledRecord>): TextIndex {
  const postings = new Map<string, Map<string, number>>(),
    lengths = new Map<string, number>();
  for (const record of records) {
    const tokens = tokenize(recordText(record));
    lengths.set(record.identity, tokens.length);
    for (const token of tokens) {
      const posting = postings.get(token) ?? new Map<string, number>();
      posting.set(record.identity, (posting.get(record.identity) ?? 0) + 1);
      postings.set(token, posting);
    }
  }
  return { postings, lengths }; // load snapshots this internal construction product
}
export function search(graph: Graph, query: string, scope?: ReadonlySet<string>): readonly SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  const visible = [...graph.text.lengths.keys()].filter((id) => scope === undefined || scope.has(id));
  if (terms.length === 0 || visible.length === 0) return Object.freeze([]);
  const allowed = new Set(visible),
    total = visible.length;
  const average = visible.reduce((sum, id) => sum + graph.text.lengths.get(id)!, 0) / total || 1;
  const scores = new Map<string, number>(),
    matched = new Map<string, string[]>();
  for (const term of terms) {
    const postings = [...(graph.text.postings.get(term) ?? [])].filter(([id]) => allowed.has(id));
    if (postings.length === 0) continue;
    const idf = Math.log(1 + (total - postings.length + 0.5) / (postings.length + 0.5));
    for (const [id, tf] of postings) {
      const denominator = tf + 1.2 * (1 - 0.75 + (0.75 * graph.text.lengths.get(id)!) / average);
      scores.set(id, (scores.get(id) ?? 0) + (idf * tf * 2.2) / denominator);
      const hits = matched.get(id) ?? [];
      hits.push(term);
      matched.set(id, hits);
    }
  }
  return snapshot(
    [...scores]
      .filter(([, score]) => score > 0)
      .map(([identity, score]) => ({ identity, score, terms: matched.get(identity)! }))
      .sort((a, b) => b.score - a.score || compare(a.identity, b.identity)),
  );
}
