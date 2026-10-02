/**
 * Operator decision 2026-09-23 ("narrow + disclose"): a workspace with a projection ownership state is a consumer
 * workspace, where the guard protects only what `ia host` owns plus the native installation state. Steward
 * enforcement on `.ia/src/systems/<name>/**` is the same in both modes. tests/hook.test.ts keeps the legacy list.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { evaluateHook } from '../src/main.js';

// Steward cases open the disk-backed native fixture.
vi.setConfig({ testTimeout: 30_000 });

const fixture = resolve(import.meta.dirname, '../../../packages/compliance/fixtures/loop');
const roots: string[] = [];
const hash = 'a'.repeat(64),
  other = 'b'.repeat(64);
function workspace(copy = false): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-consumer-guard-'));
  roots.push(root);
  if (copy) cpSync(fixture, root, { recursive: true });
  mkdirSync(resolve(root, '.ia/distributions/hosts'), { recursive: true });
  return root;
}
function write(root: string, name: string, value: unknown): void {
  writeFileSync(
    resolve(root, '.ia/distributions/hosts', name),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
function projection(host: 'claude' | 'codex', files: Record<string, unknown>) {
  return { format: 'ia.host-projection-state.v1', host, files };
}
function check(root: string, path: string, extra: Record<string, unknown> = {}) {
  return evaluateHook(root, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: resolve(root, path), content: 'x' },
    ...extra,
  });
}
function code(root: string, path: string, extra: Record<string, unknown> = {}): string | undefined {
  return check(root, path, extra).hookSpecificOutput?.permissionDecisionReason.split(':')[0];
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !path.startsWith('ia-consumer-guard-') || path.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

it("leaves the user's own instruction, skill and agent files editable and protects only the owned projection files", () => {
  const root = workspace();
  write(
    root,
    'claude-projection.json',
    projection('claude', { '.claude/agents/demo-steward.md': hash, '.claude/rules/ia-workspace.md': hash }),
  );
  for (const path of [
    'CLAUDE.md',
    'AGENTS.md',
    '.claude/skills/my-own/SKILL.md',
    '.claude/skills/ia-authoring/SKILL.md',
    '.agents/skills/ia-authoring/SKILL.md',
    '.claude/agents/my-reviewer.md',
    '.codex/agents/owner.toml',
    '.codex/config.toml',
    'docs/ordinary.md',
  ])
    expect(check(root, path), path).toEqual({});
  for (const path of [
    '.claude/rules/ia-workspace.md',
    '.claude/agents/demo-steward.md',
    '.ia/distributions.lock.json',
    '.ia/distributions/active.json',
    '.ia/distributions/hosts/claude-projection.json',
  ])
    expect(code(root, path, { agent_type: 'demo-steward' }), path).toBe('IA-HOOK-PROJECTION-MANAGED');
  if (process.platform === 'win32') {
    expect(code(root, '.CLAUDE/Rules/IA-Workspace.MD')).toBe('IA-HOOK-PROJECTION-MANAGED');
    expect(check(root, 'Claude.MD')).toEqual({});
  }
});

it('keeps settings.local.json protected while a guard marker exists and .codex/config.toml while the Codex registration exists', () => {
  const root = workspace();
  write(root, 'claude-projection.json', projection('claude', { '.claude/rules/ia-workspace.md': hash }));
  expect(check(root, '.claude/settings.local.json')).toEqual({});
  write(root, 'claude-guard-workspace.json', {
    format: 'ia.guard-registration-state.v1',
    id: 'workspace',
    cache: root,
    release: hash,
    created: true,
    group: { matcher: 'Write|Edit|MultiEdit', hooks: [] },
  });
  expect(code(root, '.claude/settings.local.json')).toBe('IA-HOOK-PROJECTION-MANAGED');
  write(root, 'codex-workspace.json', '{}\n');
  expect(code(root, '.codex/config.toml')).toBe('IA-HOOK-PROJECTION-MANAGED');
});

it("reads either host's projection state, including an interrupted apply's two accepted hashes", () => {
  const root = workspace();
  write(root, 'codex-projection.json', projection('codex', { 'AGENTS.md': [hash, other] }));
  expect(code(root, 'AGENTS.md')).toBe('IA-HOOK-PROJECTION-MANAGED');
  expect(check(root, 'CLAUDE.md')).toEqual({});
  expect(check(root, '.agents/skills/ia-authoring/SKILL.md')).toEqual({});
  expect(check(root, '.claude/rules/ia-workspace.md')).toEqual({});
});

it("still refuses records under .ia/src/systems/<name>/ from anyone but that system's steward", () => {
  const root = workspace(true);
  write(root, 'claude-projection.json', projection('claude', { '.claude/rules/ia-workspace.md': hash }));
  const record = '.ia/src/systems/governance-system/records/x.ia';
  expect(code(root, record)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  expect(code(root, record, { agent_type: 'agent-steward' })).toBe('IA-HOOK-NOT-STEWARD');
  expect(check(root, record, { agent_type: 'governance-steward' })).toEqual({});
});

it.each([
  ['unparseable bytes', 'garbage'],
  ['another format', { ...projection('claude', {}), format: 'ia.host-projection-state.v2' }],
  ['a host mismatch', projection('codex', {})],
  ['an extra member', { ...projection('claude', {}), extra: true }],
  ['a path outside the allowlist', projection('claude', { '.ia/src/systems/demo/x.ia': hash })],
  ['a malformed hash', projection('claude', { '.claude/rules/ia-workspace.md': 'nothex' })],
  ['three accepted hashes', projection('claude', { '.claude/rules/ia-workspace.md': [hash, other, 'c'.repeat(64)] })],
])('fails closed on a projection state with %s', (_label, value) => {
  const root = workspace();
  write(root, 'claude-projection.json', value);
  for (const path of ['CLAUDE.md', '.claude/rules/ia-workspace.md', '.claude/skills/my-own/SKILL.md'])
    expect(code(root, path), path).toBe('IA-HOOK-PATH-UNSAFE');
  // A path no projection rule could reach does not depend on the state.
  expect(check(root, 'docs/ordinary.md')).toEqual({});
});

it('fails closed when the projection state is not a plain file', () => {
  const root = workspace();
  mkdirSync(resolve(root, '.ia/distributions/hosts/claude-projection.json'));
  expect(code(root, 'CLAUDE.md')).toBe('IA-HOOK-PATH-UNSAFE');
});
