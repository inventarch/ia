import { createHash } from 'node:crypto';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { stableSerialize } from '@inventarch/graph';
import type { Location } from '@inventarch/language';
import { open, readInputs } from '../src/index.js';
import type { Snapshot } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { methodId, methodPath, put, workspace } from './workspace.js';

const workspacePath = '.ia/src/systems/workspace-system/records/foundation-workspace.ia';
const workspaceId = 'workspace-system/definition/workspace/foundation-workspace';
const agentId = 'agent-system/binding/agent/agent-steward';
const governance = '.ia/src/systems/governance-system';
const located = (kind: 'authored' | 'adopted', reach = ''): Location =>
  kind === 'authored'
    ? { placement: { kind, band: 100, reach }, provenance: 'workspace' }
    : { placement: { kind, band: 90, reach }, provenance: 'methodology' };
function declare(root: string, sources: readonly string[]): void {
  const text = readFileSync(resolve(root, workspacePath), 'utf8');
  put(
    root,
    workspacePath,
    text.replace(
      '  relationships\n',
      `    sources [${sources.map((s) => JSON.stringify(s)).join(', ')}]\n  relationships\n`,
    ),
  );
}
const row = (snapshot: Snapshot, identity: string) => snapshot.membership.find((r) => r.identity === identity)!;
const errors = (db: ReturnType<typeof open>) => db.report.findings.filter((f) => f.severity === 'error');

it('gives every admitted record one row, parallel to the records, at its system folder by default', () => {
  const db = open(workspace(), { cache: false });
  try {
    const snapshot = db.snapshot();
    expect(snapshot.membership.map((r) => r.identity)).toEqual(snapshot.records.map((r) => r.identity));
    expect(snapshot.membership.map((r) => [r.band, r.digest])).toEqual(snapshot.records.map((r) => [r.band, r.digest]));
    expect(Object.isFrozen(snapshot.membership) && snapshot.membership.every(Object.isFrozen)).toBe(true);
    // No @workspace declares sources: each record keeps its system seat, and the floor is rooted at its directory.
    snapshot.records.forEach((record, index) => {
      const { root } = snapshot.membership[index]!;
      expect(root).toBe(
        record.source.path.startsWith('.ia/src/floor/')
          ? '.ia/src/floor'
          : record.source.path.split('/').slice(0, 4).join('/'),
      );
    });
    expect(row(snapshot, methodId)).toMatchObject({ root: '.ia/src/systems/governance-system', band: 100 });
    expect(snapshot.membership.some((r) => r.root === '.ia/src/floor' && r.band === 10)).toBe(true);
  } finally {
    db.close();
  }
});

it('seats a record under the longest root a workspace declares at its placement', () => {
  const root = workspace();
  declare(root, [
    '.ia/src @authored',
    '.ia/src/systems/governance-system @authored',
    '.ia/src/systems/agent-system @adopted',
    'no placement',
    '/absolute @authored',
    '../outside @authored',
    '.ia/src @elsewhere',
  ]);
  const db = open(root, { cache: false });
  try {
    expect(errors(db)).toEqual([]);
    const snapshot = db.snapshot();
    expect(row(snapshot, workspaceId).root).toBe('.ia/src');
    expect(row(snapshot, methodId)).toMatchObject({ root: '.ia/src/systems/governance-system', band: 100 });
    // Declared at another placement, the agent-system folder seats nothing; the authored root does.
    expect(row(snapshot, agentId).root).toBe('.ia/src');
    // The floor is captured at band 10, so the authored declarations above do not reach it.
    const floor = snapshot.membership.filter((r) => r.band === 10);
    expect(floor.length).toBeGreaterThan(0);
    expect(floor.every((r) => r.root === '.ia/src/floor')).toBe(true);
    expect(new Set(snapshot.membership.filter((r) => r.band === 100).map((r) => r.root))).toEqual(
      new Set(['.ia/src', '.ia/src/systems/governance-system']),
    );
    const scope = db.resolveScope({ identities: [methodId, agentId] });
    expect(db.snapshot({ within: scope.token }).membership).toEqual([row(snapshot, agentId), row(snapshot, methodId)]);
    // The four entries that declare nothing are named where they are authored, and are no admission finding.
    const line =
      readFileSync(resolve(root, workspacePath), 'utf8')
        .split('\n')
        .findIndex((l) => l.includes('sources [')) + 1;
    expect(db.inertDeclarations()).toEqual(
      [
        ['no placement', 'is not spelled <root> @<placement>'],
        ['/absolute @authored', 'names a root that is absolute or escapes the tree holding the record'],
        ['../outside @authored', 'names a root that is absolute or escapes the tree holding the record'],
        ['.ia/src @elsewhere', 'names @elsewhere, which is no placement'],
      ].map(([value, reason]) => ({
        identity: workspaceId,
        field: 'composition.sources',
        value,
        path: workspacePath,
        line,
        reason,
      })),
    );
    expect(db.report.findings.filter((finding) => finding.path === workspacePath && finding.line === line)).toEqual([]);
    expect(db.inertDeclarations({ within: scope.token })).toEqual([]);
  } finally {
    db.close();
  }
});

