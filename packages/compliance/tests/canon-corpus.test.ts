import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, buildRegistry, compile, parse } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { load } from '@inventarch/graph';
import { CHECK_IDS, canonSeverity, lawStatuses } from '../src/index.js';

const root = resolve(import.meta.dirname, '../../..');
/** Canon records sit in the folder of the system owning their word: `.ia/src/systems/<system>/records/canon/`. */
const CANON = /^\.ia\/src\/systems\/([^/]+)\/records\/canon\//;
const canonSystem = (path: string): string | undefined => CANON.exec(path)?.[1];
const SKIP = new Set(['node_modules', 'dist', '.git']);

/** The repository's own `.ia/src`, read as `pnpm native:check` reads it, compiled in two passes and loaded as a graph. */
function corpus() {
  const inputs: { path: string; text: string; location: Location }[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
      if (SKIP.has(entry.name.toLowerCase())) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.ia'))
        inputs.push({
          path: child,
          text: readFileSync(resolve(root, child), 'utf8'),
          location: child.startsWith('.ia/src/floor/')
            ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
            : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
        });
    }
  };
  walk('.ia/src');
  inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = inputs.map((input) => ({ ...parse(input.text, input.path), location: input.location }));
  const registered = buildRegistry(sources);
  const first = sources.flatMap((s) => compile(s.ast, registered.registry, s.location, []).records);
  const results = sources.map((s) =>
    compile(
      s.ast,
      registered.registry,
      s.location,
      first.filter((r) => r.source.path !== s.ast.path),
    ),
  );
  const diagnostics = [
    ...sources.flatMap((s) => s.diagnostics),
    ...registered.diagnostics,
    ...results.flatMap((r) => r.diagnostics),
  ];
  const graph = load(
    results.flatMap((r) => r.records),
    registered.registry,
    { sources: inputs, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' },
  );
  return { diagnostics, graph, nodes: [...graph.nodes.values()] };
}

const LAWS = [
  'canon-a14-work-placement',
  'canon-a6-source-roots',
  'canon-c12-teaching-links',
  'canon-c4-kit-words',
  'canon-c5a-kit-workspace',
  'canon-c6-kit-scripts',
  'canon-d9-no-secrets',
  'canon-e4-local-tighten',
  'canon-e5-mandate-narrow',
  'canon-steward-authority',
];
const PRINCIPLES = [
  'canon-a13-declared-homes',
  'canon-c5b-no-consumer-records',
  'canon-customer-corpus-workspace',
  'canon-distribution-release-form',
  'canon-hosted-method-path',
  'canon-kits-mint-no-words',
  'canon-one-registration-owner',
  'canon-storage-authority-before-medium',
  'canon-storage-one-authority',
];
const CONVENTIONS = [
  'canon-ask-before-boundary',
  'canon-boundary-authority-order',
  'canon-boundary-independence',
  'canon-boundary-made-by-many',
  'canon-boundary-order',
  'canon-boundary-smaller',
  'canon-boundary-verdict',
  'canon-change-acceptance',
  'canon-change-cadence',
  'canon-change-proposal',
  'canon-one-workspace-per-root',
  'canon-rule-suspension',
  'canon-split-ask',
  'canon-split-on-fact',
  'canon-split-triggers',
  'canon-steward-definition-approval',
  'canon-steward-judgement',
  'canon-steward-local-variation',
  'canon-storage-declare-exceptions',
  'canon-storage-medium',
  'canon-storage-review-default',
];

describe('the canon corpus', () => {
  it('the canon corpus admits and every canon law is pending', () => {
    const { diagnostics, graph, nodes } = corpus();
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const canon = nodes.filter((node) => CANON.test(node.source.path));
    // A14 constrains a work-system word, so it lives with work-system; every other canon record with governance-system.
    for (const node of canon)
      expect(canonSystem(node.source.path), node.identity).toBe(
        node.name.startsWith('canon-a14') || node.name === 'ia-canon-work' ? 'work-system' : 'governance-system',
      );
    const named = (discriminator: string) =>
      canon
        .filter((node) => node.discriminator === discriminator)
        .map((node) => node.name)
        .sort();
    expect(named('law')).toEqual(LAWS);
    expect(named('principle')).toEqual(PRINCIPLES);
    expect(named('convention')).toEqual(CONVENTIONS);
    const statuses = lawStatuses(nodes, [], graph).filter((status) =>
      canon.some((node) => node.identity === status.identity),
    );
    expect(statuses).toHaveLength(LAWS.length);
    for (const status of statuses)
      expect(status, status.identity).toMatchObject({
        severity: 'advisory',
        state: 'pending',
        checks: [],
        suspendedBy: null,
      });
    // Pending laws enforce nothing, so no built-in canon rule is active.
    for (const id of CHECK_IDS.filter((id) => id.startsWith('CANON-')))
      expect(canonSeverity(nodes, id, graph), id).toBeNull();
  });
});
