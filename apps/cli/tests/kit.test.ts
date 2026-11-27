/**
 * `ia kit check`: the command over kit folders this file writes. The rules themselves are covered in
 * `packages/runtime/tests/kit-check.test.ts`; here, the arguments, the exit codes and the two outputs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cleanup, run, scratch } from './workspace-fixture.js';

afterAll(() => cleanup());

const put = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
/** A kit folder with a descriptor and no release: one spec finding per thing it lacks, none of them failing on 0.x. */
function kit(parent: string, name: string, version: string): string {
  const dir = join(parent, name);
  put(join(dir, '.ia', 'release.json'), {
    id: `inventarch/${name}-kit`,
    version,
    license: 'Apache-2.0',
    source: { commit: 'a'.repeat(40) },
    assets: [],
  });
  return dir;
}

it('reports each kit under a folder and exits 0 while none fails', async () => {
  const parent = scratch('kit-check');
  kit(parent, 'note', '0.1.0');
  kit(parent, 'memo', '0.2.0');
  const result = await run(['kit', 'check', parent, '--json']);
  expect(result.exitCode).toBe(0);
  const body = JSON.parse(result.stdout) as {
    version: number;
    ok: boolean;
    kits: { id: string; ok: boolean; ready: boolean; findings: { rule: string; fails: boolean }[] }[];
    notChecked: string[];
  };
  expect(body.version).toBe(1);
  expect(body.ok).toBe(true);
  expect(body.kits.map((row) => row.id)).toEqual(['inventarch/memo-kit', 'inventarch/note-kit']);
  expect(body.kits[0]!.findings.map((finding) => finding.rule)).toEqual([
    'releases',
    'readme',
    'tests',
    'seat',
    'offers',
  ]);
  expect(body.kits.every((row) => row.ok && !row.ready && row.findings.every((finding) => !finding.fails))).toBe(true);
  expect(body.notChecked.length).toBeGreaterThan(0);
});

it('exits 1 when a kit fails, and says which', async () => {
  const parent = scratch('kit-check-fails');
  kit(parent, 'note', '1.0.0');
  const result = await run(['kit', 'check', join(parent, 'note'), '--ascii', '--no-color']);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain('inventarch/note-kit 1.0.0');
  expect(result.stdout).toContain('fails');
  expect(result.stdout).toContain('readme: no README.md');
  expect(result.stdout).toContain('1 kit checked, 1 failing. Not checked:');
});

it('reports a missing first release file and still checks the other kits', async () => {
  const parent = scratch('kit-check-first-release');
  kit(parent, 'other', '0.1.0');
  const dir = kit(parent, 'note', '0.2.0');
  put(join(dir, 'releases.json'), {
    format: 2,
    kit: 'inventarch/note-kit',
    latest: '0.1.0',
    releases: [{ version: '0.1.0', file: 'releases/0.1.0.json', sources: 'f'.repeat(64) }],
  });
  const result = await run(['kit', 'check', parent, '--json']);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    kits: [
      {
        id: 'inventarch/note-kit',
        ok: false,
        findings: expect.arrayContaining([
          { rule: 'releases', level: 'integrity', fails: true, message: 'releases/0.1.0.json is missing' },
        ]),
      },
      { id: 'inventarch/other-kit', ok: true },
    ],
  });
});

it('refuses a folder that names no kit, an unknown action and --root', async () => {
  const empty = scratch('kit-check-empty');
  const missing = await run(['kit', 'check', empty, '--json']);
  expect(missing.exitCode).toBe(3);
  expect((JSON.parse(missing.stdout) as { code: string }).code).toBe('IA-CLI-KIT-NOT-FOUND');
  expect((await run(['kit', 'pack'])).exitCode).toBe(2);
  expect((await run(['kit', 'check', '--root', empty])).exitCode).toBe(2);
});