it('gives rows to admitted winners only: no shadowed, tied, refused or out-of-reach occurrence has one', () => {
  const root = workspace(),
    procedure = readFileSync(resolve(root, methodPath), 'utf8'),
    rule = readFileSync(resolve(root, `${governance}/records/sample-rule.ia`), 'utf8'),
    convention = readFileSync(resolve(root, `${governance}/records/sample-convention.ia`), 'utf8');
  // A band-90 copy of the method, which the authored one shadows.
  const shadowed = `${governance}/records/shadowed-procedure.ia`;
  put(root, shadowed, procedure);
  // Two band-100 copies of the convention tie, so neither is admitted.
  put(root, `${governance}/records/tied-convention.ia`, convention);
  const conventionId = 'governance-system/governance/convention/sample-convention';
  // Placed for 'team' only, a new law is inactive at the workspace root.
  const team = `${governance}/records/team-rule.ia`,
    teamId = 'governance-system/governance/law/team-rule';
  put(root, team, rule.replace('@law sample-rule', '@law team-rule'));
  // Blocks nested far past the codec's 64 levels: compliance refuses the rule alone, and the workspace still opens.
  const ruleId = 'governance-system/governance/law/sample-rule',
    depth = 40,
    nest = Array.from({ length: depth }, (_, i) => `${' '.repeat(6 + 2 * i)}level${i}\n`).join('');
  put(
    root,
    `${governance}/records/sample-rule.ia`,
    rule.replace('  governance\n', `    nest\n${nest}${' '.repeat(6 + 2 * depth)}leaf "x"\n  governance\n`),
  );
  const locations = { [shadowed]: located('adopted'), [team]: located('authored', 'team') },
    db = open(root, { cache: false, locations }),
    editor = new EditorDatabase(root, { locations });
  try {
    const codes = new Set(errors(db).map((f) => f.code));
    expect(codes.has('IA-GRAPH-IDENTITY-TIE')).toBe(true);
    expect(codes.has('IA-COMP-FIELD-UNKNOWN')).toBe(true);
    expect(db.refused.some((r) => r.identity === ruleId)).toBe(true);
    const snapshot = db.snapshot(),
      occurrences = editor.current.inspect().graph.occurrences;
    expect(snapshot.membership.map((r) => r.identity)).toEqual(snapshot.records.map((r) => r.identity));
    for (const [identity, status] of [
      [methodId, 'shadowed'],
      [conventionId, 'tied'],
    ])
      expect(occurrences.some((o) => o.node.identity === identity && o.status === status)).toBe(true);
    // One row for the method, the authored winner's; the adopted copy has the same digest at another root and band.
    expect(snapshot.membership.filter((r) => r.identity === methodId)).toEqual([
      { identity: methodId, root: governance, band: 100, digest: db.get(methodId)!.digest },
    ]);
    const copy = occurrences.find((o) => o.status === 'shadowed')!.node;
    expect([copy.source.path, copy.band, copy.digest]).toEqual([shadowed, 90, db.get(methodId)!.digest]);
    for (const identity of [conventionId, ruleId, teamId])
      expect(snapshot.membership.some((r) => r.identity === identity)).toBe(false);
    expect(snapshot.membership.length).toBeLessThan(occurrences.length);
    // Below 'team' the law is admitted, and only there does it have a row.
    expect(row(db.snapshot({ root: 'team/one' }), teamId)).toMatchObject({ root: governance, band: 100 });
  } finally {
    db.close();
    editor.close();
  }
});

