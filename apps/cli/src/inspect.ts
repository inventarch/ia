/**
 * `ia inspect`: docs/specs/consumer-cli-contract/README.md §2.6.
 *
 * Public inspection only. This module must not import or invoke the private product assessment package: it
 * renders admitted structure — sections, fields, edges, source location — and makes no assessment, score or
 * recommendation. Its `--json` envelope is deliberately not interchangeable with the frozen `ia get` one.
 */
import type { HostObservation } from '@inventarch/distribution/services';
import { readInstalledState } from '@inventarch/distribution/services';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import { pinnedRelease } from './host.js';
import type { Capabilities, Field, Token } from './render.js';
import { atom, document, entry, fieldRows, headerLine, quote, sectionLabel, truncateDigest, words } from './render.js';
import { identityNext, openSession } from './session.js';
import type { Session } from './session.js';

type Record_ = ReturnType<Session['reader']['records']>[number];
type Traversal = ReturnType<Session['reader']['traverse']>;
type ViewRow = ReturnType<Session['reader']['directedView']>[number];
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

/**
 * One directed-view row as inspect lists it (graph G06b): a row the view of `identity` holds, reached `depth` hops from
 * the inspected record, with its declaration's portable source line. Distributes over the row kinds, so a field
 * reference keeps `field` and an edge row its predicate, spelling and declaring side.
 */
type Listed<Row> = Row extends unknown
  ? Omit<Row, 'source'> & {
      readonly identity: string;
      readonly depth: number;
      readonly source: { readonly path: string; readonly line: number };
    }
  : never;
type ListedRow = Listed<ViewRow>;
type ListedEdge = Exclude<ListedRow, { readonly kind: 'field-ref' }>;
type ListedField = Extract<ListedRow, { readonly kind: 'field-ref' }>;
/**
 * Depth 1 lists the inspected record's own directed view in the asked direction, so it also holds a self-relation,
 * which the walk never revisits and `edgeRows` therefore omits. Each deeper hop of the walk lists the rows the nearer
 * record's view holds for that hop, so at every depth a declared row stays apart from the derived inverse of its
 * counterpart's declaration. The walk records each hop once, and only toward a record first reached at its level, so no
 * assertion is read from both of its ends and none is listed twice.
 * Typed field references are direct only: no depth walks past them.
 */
export function directedRows(
  view: (identity: string) => readonly ViewRow[],
  identity: string,
  direction: Direction,
  traversal: Traversal,
): readonly ListedRow[] {
  const listed = (row: ViewRow, near: string, depth: number): ListedRow => ({
    identity: near,
    depth,
    ...row,
    source: { path: portable(row.source.path), line: row.source.line },
  });
  const rows = view(identity)
    .filter((row) => direction === 'both' || row.direction === direction)
    .map((row) => listed(row, identity, 1));
  const depths = new Map(traversal.nodes.map((node) => [node.identity, node.depth]));
  for (const hop of traversal.via)
    if (hop.from !== identity)
      for (const row of view(hop.from))
        if (
          row.kind !== 'field-ref' &&
          row.direction === hop.direction &&
          row.predicate === hop.predicate &&
          row.counterpart === hop.target
        )
          rows.push(listed(row, hop.from, depths.get(hop.target) ?? 1));
  return rows.sort((a, b) => a.depth - b.depth);
}

const tally = (values: readonly string[]): readonly (readonly [string, number])[] => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

/** The empty line of a section with no row within the asked depth and direction; at depth 0, where nothing is read, the only one. */
const NONE_AT_DEPTH = 'None at this depth and direction.';
/** The empty Field references line, once the view was read, names what was asked: the typed refs this record holds, those naming it, or both. */
const NO_FIELD_REFERENCE: Readonly<Record<Direction, string>> = {
  out: 'This record names no record in a typed field.',
  in: 'No record names this one in a typed field.',
  both: 'No typed field names this record or is held by it.',
};

