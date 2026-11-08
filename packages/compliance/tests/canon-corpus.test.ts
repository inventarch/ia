import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KERNEL_DIGEST, LANGUAGE_VERSION, buildRegistry, compile, parse } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { load } from '@inventarch/graph';
import { CHECK_IDS, canonSeverity, lawStatuses } from '../src/index.js';

const root = resolve(import.meta.dirname, '../../..');
const CANON = '.ia/src/systems/governance-system/records/canon/';
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
];

describe('the canon corpus', () => {
  it('the canon corpus admits and every canon law is pending', () => {
    const { diagnostics, graph, nodes } = corpus();
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const canon = nodes.filter((node) => node.source.path.startsWith(CANON));
    expect(
      canon
        .filter((node) => node.discriminator === 'law')
        .map((node) => node.name)
        .sort(),
    ).toEqual(LAWS);
    expect(
      canon
        .filter((node) => node.discriminator === 'principle')
        .map((node) => node.name)
        .sort(),
    ).toEqual(['canon-a13-declared-homes', 'canon-c5b-no-consumer-records']);
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
