/**
 * `ia inspect`: docs/specs/consumer-cli-contract/README.md §2.6.
 *
 * Public inspection only. This module must not import or invoke the private product assessment package: it
 * renders admitted structure — sections, fields, edges, source location — and makes no assessment, score or
 * recommendation. Its `--json` envelope is deliberately not interchangeable with the frozen `ia get` one.
 */
import type { HostObservation } from '@ia/distribution/services';
import { openWorkspaceSession, readInstalledState } from '@ia/distribution/services';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import { pinnedRelease } from './host.js';
import type { Capabilities, Field, Token } from './render.js';
import { atom, document, entry, fieldRows, headerLine, sectionLabel, truncateDigest, words } from './render.js';

type Session = ReturnType<typeof openWorkspaceSession>;
type Record_ = ReturnType<Session['reader']['records']>[number];
type Traversal = ReturnType<Session['reader']['traverse']>;
type Direction = 'in' | 'out' | 'both';

/**
 * The overview's host rows, from observation rather than a literal: one row per registered host, `<host> <status>`,
 * a stale one with its reasons; with no registration, one row saying so. `ia doctor` carries the detail and repairs.
 */
const hostPairs = (hosts: readonly HostObservation[]): readonly (readonly [string, string])[] =>
  hosts.length === 0
    ? [['Host', 'No host registered']]
    : hosts.map((host) => [
        'Host',
        `${host.host} ${host.status}${host.status === 'stale' ? ` (${host.reasons.join(', ')})` : ''}`,
      ]);

/** `packages/db/src/distribution/codec.ts:36`: four lowercase segments, `system/kind/facet/name`. */
export const IDENTITY = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const portable = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\//, '');

interface EdgeRow {
  readonly from: string;
  readonly predicate: string;
  readonly to: string;
  readonly depth: number;
}
/** The traversal's own `via` rows carry the walk; `nodes` carries the depth each identity was reached at. */
export function edgeRows(traversal: Traversal): readonly EdgeRow[] {
  const depths = new Map(traversal.nodes.map((node) => [node.identity, node.depth]));
  const rows = new Map<string, EdgeRow>();
  for (const via of traversal.via) {
    const row = {
      from: via.direction === 'out' ? via.from : via.target,
      predicate: via.predicate,
      to: via.direction === 'out' ? via.target : via.from,
      depth: Math.max(depths.get(via.from) ?? 0, depths.get(via.target) ?? 0),
    };
    // A `both` walk reports one relationship from each end; the pair is one edge and is reported once.
    const key = `${row.from}|${row.predicate}|${row.to}`;
    const seen = rows.get(key);
    if (seen === undefined || row.depth < seen.depth) rows.set(key, row);
  }
  return [...rows.values()];
}

/**
 * One typed field reference naming the inspected record (graph G06a): a record that names it in a typed field such as
 * `head.steward` or `composition.mandate`. It is not an edge and carries no predicate, so it is listed apart from
 * `edges` and never walked past depth 1.
 */
interface ReferenceRow {
  readonly from: string;
  readonly field: string;
  readonly to: string;
  readonly source: { readonly path: string; readonly line: number };
}
export function referenceRows(references: ReturnType<Session['reader']['referencedBy']>): readonly ReferenceRow[] {
  return references.map((reference) => ({
    from: reference.from,
    field: reference.field,
    to: reference.to,
    source: { path: portable(reference.source.path), line: reference.source.line },
  }));
}