const recordBlocks = (
  record: Record_,
  directed: readonly ListedRow[],
  direction: Direction,
  depth: number,
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
  // Declared and derived rows of the walk: the predicate as the row reads it, the counterpart, where it was reached and
  // which end declared it. A deeper row names the nearer record whose view holds it. The fragment is printed on the
  // record it addresses, beside the counterpart a declared row references or as `at #fragment` on the record whose
  // view holds a derived one, and a condition as its `when` terms, so assertions differing only there stay apart.
  const edgeSection = (label: string, kind: ListedEdge['kind']): readonly string[] => {
    const listed = directed.filter((row): row is ListedEdge => row.kind === kind);
    return [
      sectionLabel(label, caps),
      ...(listed.length === 0
        ? entry([words(NONE_AT_DEPTH)], { depth: 1 }, caps)
        : listed.flatMap((row) =>
            entry(
              [
                [
                  atom(row.spelling, null, 0),
                  atom(
                    row.kind === 'edge' && row.fragment !== undefined
                      ? `${row.counterpart}#${row.fragment}`
                      : row.counterpart,
                    'cyan',
                    2,
                  ),
                  ...words(
                    [
                      row.direction,
                      `depth ${row.depth}${row.identity === record.identity ? '' : ` via ${row.identity}`}`,
                      ...(row.derived ? ['derived'] : []),
                      `declared by ${row.declaredBy}`,
                      ...(row.kind === 'inverse' && row.fragment !== undefined ? [`at #${row.fragment}`] : []),
                      ...(row.condition === undefined
                        ? []
                        : [`when ${row.condition.map((term) => `${term.axis} is ${term.value}`).join(' and ')}`]),
                    ].join(', '),
                    'dim',
                    2,
                  ),
                ],
              ],
              { depth: 1, symbol: 'info' },
              caps,
            ),
          )),
    ];
  };
  const fields = directed.filter((row): row is ListedField => row.kind === 'field-ref');
  blocks.push(edgeSection('Edges', 'edge'), edgeSection('Derived inverses', 'inverse'), [
    sectionLabel('Field references', caps),
    ...(fields.length === 0
      ? entry([words(depth === 0 ? NONE_AT_DEPTH : NO_FIELD_REFERENCE[direction])], { depth: 1 }, caps)
      : fields.flatMap((row) =>
          entry(
            // The field and its counterpart on one line, its direction, label and location on the next, so a long
            // identity never splits them.
            [
              [atom(row.field, null, 0), atom(row.counterpart, 'cyan', 2)],
              words(`${row.direction}, derived, ${row.source.path}:${row.source.line}`, 'dim'),
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
  const supplied = args.value('root'),
    rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`;
  if (identity !== undefined && !IDENTITY.test(identity))
    throw new Refusal(
      'IA-CLI-USAGE',
      `Malformed identity ${identity}; a canonical identity is system/kind/facet/name in lowercase`,
      2,
      null,
      `Run "ia inspect${rooted}" with no argument for the overview of what the workspace admits.`,
    );

  const session: Session = openSession(root);
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
        identity !== undefined
          ? identityNext(reader, identity, 'inspect', rooted)
          : reader.refused.some((record) => portable(record.path) === portable(path!))
            ? `Run "ia validate${rooted}" to see why admission refused the records of that source.`
            : `Run "ia inspect${rooted}" for the overview of what the workspace admits.`,
      );

    if (selected.length > 0) {
      const walks = new Map<string, Traversal>();
      const directed = new Map<string, readonly ListedRow[]>();
      const views = new Map<string, readonly ViewRow[]>();
      const view = (near: string): readonly ViewRow[] => {
        let rows = views.get(near);
        if (rows === undefined) views.set(near, (rows = reader.directedView(near)));
        return rows;
      };
      // At depth 0 nothing is walked or read: the record alone, with no relationship listed.
      if (depth > 0)
        for (const record of selected) {
          const traversal = reader.traverse({ start: [record.identity], direction, depth });
          walks.set(record.identity, traversal);
          directed.set(record.identity, directedRows(view, record.identity, direction, traversal));
        }
      if (json) {
        // `referencedBy` keeps the inbound typed field references it always listed, direct only and absent from
        // `--edges out` rather than an empty claim; `directed` carries the same rows labeled, with the rest of the view.
        const inbound = direction !== 'out';
        const references = new Map<string, readonly ReferenceRow[]>();
        if (inbound)
          for (const record of selected)
            references.set(record.identity, depth === 0 ? [] : referenceRows(reader.referencedBy(record.identity)));
        const body = {
          version: 1,
          root,
          revision: reader.revision,
          records: selected,
          edges: selected.flatMap((record) => {
            const walk = walks.get(record.identity);
            return walk === undefined ? [] : edgeRows(walk);
          }),
          ...(inbound ? { referencedBy: selected.flatMap((record) => references.get(record.identity) ?? []) } : {}),
          directed: selected.flatMap((record) => directed.get(record.identity) ?? []),
        };
        return { exitCode: 0, stdout: JSON.stringify(body) + '\n', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: document(
          selected.flatMap((record) =>
            recordBlocks(record, directed.get(record.identity) ?? [], direction, depth, caps),
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
