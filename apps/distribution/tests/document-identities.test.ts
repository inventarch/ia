import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

/** The package's one switch, flipped here to prove the plain names are written exactly when the follow-up release flips it. */
const flip = vi.hoisted(() => ({ plain: false }));
vi.mock('../src/written-names.js', () => ({
  get WRITE_PLAIN_NAMES() {
    return flip.plain;
  },
}));
import { copyPublicLanguageFixture } from '../../../tools/native/public-fixture.js';
import { canonicalDistributionJson as json } from '@inventarch/db/distribution';
import { DECISIONS, readDecisions, recordDecision } from '../src/decisions.js';
import { ensureIaHome, HOME_MARKER } from '../src/ia-home.js';
import { applyInstallation, cacheArchive, planInstallation, recoverInstallation } from '../src/install.js';
import { KIT_COLLECTIONS_JOURNAL, readCollectionsJournal } from '../src/kit-collections.js';
import { packDistribution } from '../src/pack.js';
import { resolveReleases } from '../src/resolve.js';
import { UPDATE_CHECK, readUpdateCheck, refreshUpdates } from '../src/updates.js';
import type { Sources } from '../src/updates.js';

// Decision dec-008 (A14, A15). The update check, the decisions and the home marker live in the IA home, which a
// separately released CLI and the plugin hook also read; the installation records live in users' repositories. This
// release reads the plain `format` name with `formatVersion` and keeps writing the released shapes until the switch flips.
const made: string[] = [];
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), 'ia-document-identities-'));
  made.push(path);
  return path;
};
afterEach(() => {
  flip.plain = false;
});
afterAll(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});
const put = (root: string, path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const unused: Sources = {
  npm: () => '0.3.0',
  git: () => {
    throw new Error('git must not run');
  },
};
const wrongIdentities = (name: string, released: Record<string, unknown>): Record<string, unknown>[] => [
  {},
  { format: name },
  { format: name, formatVersion: 2 },
  { format: name, formatVersion: '1' },
  { format: `${name}-1`, formatVersion: 1 },
  { format: `ia.${name}.v1`, formatVersion: 1 },
  { format: 'other-document', formatVersion: 1 },
  { ...released, format: name, formatVersion: 1 },
];

// update-check
const check = {
  checkedAt: '2026-09-23T12:00:00Z',
  cli: { channel: 'npm', current: '0.2.0', latest: '0.3.0', behind: null, checked: true },
  packages: { checked: false },
};
const checkHome = (identity: Record<string, unknown>): string => {
  const home = join(temp(), '.ia');
  put(home, UPDATE_CHECK, JSON.stringify({ ...identity, ...check }));
  return home;
};
it('update-check: reads the released schema literal and the plain shape, and refuses any other', () => {
  for (const identity of [{ schema: 'ia.update-check.v1' }, { format: 'update-check', formatVersion: 1 }])
    expect(readUpdateCheck(checkHome(identity)), JSON.stringify(identity)).toMatchObject({ cli: check.cli });
  for (const identity of [
    { schema: 'ia.update-check.v2' },
    { schema: 'update-check' },
    ...wrongIdentities('update-check', { schema: 'ia.update-check.v1' }),
  ])
    expect(readUpdateCheck(checkHome(identity)), JSON.stringify(identity)).toBeNull();
});
it('update-check: is written in the released shape by default and in the plain shape once the switch flips', async () => {
  const write = async () => {
    const home = join(temp(), '.ia');
    await refreshUpdates(
      { home, channel: 'npm', current: '0.2.0', name: '@inventarch/cli', checkout: null, now: new Date() },
      unused,
    );
    return JSON.parse(readFileSync(join(home, UPDATE_CHECK), 'utf8')) as Record<string, unknown>;
  };
  const released = await write();
  expect(Object.keys(released)[0]).toBe('schema');
  expect(released['schema']).toBe('ia.update-check.v1');
  expect(Object.hasOwn(released, 'format')).toBe(false);
  flip.plain = true;
  const plain = await write();
  expect(Object.keys(plain).slice(0, 2)).toEqual(['format', 'formatVersion']);
  expect(plain).toMatchObject({ format: 'update-check', formatVersion: 1 });
  expect(Object.hasOwn(plain, 'schema')).toBe(false);
});

// decisions
const decisionRow = { decision: 'declined-forever', at: '2026-09-23T12:00:00.000Z', host: 'claude', path: '/x' };
const decisionsHome = (identity: Record<string, unknown>): string => {
  const home = join(temp(), '.ia');
  put(home, DECISIONS, JSON.stringify({ ...identity, repositories: { x: decisionRow } }));
  return home;
};
it('decisions: reads the released schema literal and the plain shape, and refuses any other', () => {
  for (const identity of [{ schema: 'ia.decisions.v1' }, { format: 'decisions', formatVersion: 1 }])
    expect(readDecisions(decisionsHome(identity)), JSON.stringify(identity)).toEqual({
      repositories: { x: decisionRow },
      invalid: false,
    });
  for (const identity of [
    { schema: 'ia.decisions.v2' },
    { schema: 'decisions' },
    ...wrongIdentities('decisions', { schema: 'ia.decisions.v1' }),
  ])
    expect(readDecisions(decisionsHome(identity)), JSON.stringify(identity)).toMatchObject({
      invalid: true,
      reason: 'schema',
    });
});
it('decisions: is written in the released shape by default and in the plain shape once the switch flips', () => {
  const written = (): Record<string, unknown> => {
    const home = join(temp(), '.ia'),
      repo = temp();
    mkdirSync(join(repo, '.git'));
    recordDecision(home, repo, 'forever', 'claude');
    return JSON.parse(readFileSync(join(home, DECISIONS), 'utf8')) as Record<string, unknown>;
  };
  expect(Object.keys(written())).toEqual(['schema', 'repositories']);
  expect(written()['schema']).toBe('ia.decisions.v1');
  flip.plain = true;
  expect(Object.keys(written())).toEqual(['format', 'formatVersion', 'repositories']);
  expect(written()).toMatchObject({ format: 'decisions', formatVersion: 1 });
});

// ia-home
it('ia-home: reads the marker in either shape, and writes the released one by default and the plain one once flipped', () => {
  const marker = (): unknown => {
    const home = join(temp(), '.ia');
    ensureIaHome(home);
    return JSON.parse(readFileSync(join(home, HOME_MARKER), 'utf8'));
  };
  expect(marker()).toEqual({ schema: 'ia.home.v1' });
  flip.plain = true;
  expect(marker()).toEqual({ format: 'ia-home', formatVersion: 1 });
  // A marker in either shape that parses is a home already; it is left as found.
  for (const identity of [{ schema: 'ia.home.v1' }, { format: 'ia-home', formatVersion: 1 }]) {
    const home = join(temp(), '.ia');
    put(home, HOME_MARKER, `${JSON.stringify(identity)}\n`);
    ensureIaHome(home);
    expect(JSON.parse(readFileSync(join(home, HOME_MARKER), 'utf8'))).toEqual(identity);
  }
});

// installation records
let packed: ReturnType<typeof packDistribution>,
  selected: ReturnType<typeof resolveReleases>,
  base: string,
  sequence = 0;
const repository = resolve(import.meta.dirname, '../../..');
beforeAll(() => {
  base = temp();
  const root = join(base, 'source');
  mkdirSync(root);
  copyPublicLanguageFixture(repository, root);
  put(root, 'guide.md', '# Original installed guide\n');
  packed = packDistribution(root, {
    formatVersion: 1,
    id: 'test/foundation',
    version: '0.1.0',
    distribution: 'workspace-system/definition/distribution/public-language',
    engine: '^0.1.0',
    language: ['1.0'],
    dependencies: [],
    assets: [{ path: 'guide.md', role: 'documentation' }],
    source: { repository: 'https://example.com/fixture', commit: 'a'.repeat(40), recipe: 'ustar-v1', epoch: 0 },
    license: 'UNLICENSED',
    description: 'Original fixture',
  });
}, 30000);
const resolved = () =>
  resolveReleases(
    [{ id: 'test/foundation', range: '^0.1.0' }],
    [{ release: packed, location: `sha256:${packed.archiveDigest}`, withdrawn: false }],
    '0.1.0',
  );
/** A workspace with the release's archive cached, ready to plan an installation. */
function fresh(): string {
  const root = join(base, `workspace ${sequence++}`);
  mkdirSync(root);
  cacheArchive(root, packed.bytes);
  return root;
}
const read = (root: string, path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;

it('installation records: are written in the released shape by default, which released programs read', () => {
  selected = resolved();
  expect(Object.keys(selected.lock)[0]).toBe('formatVersion');
  expect(Object.hasOwn(selected.lock, 'format')).toBe(false);
  const root = fresh();
  const plan = planInstallation(root, selected.lock, 'install');
  expect(Object.keys(plan.pointer)).toEqual(['formatVersion', 'generation', 'previous', 'counter']);
  // The saved plan is private to the build that made it, so it already names itself in the plain shape.
  expect(plan).toMatchObject({ format: 'installation-plan', formatVersion: 1 });
  let pending: Record<string, unknown> | undefined;
  expect(() =>
    applyInstallation(plan, {
      checkpoint: (name) => {
        if (name === 'pending') pending = read(root, '.ia/distributions/pending.json');
        if (name === 'active') throw new Error('injected');
      },
    }),
  ).toThrow('injected');
  // The record is canonical JSON, so its keys are sorted; the released shape has no `format`.
  expect(Object.keys(pending!)).toEqual(['afterActive', 'afterLock', 'beforeActive', 'beforeLock', 'formatVersion']);
  recoverInstallation(root);
  expect(read(root, '.ia/distributions/active.json')).toEqual({ ...plan.pointer });
  expect(Object.hasOwn(read(root, '.ia/distributions.lock.json'), 'format')).toBe(false);
}, 60000);
it('installation records: are written in the plain shape once the switch flips, and recover from either shape', () => {
  flip.plain = true;
  selected = resolved();
  expect(selected.lock).toMatchObject({ format: 'distribution-lock', formatVersion: 1 });
  const root = fresh();
  const plan = planInstallation(root, selected.lock, 'install');
  expect(plan.pointer).toMatchObject({ format: 'activation-pointer', formatVersion: 1 });
  let pending: Record<string, unknown> | undefined;
  expect(() =>
    applyInstallation(plan, {
      checkpoint: (name) => {
        if (name === 'pending') pending = read(root, '.ia/distributions/pending.json');
        if (name === 'active') throw new Error('injected');
      },
    }),
  ).toThrow('injected');
  expect(Object.keys(pending!)).toContain('format');
  expect(pending).toMatchObject({ format: 'installation-pending', formatVersion: 1 });
  // A pending record of the released shape recovers too: rewrite it as an older program wrote it.
  const { format: _format, ...released } = pending!;
  put(root, '.ia/distributions/pending.json', json(released));
  recoverInstallation(root);
  expect(read(root, '.ia/distributions/active.json')).toMatchObject({ format: 'activation-pointer' });
  expect(read(root, '.ia/distributions.lock.json')).toMatchObject({ format: 'distribution-lock' });
}, 60000);
it('installation plan: is private, so only the plain shape applies and an earlier plan is asked to be made again', () => {
  selected = resolved();
  const root = fresh(),
    plan = planInstallation(root, selected.lock, 'install');
  const { format: _format, ...earlier } = plan;
  expect(() => applyInstallation(earlier as never)).toThrow(/plan again|earlier version/);
  expect(() => applyInstallation({ ...plan, format: 'ia.installation-plan.v1' } as never)).toThrow();
  expect(() => applyInstallation({ ...plan, formatVersion: 2 } as never)).toThrow();
});

const journalBody = { beforeActive: null, afterActive: '{}', before: null, after: null };
it('collections-journal: reads the released shape and the plain shape, and refuses any other; writes by the switch', () => {
  const root = temp();
  for (const identity of [{ formatVersion: 1 }, { format: 'collections-journal', formatVersion: 1 }]) {
    put(root, KIT_COLLECTIONS_JOURNAL, JSON.stringify({ ...identity, ...journalBody }));
    expect(readCollectionsJournal(root)).toMatchObject({ state: 'present', journal: journalBody });
  }
  for (const identity of [
    { formatVersion: 2 },
    { format: 'collections-journal' },
    { format: 'collections-journal', formatVersion: 2 },
    { format: 'other-document', formatVersion: 1 },
    { format: 1, formatVersion: 1 },
    { format: 'ia.collections-journal.v1', formatVersion: 1 },
  ]) {
    put(root, KIT_COLLECTIONS_JOURNAL, JSON.stringify({ ...identity, ...journalBody }));
    expect(readCollectionsJournal(root), JSON.stringify(identity)).toMatchObject({ state: 'invalid' });
  }
});
