import { afterEach, expect, it, vi } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

vi.mock('@inventarch/workspace-runtime', async (original) => ({
  ...(await original<typeof import('@inventarch/workspace-runtime')>()),
  installedImplementationDigest: () => 'a'.repeat(64),
}));
import { contextHookImplementationDigest } from '../src/context.js';
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ia-hook-runtime-'));
  roots.push(root);
  for (const name of ['main.js', 'context.js']) writeFileSync(join(root, name), `// exact ${name}\n`);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'ia-hook-runtime-')))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
it('pins added/removed/changed emitted runtime assets but excludes nonexecuted declarations', () => {
  const root = fixture(),
    original = contextHookImplementationDigest(root);
  writeFileSync(join(root, 'context.d.ts'), 'export declare const ignored: true;');
  expect(contextHookImplementationDigest(root)).toBe(original);
  writeFileSync(join(root, 'policy.json'), '{"policy":1}');
  const withPolicy = contextHookImplementationDigest(root);
  expect(withPolicy).not.toBe(original);
  writeFileSync(join(root, 'policy.json'), '{"policy":2}');
  expect(contextHookImplementationDigest(root)).not.toBe(withPolicy);
  unlinkSync(join(root, 'policy.json'));
  expect(contextHookImplementationDigest(root)).toBe(original);
  writeFileSync(join(root, 'context.js'), '// changed runtime');
  expect(contextHookImplementationDigest(root)).not.toBe(original);
  unlinkSync(join(root, 'main.js'));
  expect(() => contextHookImplementationDigest(root)).toThrow(/partial|mixed/);
});
it('leaves out the AppleDouble files the packaged launcher skips, and still counts any other dotfile (#323)', async () => {
  const root = fixture(),
    original = contextHookImplementationDigest(root);
  for (const name of ['._context.js', '._main.js', '._package.json'])
    writeFileSync(join(root, name), 'written by the platform');
  expect(contextHookImplementationDigest(root)).toBe(original);
  writeFileSync(join(root, '.context.js'), '// not written by the platform');
  expect(contextHookImplementationDigest(root)).not.toBe(original);
  if (process.platform === 'win32') return;
  unlinkSync(join(root, '.context.js'));
  expect((await runBounded('mkfifo', [join(root, '._fifo.js')], { timeoutMs: SUBPROCESS })).status).toBe(0);
  expect(() => contextHookImplementationDigest(root)).toThrow(/nonregular/);
});
it('refuses aliased or mixed modules and permits normal package-store hardlinks', () => {
  const root = fixture();
  linkSync(join(root, 'main.js'), join(root, 'shared.js'));
  expect(contextHookImplementationDigest(root)).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(join(root, 'main.ts'), '// source');
  writeFileSync(join(root, 'context.ts'), '// source');
  expect(() => contextHookImplementationDigest(root)).toThrow(/mixed/);
  unlinkSync(join(root, 'main.ts'));
  unlinkSync(join(root, 'context.ts'));
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real', 'module.js'), '// module');
  symlinkSync(join(root, 'real'), join(root, 'alias'), 'junction');
  expect(() => contextHookImplementationDigest(root)).toThrow(/alias/i);
});
