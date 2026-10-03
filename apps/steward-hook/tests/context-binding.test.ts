import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lifecycleProfile } from '@inventarch/agent-composition-system/lifecycle-profile';
import { createContextHookBinding, readContextHookBinding } from '../src/context.js';

const gate = vi.hoisted(() => ({ path: '', afterStat: null as (() => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (path: string) => {
      const stat = actual.lstatSync(path);
      if (resolve(path) === gate.path && gate.afterStat) {
        const run = gate.afterStat;
        gate.afterStat = null;
        run();
      }
      return stat;
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  gate.path = '';
  gate.afterStat = null;
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'ia-context-binding-')))
      throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ia-context-binding-'));
  roots.push(root);
  const path = join(root, '.ia/distributions/hosts/claude-context-fixture.binding.json');
  mkdirSync(dirname(path), { recursive: true });
  const input = {
    format: 'ia.context-hook-binding.v1' as const,
    root,
    owner: 'owner-one',
    actor: 'actor',
    workspace: 'workspace',
    profile: lifecycleProfile('claude-code', '2.1.278'),
    scope: { root: '', identities: null },
    view: { id: 'project', adopted: [], manifests: [{ source: 'self', root }] },
    selection: { target: 'governance-system/definition/procedure/sample-procedure', document: null, lifecycle: null },
    coordinate: { phase: 'orient', primitive: 'Decision' },
    bootstrap: 'Author native procedures',
    budgets: { tokens: 20_000, records: 32, bytes: 80_000, timeoutMs: 3000 },
    policy: 'a'.repeat(64),
    implementation: 'b'.repeat(64),
  };
  const binding = createContextHookBinding(input);
  writeFileSync(path, JSON.stringify(binding));
  return { root, path, input, binding };
}
it('refuses an independently valid binding replaced between metadata validation and read', () => {
  const { root, path, input, binding } = fixture(),
    replacement = createContextHookBinding({ ...input, owner: 'owner-two' });
  expect(JSON.stringify(replacement).length).toBe(JSON.stringify(binding).length);
  gate.path = resolve(path);
  gate.afterStat = () => {
    renameSync(path, path + '.retained');
    writeFileSync(path, JSON.stringify(replacement));
  };
  expect(() => readContextHookBinding(root, path)).toThrow(/changed|identity|replaced/i);
  expect(readContextHookBinding(root, path).owner).toBe('owner-two');
});
it('reads a retained bounded binding and refuses an oversized replacement', () => {
  const { root, path, binding } = fixture();
  expect(readContextHookBinding(root, path)).toEqual(binding);
  writeFileSync(path, ' '.repeat(64 * 1024 + 1));
  expect(() => readContextHookBinding(root, path)).toThrow(/bounded|changed/i);
});
