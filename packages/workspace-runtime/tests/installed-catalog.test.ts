import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionError } from '@inventarch/session-system';
import { afterEach, expect, it } from 'vitest';
import { installedImplementationDigest } from '../src/installed-catalog.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(resolve(tmpdir(), 'ia-installed-bound-')))
      throw new Error('Unexpected temporary cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
/** A caller-supplied installed package directory with one entrypoint file. */
function installed(): { readonly root: string; readonly entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'ia-installed-bound-'));
  roots.push(root);
  writeFileSync(join(root, 'index.js'), 'export {};');
  return { root, entry: join(root, 'index.js') };
}
/** A file of the given size without writing its bytes. */
function sized(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  try {
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
function refusal(entry: string): unknown {
  try {
    installedImplementationDigest([['probe', entry]]);
  } catch (error) {
    return error;
  }
  throw new Error('Expected the installed walk to refuse');
}

it('pins a bounded additional directory deterministically', () => {
  const { entry } = installed(),
    pinned = installedImplementationDigest([['probe', entry]]);
  expect(pinned).toMatch(/^[a-f0-9]{64}$/);
  expect(installedImplementationDigest([['probe', entry]])).toBe(pinned);
  expect(pinned).not.toBe(installedImplementationDigest());
});

it('refuses an installed directory deeper than the walk bound', () => {
  const { root, entry } = installed();
  mkdirSync(join(root, ...Array.from({ length: 17 }, (_, index) => `d${index}`)), { recursive: true });
  const error = refusal(entry);
  expect(error).toBeInstanceOf(SessionError);
  expect(error).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation inventory exceeds its bound',
  });
}, 30_000);

it('refuses an installed directory with more entries than the walk bound', () => {
  const { root, entry } = installed();
  for (let index = 0; index < 2000; index++) writeFileSync(join(root, `n${index}.txt`), '');
  expect(refusal(entry)).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation inventory exceeds its bound',
  });
}, 30_000);

it('refuses installed code over the file and package byte bounds before hashing it', () => {
  const large = installed();
  sized(join(large.root, 'large.js'), 8 * 1024 * 1024 + 1);
  expect(refusal(large.entry)).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation bytes exceed their bound',
  });
  const many = installed();
  for (let index = 0; index < 5; index++) sized(join(many.root, `part${index}.js`), 7 * 1024 * 1024);
  expect(refusal(many.entry)).toMatchObject({
    code: 'IA-CORPUS-DENIED',
    message: 'Installed implementation bytes exceed their bound',
  });
}, 30_000);