it('seats an occurrence alike in every scope, by the roots that the workspace-root view admits', () => {
  const root = workspace();
  declare(root, ['.ia/src @authored']);
  const scoped = '.ia/src/systems/workspace-system/records/scoped-workspace.ia',
    scopedId = 'workspace-system/definition/workspace/scoped-workspace';
  put(
    root,
    scoped,
    `#! ia 1.0\n@workspace scoped-workspace\n  meaning\n    says "A workspace placed for one system."\n    answers "Which roots does it capture?"\n  composition\n    systems [@system governance-system]\n    sources [".ia/src/systems/governance-system/records @authored"]\n`,
  );
  // Placed for the governance-system folder only, the second workspace is not admitted at the workspace root.
  const db = open(root, { cache: false, locations: { [scoped]: located('authored', governance) } });
  try {
    expect(errors(db)).toEqual([]);
    const top = db.snapshot(),
      method = row(top, methodId);
    expect(method).toMatchObject({ root: '.ia/src', band: 100 });
    expect(top.membership.some((r) => r.identity === scopedId)).toBe(false);
    const parent = db.resolveScope();
    const scopes = [
      db.resolveScope({ within: parent.token, root: governance }),
      db.resolveScope({ root: governance }),
      db.resolveScope({ within: parent.token, phase: 'act' }),
      db.resolveScope({ within: parent.token, identities: [methodId] }),
    ];
    for (const scope of scopes) expect(row(db.snapshot({ within: scope.token }), methodId)).toEqual(method);
    // Admitted below the root, the placed workspace has a row there, and declares no root of the capture.
    const below = db.snapshot({ root: governance });
    expect(row(below, scopedId).root).toBe('.ia/src');
    expect(below.membership.filter((r) => r.root === `${governance}/records`)).toEqual([]);
  } finally {
    db.close();
  }
});

it('keeps a digest and root when lines shift or the record moves, and changes the digest with its content', () => {
  const root = workspace(),
    text = readFileSync(resolve(root, methodPath), 'utf8'),
    rule = readFileSync(resolve(root, '.ia/src/systems/governance-system/records/sample-rule.ia'), 'utf8');
  declare(root, ['.ia/src @authored']);
  const db = open(root, { cache: false });
  try {
    const before = row(db.snapshot(), methodId),
      line = db.get(methodId)!.source.line,
      revision = db.revision;
    // An earlier record inserted into the same file shifts every line of the method.
    const earlier = rule.replace('#! ia 1.0\n', '').replace('@law sample-rule', '@law probe-earlier');
    put(root, methodPath, text.replace('#! ia 1.0\n', `#! ia 1.0\n${earlier}\n`));
    db.refresh();
    expect(errors(db)).toEqual([]);
    const shifted = db.get(methodId)!.source.line;
    expect(shifted).toBeGreaterThan(line);
    expect(db.revision).not.toBe(revision);
    expect(row(db.snapshot(), methodId)).toEqual(before);
    // Editing that earlier record moves the method's lines again and leaves its row alone.
    const edited = earlier.replace('statement 1.', 'statement 1, now edited.');
    put(root, methodPath, text.replace('#! ia 1.0\n', `#! ia 1.0\n${edited}\n# A note after the earlier record.\n`));
    db.refresh();
    expect(errors(db)).toEqual([]);
    expect(db.get(methodId)!.source.line).toBe(shifted + 1);
    expect(row(db.snapshot(), methodId)).toEqual(before);
    // Moved to another file of the same root, the record keeps its digest and its root.
    const moved = '.ia/src/systems/governance-system/records/moved-procedure.ia';
    rmSync(resolve(root, methodPath));
    put(root, moved, text);
    db.refresh();
    expect(db.get(methodId)!.source.path).toBe(moved);
    expect(row(db.snapshot(), methodId)).toEqual(before);
    put(root, moved, text.replace('Sample fixture statement 3.', 'An edited cell.'));
    db.refresh();
    expect(row(db.snapshot(), methodId)).toEqual({ ...before, digest: db.get(methodId)!.digest });
    expect(row(db.snapshot(), methodId).digest).not.toBe(before.digest);
  } finally {
    db.close();
  }
});

