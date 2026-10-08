import { createHash } from 'node:crypto';
import { cpSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { selects, stableSerialize } from '@inventarch/graph';
import type { Location } from '@inventarch/language';
import { open, readInputs } from '../src/index.js';
import type { SeatResolution } from '../src/index.js';
import { EditorDatabase } from '../src/editor/index.js';
import { put, workspace } from './workspace.js';

// D02b (position-and-projection row 17): a path resolves to the seat it is declared at and to the records whose
// claimant fields select it, read from the graph's G06c index.
const repository = resolve(import.meta.dirname, '../../..');
const evidence = '.ia/src/systems/work-system/records/work.ia';
const workSystem = 'floor/definition/system/work-system';
const workspacePath = '.ia/src/systems/workspace-system/records/foundation-workspace.ia';
const foundation = 'workspace-system/definition/workspace/foundation-workspace';
const mandateId = 'agent-system/policy/mandate/work-mandate',
  specId = 'work-system/contract/spec/work-records',
  sampleMandate = 'agent-system/policy/mandate/sample-mandate';
const code = (value: string) => expect.objectContaining({ code: `IA-DB-${value}` });
const errors = (db: { report: { findings: readonly { severity: string }[] } }) =>
  db.report.findings.filter((f) => f.severity === 'error');
const brief = (resolution: SeatResolution) => ({
  ...resolution,
  claimants: resolution.claimants.map((c) => [
    c.identity,
    c.band,
    ...c.matches.map((m) => `${m.field} ${m.selection}`),
  ]),
});
/** A native copy with a fixture @mandate over the work-system records and a @spec at the exit-evidence path. */
function covered(): string {
  const root = workspace();
  put(
    root,
    '.ia/src/systems/agent-system/records/work-mandate.ia',
    [
      '#! ia 1.0',
      '',
      '@mandate work-mandate',
      '  meaning',
      '    says "A fixture mandate over the work-system records."',
      '    answers "Which mandate covers the work records?"',
      '  governance',
      '    requires "Edit only the work-system records."',
      '  authority',
      '    participant @agent work-steward',
      '    moves [Observation, Synthesis]',
      '    covers [".ia/src/systems/work-system/records/", "src/**"]',
      '',
    ].join('\n'),
  );
  put(
    root,
    evidence,
    [
      '#! ia 1.0',
      '',
      '@spec work-records',
      '  meaning',
      '    says "A fixture spec for the work records."',
      '  work',
      '    title "Work records"',
      '    status draft',
      `    covers ["${evidence}"]`,
      '',
    ].join('\n'),
  );
  return root;
}
/** The text of the native @workspace at `path` under `root`, declaring `sources` before its relationships. */
function declaring(root: string, path: string, sources: readonly string[]): string {
  return readFileSync(resolve(root, path), 'utf8').replace(
    '  relationships\n',
    `    sources [${sources.map((s) => JSON.stringify(s)).join(', ')}]\n  relationships\n`,
  );
}
function declare(root: string, path: string, sources: readonly string[]): void {
  put(root, path, declaring(root, path, sources));
}
/** Another @workspace in the `.ia/src` tree at `tree` (the repository's own by default), declaring `sources`. */
function second(root: string, name: string, sources: readonly string[], tree = '.ia/src'): string {
  put(
    root,
    `${tree}/systems/workspace-system/records/${name}.ia`,
    [
      '#! ia 1.0',
      '',
      `@workspace ${name}`,
      '  meaning',
      `    says "The ${name} fixture boundary."`,
      '    answers "Which roots does it declare?"',
      '  composition',
      '    systems [@system governance-system]',
      ...(sources.length > 0 ? [`    sources [${sources.map((s) => JSON.stringify(s)).join(', ')}]`] : []),
      '',
    ].join('\n'),
  );
  return `workspace-system/definition/workspace/${name}`;
}
/** The seat of `path` and the rule that seated it, or why none did. */
const seatIn =
  (db: { resolveSeat: (path: string, options?: { within?: string }) => SeatResolution }) =>
  (path: string, within?: string) => {
    const { seat, by, unknown } = db.resolveSeat(path, within === undefined ? {} : { within });
    return [seat, by ?? unknown];
  };

it('resolves the exit-evidence path to the work-system seat and the mandate that covers it', () => {
  const db = open(covered(), { cache: false });
  try {
    expect(errors(db)).toEqual([]);
    expect(brief(db.resolveSeat(evidence))).toEqual({
      path: evidence,
      seat: workSystem,
      by: 'system',
      claimants: [
        [mandateId, 100, 'authority.covers .ia/src/systems/work-system/records/'],
        [specId, 100, `work.covers ${evidence}`],
      ],
    });
    // The sample mandate's `docs/**` selects documentation paths, not the work records.
    expect(db.resolveSeat('docs/guide.md').claimants.map((c) => c.identity)).toEqual([sampleMandate]);
    const resolution = db.resolveSeat(evidence);
    expect(Object.isFrozen(resolution) && Object.isFrozen(resolution.claimants)).toBe(true);
  } finally {
    db.close();
  }
});

it('resolves the exit-evidence path in this repository to the work-system seat', () => {
  const db = open(repository, { cache: false });
  try {
    const resolution = db.resolveSeat(evidence);
    expect(resolution).toMatchObject({ path: evidence, seat: workSystem, by: 'system' });
    // Only language-workspace declares a root here, so it is the repository's own and seats every non-IA path.
    expect(db.resolveSeat('README.md')).toMatchObject({
      seat: 'workspace-system/definition/workspace/language-workspace',
      by: 'repository',
    });
    // Every claimant states a selection that selects the path, whatever records the repository holds.
    for (const claimant of resolution.claimants)
      expect(claimant.matches.every((m) => selects(m.selection, evidence))).toBe(true);
    // The work-system spec that covers the reference pages claims them through its `work.covers`.
    expect(
      db
        .resolveSeat('docs/reference/language/README.md')
        .claimants.find((c) => c.identity.endsWith('/spec/example-reference-spec')),
    ).toEqual({
      identity: 'work-system/contract/spec/example-reference-spec',
      band: 100,
      matches: [{ field: 'work.covers', selection: 'docs/reference/**' }],
    });
  } finally {
    db.close();
  }
});

it('seats a path at its system folder, a declared root, or the repository workspace, in that order', () => {
  const root = workspace();
  declare(root, workspacePath, ['.ia/src @authored', 'src @authored']);
  const billing = second(root, 'billing-workspace', ['src/billing @authored', 'src/billing @adopted']);
  const ledger = second(root, 'ledger-workspace', ['src/billing @authored', 'src/ledger @authored']);
  const db = open(root, { cache: false });
  try {
    expect(errors(db)).toEqual([]);
    const seat = seatIn(db);
    // A system folder, the folder itself included, and the floor's folder seat their @system before any root.
    expect(seat('.ia/src/systems/governance-system/records/sample-rule.ia')).toEqual([
      'floor/definition/system/governance-system',
      'system',
    ]);
    expect(seat('.ia/src/systems/governance-system')).toEqual(['floor/definition/system/governance-system', 'system']);
    expect(seat('.ia/src/floor/kind.ia')).toEqual(['floor/definition/system/taxonomy', 'system']);
    // A folder no admitted @system declares falls to the root that contains it.
    expect(seat('.ia/src/systems/unknown-system/x.ia')).toEqual([foundation, 'root']);
    expect(seat('.ia/src/systems')).toEqual([foundation, 'root']);
    // The longest declared root wins, whatever placement it names; billing and ledger both declare `src/billing`, and
    // the lower workspace identity seats it.
    expect(seat('src/billing/invoice.ts')).toEqual([billing, 'root']);
    expect(seat('src/billing')).toEqual([billing, 'root']);
    expect(seat('src/ledger/entry.ts')).toEqual([ledger, 'root']);
    expect(seat('src/api/route.ts')).toEqual([foundation, 'root']);
    // Several workspaces in the tree declare roots, so the repository's own is not decided.
    expect(seat('lib/a.ts')).toEqual([undefined, 'undeclared']);
    expect(seat('.ia/work/x.json')).toEqual([undefined, 'undeclared']);
  } finally {
    db.close();
  }
});

it('falls back to the repository workspace only for a path in no .ia tree', () => {
  const root = workspace();
  const db = open(root, { cache: false });
  try {
    // No @workspace declares sources: the only one in the tree is the repository's own.
    expect(db.resolveSeat('lib/a.ts')).toEqual({ path: 'lib/a.ts', seat: foundation, by: 'repository', claimants: [] });
    expect(db.resolveSeat('')).toMatchObject({ path: '', seat: foundation, by: 'repository' });
    expect(db.resolveSeat('.ia/src/x.ia')).toEqual({ path: '.ia/src/x.ia', unknown: 'undeclared', claimants: [] });
    expect(db.resolveSeat('packages/a/.ia/notes.md')).toMatchObject({ unknown: 'undeclared' });
    // A package-local system folder still seats its system.
    expect(db.resolveSeat('packages/a/.ia/src/systems/governance-system/x.ia')).toMatchObject({
      seat: 'floor/definition/system/governance-system',
      by: 'system',
    });
    // Backslashes and canonical spellings are normalized at the boundary.
    expect(db.resolveSeat('lib\\.\\x\\..\\a.ts')).toMatchObject({ path: 'lib/a.ts', seat: foundation });
    expect(db.resolveSeat('docs/')).toMatchObject({
      path: 'docs',
      claimants: [expect.objectContaining({ identity: sampleMandate })],
    });
  } finally {
    db.close();
  }
  // Without a @workspace in the tree there is no repository workspace; the embedded floor still seats its folder.
  const empty = open(workspace(false), { cache: false });
  try {
    expect(empty.resolveSeat('lib/a.ts')).toEqual({ path: 'lib/a.ts', unknown: 'undeclared', claimants: [] });
    expect(empty.resolveSeat('.ia/src/floor/kind.ia')).toMatchObject({ seat: 'floor/definition/system/taxonomy' });
  } finally {
    empty.close();
  }
});

it('chooses the repository workspace in its own tree, preferring the one that declares a root', () => {
  const root = workspace(),
    billing = second(root, 'billing-workspace', ['src/billing @authored']);
  const db = open(root, { cache: false });
  try {
    expect(errors(db)).toEqual([]);
    // Two workspaces in the tree, one declaring a root: that one is the repository's own.
    expect(seatIn(db)('lib/a.ts')).toEqual([billing, 'repository']);
  } finally {
    db.close();
  }
  // An adopted @workspace is admitted at the root and declares a root, but only for its own mount.
  const adopting = workspace(false),
    vendor = 'vendor/foundation';
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(adopting, vendor, '.ia/src'), {
    recursive: true,
  });
  declare(resolve(adopting, vendor), workspacePath, ['.ia/src @authored']);
  const pinned = readInputs(resolve(adopting, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = createHash('sha256').update(stableSerialize(pinned)).digest('hex');
  put(
    adopting,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  const adopted = open(adopting, { cache: false });
  try {
    expect(errors(adopted)).toEqual([]);
    expect(adopted.get(foundation)?.source.path).toBe(`.ia/adopted/foundation/${revision}/${workspacePath}`);
    // It is not in the repository's own tree, so it is never the repository's own.
    expect(seatIn(adopted)('lib/a.ts')).toEqual([undefined, 'undeclared']);
  } finally {
    adopted.close();
  }
  const consumer = second(adopting, 'consumer', []),
    consuming = open(adopting, { cache: false });
  try {
    expect(errors(consuming)).toEqual([]);
    // The local workspace that declares nothing is the only one in the tree; the declaring adopted one never competes.
    expect(seatIn(consuming)('lib/a.ts')).toEqual([consumer, 'repository']);
  } finally {
    consuming.close();
  }
});

it('prunes a seat outside the scope, so the path takes the next seat that applies', () => {
  const root = workspace(),
    packageRoot = 'packages/billing';
  declare(root, workspacePath, ['.ia/src @authored', 'src @authored']);
  // A package-local @workspace is admitted at the root and declares its own `src`, outside the repository's own tree.
  const local = second(root, 'package-workspace', ['src @authored'], `${packageRoot}/.ia/src`);
  const db = open(root, { cache: false, authoredRoots: [packageRoot] });
  try {
    expect(errors(db)).toEqual([]);
    const seat = seatIn(db);
    expect(seat('src/a.ts')).toEqual([foundation, 'root']);
    expect(seat('lib/a.ts')).toEqual([foundation, 'repository']);
    expect(seat(`${packageRoot}/src/a.ts`)).toEqual([local, 'root']);
    // A scope holding neither workspace prunes the root and the repository seats alike.
    const narrow = db.resolveScope({ identities: [sampleMandate] }).token;
    for (const path of ['src/a.ts', 'lib/a.ts', `${packageRoot}/src/a.ts`])
      expect(seat(path, narrow)).toEqual([undefined, 'undeclared']);
    // A root whose workspace is outside the scope falls through to the repository's own workspace inside it.
    const own = db.resolveScope({ identities: [foundation] }).token;
    expect(seat(`${packageRoot}/src/a.ts`, own)).toEqual([foundation, 'repository']);
    expect(seat('src/a.ts', own)).toEqual([foundation, 'root']);
    // Without the repository's own workspace in scope, only the package root still seats.
    const pkg = db.resolveScope({ identities: [local] }).token;
    expect(seat(`${packageRoot}/src/a.ts`, pkg)).toEqual([local, 'root']);
    for (const path of ['src/a.ts', 'lib/a.ts']) expect(seat(path, pkg)).toEqual([undefined, 'undeclared']);
  } finally {
    db.close();
  }
});

it('names a path outside the workspace as unknown, claimed by nothing', () => {
  const db = open(covered(), { cache: false });
  try {
    for (const path of ['../x', '/x', '\\x', 'C:/x', 'C:\\x', 'a/../../x'])
      expect(db.resolveSeat(path)).toEqual({ path, unknown: 'outside', claimants: [] });
  } finally {
    db.close();
  }
});

it('orders claimants band descending then identity ascending across claimant fields', () => {
  const root = covered(),
    adopted: Location = { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' };
  const lawPath = '.ia/src/systems/governance-system/records/adopted-law.ia';
  put(
    root,
    lawPath,
    '#! ia 1.0\n\n@law adopted-law\n  meaning\n    says "An adopted law."\n    answers "Which law covers everything?"\n  governance\n    severity advisory\n  subject\n    covers ["**"]\n',
  );
  put(
    root,
    '.ia/src/systems/hook-authoring-system/records/source-hook.ia',
    '#! ia 1.0\n\n@hook source-hook\n  meaning\n    says "A source hook."\n    answers "Which hook guards sources?"\n  hook\n    event PreToolUse\n    tools [Edit]\n    paths ["src/billing/**"]\n    message "Billing sources are guarded."\n',
  );
  put(
    root,
    '.ia/src/systems/compliance-system/checks/billing-check.ia',
    '#! ia 1.0\n\n@check billing-check\n  meaning\n    says "A billing check."\n    answers "Which check scopes billing?"\n  check\n    runs COMP-SCHEMA\n    scope "src/billing/*.ts"\n',
  );
  const db = open(root, { cache: false, locations: { [lawPath]: adopted } });
  try {
    expect(errors(db)).toEqual([]);
    expect(brief(db.resolveSeat('src/billing/invoice.ts')).claimants).toEqual([
      [mandateId, 100, 'authority.covers src/**'],
      ['compliance-system/check/gate/billing-check', 100, 'check.scope src/billing/*.ts'],
      ['hook-authoring-system/binding/hook/source-hook', 100, 'hook.paths src/billing/**'],
      ['governance-system/governance/law/adopted-law', 90, 'subject.covers **'],
    ]);
    // Every selection here is one the dialect reads, so none is named as declaring nothing.
    expect(db.inertDeclarations().filter((declaration) => declaration.field !== 'composition.sources')).toEqual([]);
  } finally {
    db.close();
  }
});

it('names each claimant selection the dialect reads as none, where it is authored, and claims nothing with it', () => {
  const root = covered(),
    lawPath = '.ia/src/systems/governance-system/records/rooted-law.ia';
  put(
    root,
    lawPath,
    '#! ia 1.0\n\n@law rooted-law\n  meaning\n    says "A rooted law."\n    answers "Which law covers billing?"\n  governance\n    severity blocking\n  subject\n    covers ["/src/billing/", "./src/billing/**", "src/billing/"]\n',
  );
  const db = open(root, { cache: false });
  try {
    expect(errors(db)).toEqual([]);
    const law = 'governance-system/governance/law/rooted-law';
    expect(db.inertDeclarations()).toEqual(
      ['/src/billing/', './src/billing/**'].map((value) => ({
        identity: law,
        field: 'subject.covers',
        value,
        path: lawPath,
        line: 10,
        reason: 'selects nothing: a selection is a workspace-relative path with no empty, . or .. segment',
      })),
    );
    // Only the workspace-relative selection claims the path.
    expect(brief(db.resolveSeat('src/billing/invoice.ts')).claimants).toContainEqual([
      law,
      100,
      'subject.covers src/billing/',
    ]);
  } finally {
    db.close();
  }
});

it('binds options as get does and treats records outside the scope as absent', () => {
  const root = covered(),
    db = open(root, { cache: false }),
    all = db.resolveSeat(evidence),
    library = db.resolveSeat('lib/a.ts');
  try {
    expect(library).toEqual({ path: 'lib/a.ts', seat: foundation, by: 'repository', claimants: [] });
    expect(db.resolveSeat(evidence, { revision: db.revision })).toEqual(all);
    expect(db.resolveSeat(evidence, { root: 'team', phase: 'act' })).toEqual(all);
    const scope = db.resolveScope();
    expect(db.resolveSeat(evidence, { within: scope.token })).toEqual(all);
    // The seat and the claimants outside an identity allowlist are pruned, so the path falls to the next seat.
    const narrow = db.resolveScope({ identities: [mandateId] });
    expect(brief(db.resolveSeat(evidence, { within: narrow.token }))).toEqual({
      path: evidence,
      unknown: 'undeclared',
      claimants: [[mandateId, 100, 'authority.covers .ia/src/systems/work-system/records/']],
    });
    const seated = db.resolveScope({ identities: [workSystem, specId] });
    expect(brief(db.resolveSeat(evidence, { within: seated.token }))).toEqual({
      path: evidence,
      seat: workSystem,
      by: 'system',
      claimants: [[specId, 100, `work.covers ${evidence}`]],
    });
    expect(() => db.resolveSeat(evidence, { within: narrow.token, root: 'other' })).toThrow(code('SCOPE-MISMATCH'));
    expect(() => db.resolveSeat(evidence, { within: 'forged' })).toThrow(code('SCOPE-UNAVAILABLE'));
    expect(() => db.resolveSeat(evidence, { revision: 'other' })).toThrow(code('STALE'));
    put(root, '.ia/src/systems/work-system/records/later.ia', '#! ia 1.0\n');
    db.refresh();
    expect(() => db.resolveSeat(evidence, { within: narrow.token })).toThrow(code('STALE'));
  } finally {
    db.close();
  }
  expect(() => db.resolveSeat(evidence)).toThrow(code('CLOSED'));
  const editor = new EditorDatabase(root);
  try {
    // The cache-free editor reader resolves through the same view.
    expect(editor.current.resolveSeat(evidence)).toEqual(all);
    expect(editor.current.resolveSeat('lib/a.ts')).toEqual(library);
    // Unsaved overlays seat and claim: the workspace now declares `lib` and a new mandate covers it.
    const overlaid = editor.update([
      { path: workspacePath, version: 1, text: declaring(root, workspacePath, ['lib @authored']) },
      {
        path: '.ia/src/systems/agent-system/records/library-mandate.ia',
        version: 1,
        text: [
          '#! ia 1.0',
          '',
          '@mandate library-mandate',
          '  meaning',
          '    says "An unsaved mandate over the library sources."',
          '    answers "Which mandate covers the library?"',
          '  governance',
          '    requires "Edit only the library sources."',
          '  authority',
          '    participant @agent work-steward',
          '    moves [Observation]',
          '    covers ["lib/**"]',
          '',
        ].join('\n'),
      },
    ]);
    expect(errors(overlaid)).toEqual([]);
    expect(brief(overlaid.resolveSeat('lib/a.ts'))).toEqual({
      path: 'lib/a.ts',
      seat: foundation,
      by: 'root',
      claimants: [['agent-system/policy/mandate/library-mandate', 100, 'authority.covers lib/**']],
    });
  } finally {
    editor.close();
  }
});