const tally = (values: readonly string[]): readonly (readonly [string, number])[] => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const recordBlocks = (
  record: Record_,
  edges: readonly EdgeRow[],
  references: readonly ReferenceRow[] | undefined,
  caps: Capabilities,
): readonly (readonly string[])[] => {
  const sections = record.sections.map((section) => section.name);
  const rows: Field[] = [
    { label: 'System', value: words(record.system) },
    { label: 'Kind', value: words(`${record.kind} / ${record.discriminator}`) },
    { label: 'Facet', value: words(record.facet) },
    { label: 'Source', value: [atom(`${portable(record.source.path)}:${record.source.line}`, 'cyan', 0)] },
    { label: 'Schema', value: [atom(record.schema, 'cyan', 0)] },
    { label: 'Band', value: words(String(record.band)) },
    { label: 'Sections', value: words(sections.join(', ') || 'none') },
  ];
  const blocks: (readonly string[])[] = [
    // The identity alone is often wider than the effective width, so nothing shares its header line.
    headerLine('Record', record.identity, [], caps),
    [sectionLabel('Definition', caps), ...fieldRows(rows, { depth: 1 }, caps)],
  ];
  if (record.head.length > 0)
    blocks.push([
      sectionLabel('Head', caps),
      ...fieldRows(
        record.head.map((field) => ({ label: field.key, value: [atom(JSON.stringify(field.value), null, 0)] })),
        { depth: 1 },
        caps,
      ),
    ]);
  blocks.push([
    sectionLabel('Edges', caps),
    ...(edges.length === 0
      ? entry([words('None at this depth and direction.')], { depth: 1 }, caps)
      : edges.flatMap((edge) => {
          // from/to already carry the direction; the marker names it so an inverse spelling is not a duplicate.
          const outward = edge.from === record.identity;
          return entry(
            [
              [
                atom(edge.predicate, null, 0),
                atom(outward ? edge.to : edge.from, 'cyan', 2),
                ...words(`${outward ? 'out' : 'in'}, depth ${edge.depth}`, 'dim', 2),
              ],
            ],
            { depth: 1, symbol: 'info' },
            caps,
          );
        })),
  ]);
  if (references !== undefined)
    blocks.push([
      sectionLabel('Referenced by', caps),
      ...(references.length === 0
        ? entry([words('No record names this one in a typed field.')], { depth: 1 }, caps)
        : references.flatMap((reference) =>
            entry(
              [
                [
                  atom(reference.field, null, 0),
                  atom(reference.from, 'cyan', 2),
                  ...words(`${reference.source.path}:${reference.source.line}`, 'dim', 2),
                ],
              ],
              { depth: 1, symbol: 'info' },
              caps,
            ),
          )),
    ]);
  return blocks;
};

