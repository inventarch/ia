import { EditorSnapshot } from '@inventarch/db/editor';
import { parseLocator, readBody } from '@inventarch/runtime';
import { nativeInput } from './foundation.js';
import { closed, data, digest, fail, frozen, LIMITS } from './format.js';
import { requireSnapshot } from './local.js';
import type { KnowledgeSnapshot } from './local.js';
import { isValidated } from './validate.js';
import type { validateContent } from './validate.js';
export interface KnowledgeCitation {
  readonly format: 'ia.kb.citation.v1';
  readonly kind: 'working-tree' | 'commit';
  readonly sourceId: string;
  readonly snapshot: string;
  readonly locator: string;
  readonly identity: string;
  readonly body: string;
  readonly commit?: string;
}
export function boundedResponse<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.responseBytes)
    fail('Knowledge response exceeds 48 KiB; narrow the request', 'IA-KB-RESPONSE-LIMIT');
  return frozen(value);
}
export function openKnowledgeView(snapshot: KnowledgeSnapshot | ReturnType<typeof validateContent>) {
  const packaged = 'portable' in snapshot;
  if (packaged) {
    if (!isValidated(snapshot)) fail('Validated knowledge package required');
  } else requireSnapshot(snapshot);
  const sourceId = packaged ? snapshot.portable.provenance.sourceId : snapshot.sourceId;
  const pin = packaged ? snapshot.portable.digest : snapshot.digest;
  const commit = packaged ? snapshot.portable.provenance.commit : undefined;
  const records = [...snapshot.records].sort((a, b) => (a.identity < b.identity ? -1 : 1));
  const identities = new Set(records.map((r) => r.identity));
  let reader: EditorSnapshot | undefined = new EditorSnapshot(nativeInput(snapshot.capture));
  const scope = reader.resolveScope({ identities: [...identities] }).token;
  const nativeGraphRevision = snapshot.nativeGraphRevision;
  const admission = {
    ok: snapshot.admission.ok,
    unavailableChecks: snapshot.admission.unavailableChecks,
    meaning: packaged
      ? 'structural-only; checks not evaluated are not passes'
      : 'selected admitted records only; workspace checks not evaluated',
    ...(!packaged ? { scope: snapshot.admission.scope, checks: snapshot.admission.checks } : {}),
  };
  let edges = snapshot.edges,
    unavailable = packaged ? [] : snapshot.unavailable;
  let active = true;
  const available = () => {
    if (!active) fail('Knowledge view is closed', 'IA-KB-SNAPSHOT-UNAVAILABLE');
  };
  const citation = (locator: string, identity: string, body: string): KnowledgeCitation =>
    frozen({
      format: 'ia.kb.citation.v1',
      kind: packaged ? 'commit' : 'working-tree',
      sourceId,
      snapshot: pin,
      locator,
      identity,
      body,
      ...(commit === undefined ? {} : { commit }),
    });
  const read = (locator: string) => {
    available();
    const parsed = typeof locator === 'string' ? parseLocator(locator) : undefined;
    if (!parsed || parsed.form === 'line' || !identities.has(parsed.identity))
      return fail('Knowledge not available in this scope', 'IA-KB-UNAVAILABLE');
    const record = records.find((r) => r.identity === parsed.identity)!;
    let body = record.body,
      bodyPin = record.bodySha256;
    if ('fragment' in parsed) {
      const result = readBody(reader!, locator, {
        within: scope,
        read: () => fail('Native fragments read no document'),
      });
      if (!result.ok) return fail('Knowledge fragment unavailable', 'IA-KB-UNAVAILABLE');
      body = result.body.body;
      bodyPin = result.body.digest;
    }
    return boundedResponse({
      identity: record.identity,
      body,
      bodySha256: bodyPin,
      sourcePath: record.sourcePath,
      bodyPath: 'fragment' in parsed ? null : record.bodyPath,
      certified: false,
      authority: 'inert',
      citation: citation(locator, record.identity, bodyPin),
    });
  };
  return {
    nativeGraphRevision,
    check() {
      available();
      return boundedResponse({
        ok: admission.ok && unavailable.length === 0,
        sourceId,
        snapshot: pin,
        records: records.length,
        unavailable,
        admission,
      });
    },
    read,
    resolveCitation(input: unknown) {
      available();
      const c = data<KnowledgeCitation>(input, 16 * 1024);
      closed(
        c,
        commit === undefined
          ? ['format', 'kind', 'sourceId', 'snapshot', 'locator', 'identity', 'body']
          : ['format', 'kind', 'sourceId', 'snapshot', 'locator', 'identity', 'body', 'commit'],
      );
      if (
        c.format !== 'ia.kb.citation.v1' ||
        c.snapshot !== pin ||
        c.sourceId !== sourceId ||
        c.kind !== (packaged ? 'commit' : 'working-tree') ||
        c.commit !== commit
      )
        return fail('Pinned knowledge snapshot unavailable', 'IA-KB-SNAPSHOT-UNAVAILABLE');
      const result = read(c.locator);
      if (digest(c) !== digest(result.citation))
        return fail('Pinned knowledge snapshot unavailable', 'IA-KB-SNAPSHOT-UNAVAILABLE');
      return result;
    },
    search(query: string, limit: number = LIMITS.results) {
      available();
      if (
        typeof query !== 'string' ||
        !query.trim() ||
        query.length > LIMITS.query ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > LIMITS.results
      )
        fail('Invalid query or result limit');
      const term = query.toLowerCase();
      const hits = records.filter((r) => (r.body + '\n' + r.recordText).toLowerCase().includes(term));
      const results = hits.slice(0, limit).map((r) => {
        const text = r.body.toLowerCase().includes(term) ? r.body : r.recordText,
          at = text.toLowerCase().indexOf(term),
          start = Math.max(0, at - 80);
        return {
          identity: r.identity,
          excerpt: text.slice(start, start + 240),
          citation: citation(r.identity, r.identity, r.bodySha256),
        };
      });
      const result = {
        sourceId,
        snapshot: pin,
        results,
        truncated: hits.length > results.length,
        incomplete: unavailable.length > 0,
      };
      while (Buffer.byteLength(JSON.stringify(result)) > LIMITS.responseBytes && results.length) {
        results.pop();
        result.truncated = true;
      }
      return boundedResponse(result);
    },
    traverse(identity: string, steps: number = LIMITS.steps) {
      available();
      if (!identities.has(identity)) return fail('Knowledge not available in this scope', 'IA-KB-UNAVAILABLE');
      if (!Number.isSafeInteger(steps) || steps < 1 || steps > LIMITS.steps) fail('Invalid traversal limit');
      const seen = new Set([identity]),
        queue = [identity],
        selected: (typeof edges)[number][] = [];
      let truncated = false;
      while (queue.length) {
        const from = queue.shift()!;
        for (const edge of edges.filter((e) => e.from === from && identities.has(e.to))) {
          if (selected.length >= steps) {
            truncated = true;
            break;
          }
          selected.push(edge);
          if (!seen.has(edge.to)) {
            seen.add(edge.to);
            queue.push(edge.to);
          }
        }
        if (truncated) break;
      }
      return boundedResponse({ sourceId, snapshot: pin, identities: [...seen], edges: selected, truncated });
    },
    close() {
      if (active) {
        active = false;
        reader!.close();
        reader = undefined;
        records.length = 0;
        identities.clear();
        edges = [];
        unavailable = [];
      }
    },
  };
}