it('keeps adopted records at their system seat; an adopted workspace speaks only for its own tree', () => {
  const root = workspace(false),
    vendor = 'vendor/foundation';
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, vendor, '.ia/src'), {
    recursive: true,
  });
  declare(resolve(root, vendor), ['.ia/src @authored']);
  const pinned = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = createHash('sha256').update(stableSerialize(pinned)).digest('hex');
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  const local = '.ia/src/systems/agent-system/records/example-reader.ia',
    readerId = 'agent-system/binding/agent/example-reader';
  put(
    root,
    local,
    '#! ia 1.0\n@agent example-reader\n  meaning\n    says "Review the corpus."\n    answers "Who reads here?"\n  governance\n    applies []\n',
  );
  const mount = `.ia/adopted/foundation/${revision}/.ia/src/systems`;
  const disk = open(root, { cache: false });
  try {
    expect(errors(disk)).toEqual([]);
    const snapshot = disk.snapshot();
    expect(row(snapshot, workspaceId)).toMatchObject({ root: `${mount}/workspace-system`, band: 90 });
    expect(row(snapshot, methodId)).toMatchObject({ root: `${mount}/governance-system`, band: 90 });
    // The adopted workspace's `.ia/src @authored` names its own tree, so the local record keeps its system seat.
    expect(row(snapshot, readerId)).toMatchObject({ root: '.ia/src/systems/agent-system', band: 100 });
  } finally {
    disk.close();
  }
  put(
    root,
    '.ia/src/systems/workspace-system/records/consumer.ia',
    '#! ia 1.0\n@workspace consumer\n  meaning\n    says "The consuming repository."\n    answers "Which roots does it capture?"\n  composition\n    systems [@system agent-system]\n    sources [".ia/src @authored"]\n',
  );
  const declared = open(root, { cache: false }),
    editor = new EditorDatabase(root);
  try {
    expect(errors(declared)).toEqual([]);
    const snapshot = declared.snapshot();
    expect(row(snapshot, readerId).root).toBe('.ia/src');
    expect(row(snapshot, 'workspace-system/definition/workspace/consumer').root).toBe('.ia/src');
    expect(row(snapshot, methodId).root).toBe(`${mount}/governance-system`);
    // The cache-free editor reader builds the same rows through the shared view.
    expect(editor.current.snapshot().membership).toEqual(snapshot.membership);
  } finally {
    declared.close();
    editor.close();
  }
});

it('lists the roots the capture declares, longest first, pruned with the workspace that declares them (D02c)', () => {
  const root = workspace();
  const none = open(root, { cache: false });
  try {
    // No @workspace declares sources, so the capture declares no root.
    expect(none.roots()).toEqual([]);
  } finally {
    none.close();
  }
  declare(root, [
    '.ia/src @authored',
    '.ia/src/systems/governance-system @authored',
    '.ia/src/systems/agent-system @adopted',
    'no placement',
  ]);
  const db = open(root, { cache: false });
  try {
    const roots = db.roots();
    // The entries that declare a root, longest first; the one that declares nothing is no root.
    expect(roots).toEqual([
      { root: '.ia/src/systems/governance-system', placement: 'authored', workspace: workspaceId },
      { root: '.ia/src/systems/agent-system', placement: 'adopted', workspace: workspaceId },
      { root: '.ia/src', placement: 'authored', workspace: workspaceId },
    ]);
    expect(Object.isFrozen(roots) && roots.every(Object.isFrozen)).toBe(true);
    // Copies: a caller cannot re-root what the seat rule reads.
    expect(db.roots()).not.toBe(roots);
    expect(db.roots({ within: db.resolveScope().token })).toEqual(roots);
    // A scope that does not admit the declaring workspace prunes its roots, and its rows keep the roots they had.
    const narrowed = db.resolveScope({ identities: [methodId] });
    expect(db.roots({ within: narrowed.token })).toEqual([]);
    expect(db.snapshot({ within: narrowed.token }).membership).toEqual([row(db.snapshot(), methodId)]);
    expect(row(db.snapshot(), methodId).root).toBe('.ia/src/systems/governance-system');
    expect(db.roots({ within: db.resolveScope({ identities: [workspaceId] }).token })).toEqual(roots);
  } finally {
    db.close();
  }
});