export function runInspect(context: Context): Result {
  const { args, caps, json } = context;
  const root = requireRoot(context);
  const identity = args.positionals[0];
  const path = args.value('path');
  const direction = (args.value('edges') ?? 'out') as Direction;
  const depth = args.integer('depth', 1);
  if (identity !== undefined && !IDENTITY.test(identity))
    throw new Refusal(
      'IA-CLI-USAGE',
      `Malformed identity ${identity}; a canonical identity is system/kind/facet/name in lowercase`,
      2,
      null,
      'Run "ia inspect" with no argument for a workspace overview, or "ia vocabulary <word>" for the identity shape of a word.',
    );

  let session: Session;
  try {
    session = openWorkspaceSession({ root });
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'IA-DB-ROOT-INVALID';
    throw new Refusal(
      code,
      error instanceof Error ? error.message : String(error),
      3,
      { path: root },
      'Pass --root <path> with an existing workspace.',
    );
  }
  try {
    const reader = session.reader;
    const records = reader.records();
    const selected =
      identity !== undefined
        ? records.filter((record) => record.identity === identity)
        : path !== undefined
          ? records.filter((record) => portable(record.source.path) === portable(path))
          : [];

    if ((identity !== undefined || path !== undefined) && selected.length === 0)
      throw new Refusal(
        'IA-DB-SOURCE-UNAVAILABLE',
        `${identity ?? path} is not admitted in this workspace`,
        1,
        identity === undefined ? { path: portable(path!) } : { path: root, identity },
        'Run "ia validate" to see whether the source was refused, or "ia inspect" for the admitted overview.',
      );

    if (selected.length > 0) {
      const walks = new Map<string, readonly EdgeRow[]>();
      for (const record of selected)
        walks.set(
          record.identity,
          depth === 0 ? [] : edgeRows(reader.traverse({ start: [record.identity], direction, depth })),
        );
      // Inbound typed field references are direct only: they are not edges, so no depth walks past them. They are
      // reported whenever the inbound side is asked for, and absent from `--edges out` rather than an empty claim.
      const inbound = direction !== 'out';
      const references = new Map<string, readonly ReferenceRow[]>();
      if (inbound)
        for (const record of selected)
          references.set(record.identity, depth === 0 ? [] : referenceRows(reader.referencedBy(record.identity)));
      if (json) {
        const body = {
          version: 1,
          root,
          revision: reader.revision,
          records: selected,
          edges: selected.flatMap((record) => walks.get(record.identity) ?? []),
          ...(inbound ? { referencedBy: selected.flatMap((record) => references.get(record.identity) ?? []) } : {}),
        };
        return { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: document(
          selected.flatMap((record) =>
            recordBlocks(record, walks.get(record.identity) ?? [], references.get(record.identity), caps),
          ),
          { leadingBlank: true },
        ),
        stderr: '',
      };
    }

    // Host registration spec §7, as `ia doctor` observes it: against this installation's payload pin, or, when the
    // package carries none, without the release comparison.
    const installed = readInstalledState({
      root,
      hosts: true,
      hostRelease: pinnedRelease(context.host.packageRoot).release,
    });
    const systems = tally(records.map((record) => record.system));
    const kinds = tally(records.map((record) => record.kind));
    if (json) {
      const body = {
        version: 1,
        root,
        revision: reader.revision,
        records: [],
        edges: [],
        overview: {
          records: records.length,
          systems: Object.fromEntries(systems),
          kinds: Object.fromEntries(kinds),
          installation: {
            status: installed.status,
            generation: installed.pointer?.generation ?? null,
            counter: installed.pointer?.counter ?? null,
            // `hosts: true` above always populates this; the fallback only satisfies the type, which stays optional so other callers of readInstalledState aren't charged for observation.
            hosts: (installed.hosts ?? []).map(({ host, status }) => ({ host, status })),
          },
        },
      };
      return { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' };
    }
    const pair = (label: string, value: readonly Token[]): Field => ({ label, value });
    return {
      exitCode: 0,
      stdout: document(
        [
          headerLine(
            'Workspace',
            root,
            [{ text: `revision ${truncateDigest(reader.revision, caps.ascii)}`, column: 50 }],
            caps,
          ),
          entry(
            [words(`${records.length} admitted records across ${systems.length} systems.`)],
            { depth: 1, symbol: 'info' },
            caps,
          ),
          [
            sectionLabel('Systems', caps),
            ...fieldRows(
              systems.map(([name, count]) => pair(name, words(String(count), 'dim'))),
              { depth: 1 },
              caps,
            ),
          ],
          [
            sectionLabel('Kinds', caps),
            ...fieldRows(
              kinds.map(([name, count]) => pair(name, words(String(count), 'dim'))),
              { depth: 1 },
              caps,
            ),
          ],
          [
            sectionLabel('Installation', caps),
            ...fieldRows(
              [
                pair(
                  'Generation',
                  installed.pointer === undefined
                    ? words('None installed')
                    : [
                        atom(truncateDigest(installed.pointer.generation, caps.ascii), 'cyan', 0),
                        ...words(`counter ${installed.pointer.counter}`, 'dim', 2),
                      ],
                ),
                ...hostPairs(installed.hosts ?? []).map(([label, value]) => pair(label, words(value))),
              ],
              { depth: 1 },
              caps,
            ),
          ],
          entry(
            [words('Run "ia inspect <identity>" for one record, or "ia validate" for admission findings.', 'dim')],
            { depth: 0 },
            caps,
          ),
        ],
        { leadingBlank: true },
      ),
      stderr: '',
    };
  } finally {
    session.close();
  }
}
