import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkKit, checkKits, kitFolders } from '../src/method/kit-check.js';
import type { KitReport } from '../src/method/kit-check.js';
import { sourcesDigest } from '../src/method/kits.js';

/**
 * The kit checker on kit folders this file writes: a folder that holds everything the minimum spec asks for, then one
 * thing wrong at a time. Integrity findings always fail; spec findings fail only from 1.0.0.
 */
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ia-kit-check-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const put = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const RECORDED = ['checks.json', 'delivery.json', 'bindings.json', 'onwrite.json', 'handlers.json'];
interface Release {
  readonly version: string;
  readonly records?: readonly string[];
  readonly keys?: readonly string[];
  readonly works?: unknown;
}
interface Options {
  readonly name?: string;
  readonly id?: string;
  readonly version?: string;
  readonly license?: string;
  readonly dependencies?: readonly string[];
  readonly releases?: readonly Release[];
  /** Applied after the sources are written and before the latest release records their digest. */
  readonly edit?: (dir: string) => void;
  /** Applied last, after the digest is recorded. */
  readonly after?: (dir: string) => void;
}
const record = (name: string) => ({ system: 'note', word: 'capability', name });
/** A kit folder that passes; `options` changes one thing. */
function kit(options: Options = {}): string {
  const name = options.name ?? 'note';
  const dir = join(base, name);
  const id = options.id ?? `inventarch/${name}-kit`;
  const releases = options.releases ?? [{ version: '0.1.0' }];
  const version = options.version ?? releases.at(-1)!.version;
  put(join(dir, '.ia', 'release.json'), {
    formatVersion: 1,
    id,
    version,
    dependencies: ['inventarch/language', ...(options.dependencies ?? [])].map((on) => ({ id: on, range: '^3.0.0' })),
    assets: [],
    license: options.license ?? 'Apache-2.0',
    source: { repository: 'https://example.test/kits.git', commit: 'a'.repeat(40) },
  });
  put(
    join(dir, '.ia', 'src', 'workspace.ia'),
    '#! ia 1.0\n\n@workspace note-kit\n  meaning\n\n@agent note-kit\n  meaning\n\n@mandate note-kit-mandate\n  meaning\n',
  );
  put(
    join(dir, '.ia', 'src', 'systems', 'note', 'records', 'capabilities.ia'),
    '#! ia 1.0\n\n@capability write-note\n  meaning\n\n@capability read-note\n  meaning\n',
  );
  put(join(dir, 'bindings.json'), { format: 1, recommend: { 'work.note': { capability: 'write-note' } } });
  put(join(dir, 'README.md'), '# Note kit\n');
  put(join(dir, 'tests', 'contract.test.mjs'), '// a test\n');
  options.edit?.(dir);
  const rows = releases.map((release, at) => ({
    version: release.version,
    archive: String(at).repeat(64),
    sources: at === releases.length - 1 ? sourcesDigest(dir, RECORDED) : 'f'.repeat(64),
    language: 'inventarch/language ^3.0.0',
    cli: '@inventarch/cli 3.9.1',
    ...('works' in release ? (release.works === undefined ? {} : { works: release.works }) : { works: '>=3.9.0 <4' }),
    file: `releases/${release.version}.json`,
  }));
  put(join(dir, 'releases.json'), { format: 2, kit: id, latest: releases.at(-1)?.version ?? null, releases: rows });
  releases.forEach((release, at) =>
    put(join(dir, 'releases', `${release.version}.json`), {
      format: 2,
      kit: id,
      version: release.version,
      archive: String(at).repeat(64),
      records: (release.records ?? ['write-note', 'read-note']).map(record),
      offers: { keys: release.keys ?? ['work.note'] },
    }),
  );
  options.after?.(dir);
  return dir;
}
const rules = (report: KitReport): string[] => report.findings.map((finding) => `${finding.level}:${finding.rule}`);

it('a kit folder that holds everything passes, and on 0.x is ready for 1.0.0', () => {
  const report = checkKit(kit());
  expect(report.findings).toEqual([]);
  expect(report).toMatchObject({
    id: 'inventarch/note-kit',
    version: '0.1.0',
    class: 'public',
    offers: ['work.note'],
    ok: true,
    ready: true,
  });
  expect(checkKit(kit({ name: 'one', releases: [{ version: '1.0.0' }] }))).toMatchObject({ ok: true, ready: false });
});

it('a spec finding is reported on 0.x and fails from 1.0.0', () => {
  const lacking = (name: string, version: string): KitReport =>
    checkKit(kit({ name, releases: [{ version }], edit: (dir) => rmSync(join(dir, 'README.md')) }));
  const early = lacking('early', '0.4.0');
  expect(rules(early)).toEqual(['spec:readme']);
  expect(early).toMatchObject({ ok: true, ready: false });
  expect(early.findings[0]!.fails).toBe(false);
  const stable = lacking('stable', '1.0.0');
  expect(rules(stable)).toEqual(['spec:readme']);
  expect(stable.ok).toBe(false);
  expect(stable.findings[0]!.fails).toBe(true);
});

it('each thing the spec asks for is its own finding', () => {
  const one = (name: string, options: Options): string[] => rules(checkKit(kit({ name, ...options })));
  expect(one('a', { edit: (dir) => rmSync(join(dir, 'tests'), { recursive: true }) })).toEqual(['spec:tests']);
  expect(
    one('b', { edit: (dir) => put(join(dir, '.ia', 'src', 'workspace.ia'), '#! ia 1.0\n\n@workspace b-kit\n') }),
  ).toEqual(['spec:seat']);
  expect(
    one('c', { edit: (dir) => rmSync(join(dir, 'bindings.json')), releases: [{ version: '0.1.0', keys: [] }] }),
  ).toEqual(['spec:offers']);
  expect(one('d', { license: 'MIT' })).toEqual(['spec:licence']);
  expect(one('e', { releases: [{ version: '0.1.0', works: undefined }] })).toEqual(['spec:works']);
  expect(one('f', { after: (dir) => rmSync(join(dir, 'releases.json')) })).toEqual(['spec:releases']);
});

it('a works value that is not a range is an integrity finding', () => {
  for (const [name, works] of [
    ['a', 'soon'],
    ['b', '>4 <3'],
    ['c', 3],
  ] as const) {
    const report = checkKit(kit({ name, releases: [{ version: '0.1.0', works }] }));
    expect(rules(report)).toEqual(['integrity:works']);
    expect(report.ok).toBe(false);
  }
});

it('sources that changed since the latest release fail, whatever the version', () => {
  const report = checkKit(kit({ after: (dir) => put(join(dir, 'bindings.json'), { format: 1, recommend: {} }) }));
  expect(rules(report)).toContain('integrity:sources');
  expect(report.ok).toBe(false);
  // handlers.json is part of the recorded sources.
  const handlers = checkKit(kit({ name: 'handled', after: (dir) => put(join(dir, 'handlers.json'), { format: 1 }) }));
  expect(rules(handlers)).toEqual(['integrity:sources']);
  // A descriptor ahead of the latest release is work in progress, not a mismatch.
  expect(rules(checkKit(kit({ name: 'ahead', version: '0.2.0' })))).toEqual([]);
  expect(rules(checkKit(kit({ name: 'behind', version: '0.0.9' })))).toEqual(['integrity:descriptor']);
});

it('the descriptor and the release history must name one kit', () => {
  const report = checkKit(
    kit({
      after: (dir) =>
        put(join(dir, '.ia', 'release.json'), {
          id: 'inventarch/other-kit',
          version: '0.1.0',
          license: 'Apache-2.0',
          source: { commit: 'a' },
        }),
    }),
  );
  expect(report.findings.map((finding) => finding.message)).toContain(
    '.ia/release.json names inventarch/other-kit but releases.json names inventarch/note-kit',
  );
  expect(rules(checkKit(kit({ name: 'odd', id: 'Inventarch/Odd' })))).toEqual(['integrity:descriptor']);
});

it('a sidecar that names what the kit does not declare fails', () => {
  const report = checkKit(
    kit({
      edit: (dir) =>
        put(join(dir, 'bindings.json'), { format: 1, recommend: { 'work.note': { capability: 'absent' } } }),
    }),
  );
  expect(rules(report)).toEqual(['integrity:sidecars', 'spec:offers']);
});

it('the version rule: a version may not understate the change', () => {
  const step = (name: string, releases: readonly Release[]): string[] =>
    checkKit(kit({ name, releases }))
      .findings.filter((finding) => finding.rule === 'version')
      .map((finding) => finding.message);
  // From 1.0.0: a removed record or a dropped key needs a major, an addition a minor.
  expect(step('a', [{ version: '1.0.0' }, { version: '1.0.1', records: ['write-note'] }])).toEqual([
    'release 1.0.1 is a patch step from 1.0.0 but removes 1 record (note/capability/read-note): that needs a major step',
  ]);
  expect(step('b', [{ version: '1.0.0' }, { version: '1.1.0', keys: [] }])[0]).toContain('drops the key work.note');
  expect(step('c', [{ version: '1.0.0' }, { version: '2.0.0', records: ['write-note'] }])).toEqual([]);
  expect(step('d', [{ version: '1.0.0', records: ['write-note'] }, { version: '1.0.1' }])[0]).toContain(
    'adds 1 record (note/capability/read-note): that needs a minor step',
  );
  expect(step('e', [{ version: '1.0.0', records: ['write-note'] }, { version: '1.1.0' }])).toEqual([]);
  expect(step('f', [{ version: '1.0.0' }, { version: '1.0.1' }])).toEqual([]);
  // A higher IA minimum is breaking; a wider range is not.
  expect(
    step('g', [
      { version: '1.0.0', works: '>=3.9.0 <4' },
      { version: '1.1.0', works: '>=3.10.0 <4' },
    ])[0],
  ).toContain('raises the lowest IA version it works with from 3.9.0 to 3.10.0: that needs a major step');
  expect(
    step('h', [
      { version: '1.0.0', works: '>=3.9.0 <4' },
      { version: '1.0.1', works: '>=3.8.0 <5' },
    ]),
  ).toEqual([]);
  // On 0.x the same changes sit one step down.
  expect(step('i', [{ version: '0.3.0' }, { version: '0.3.1', records: ['write-note'] }])[0]).toContain(
    'that needs a minor step',
  );
  expect(step('j', [{ version: '0.3.0' }, { version: '0.4.0', records: ['write-note'] }])).toEqual([]);
  expect(step('k', [{ version: '0.3.0', records: ['write-note'] }, { version: '0.3.1' }])).toEqual([]);
  // The first 1.0.0 may break 0.x.
  expect(step('l', [{ version: '0.9.0' }, { version: '1.0.0', records: ['write-note'] }])).toEqual([]);
  // The version rule fails a kit on 0.x too.
  expect(
    checkKit(kit({ name: 'm', releases: [{ version: '0.3.0' }, { version: '0.3.1', records: ['write-note'] }] })).ok,
  ).toBe(false);
});

it('layering: a public kit depends only on the language, a private kit only on public kits', () => {
  const open = kit({ name: 'open' });
  const leaning = kit({ name: 'leaning', dependencies: ['inventarch/open-kit'] });
  expect(rules(checkKit(leaning))).toEqual(['spec:layering']);
  const closed = kit({ name: 'closed', license: 'UNLICENSED', dependencies: ['inventarch/open-kit'] });
  expect(checkKit(closed).class).toBe('private');
  expect(rules(checkKit(closed))).toEqual(['spec:layering']);
  const inner = kit({ name: 'inner', license: 'UNLICENSED', dependencies: ['inventarch/closed-kit'] });
  const together = checkKits([open, closed, inner]);
  expect(together.map(rules)).toEqual([[], [], ['spec:layering']]);
  expect(together[2]!.findings[0]!.message).toBe(
    'depends on inventarch/closed-kit, which is not a public kit checked in this run',
  );
});

it('kits checked together must not share an id', () => {
  const first = kit({ name: 'first', id: 'inventarch/shared-kit' });
  const second = kit({ name: 'second', id: 'inventarch/shared-kit' });
  const reports = checkKits([base]);
  expect(reports.map((report) => report.dir)).toEqual([first, second]);
  for (const report of reports) {
    expect(rules(report)).toEqual(['integrity:unique']);
    expect(report).toMatchObject({ ok: false, ready: false });
  }
});

it('a path names its kit folder, or the kit folders directly under it', () => {
  const one = kit({ name: 'one' });
  const two = kit({ name: 'two' });
  mkdirSync(join(base, 'notes'));
  expect(kitFolders(one)).toEqual([one]);
  expect(kitFolders(base)).toEqual([one, two]);
  expect(kitFolders(join(base, 'notes'))).toEqual([]);
  expect(kitFolders(join(base, 'absent'))).toEqual([]);
});
