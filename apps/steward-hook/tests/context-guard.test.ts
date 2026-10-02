import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { evaluateHook } from '../src/main.js';

const roots: string[] = [];
const hash = 'a'.repeat(64);
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-context-guard-'));
  roots.push(root);
  mkdirSync(resolve(root, '.ia/distributions/hosts'), { recursive: true });
  mkdirSync(resolve(root, '.claude'));
  return root;
}
function write(root: string, name: string, value: unknown) {
  writeFileSync(resolve(root, '.ia/distributions/hosts', name), JSON.stringify(value));
}
function check(root: string, path = '.claude/settings.local.json') {
  return evaluateHook(root, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: resolve(root, path), content: '{"disableAllHooks":true}' },
  });
}
function state(root: string) {
  return {
    format: 'ia.lifecycle-registration-state.v1',
    revision: 1,
    id: 'context',
    cache: root,
    release: hash,
    binding: hash,
    created: true,
    groups: { SessionStart: {}, UserPromptSubmit: {} },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !path.startsWith('ia-context-guard-') || path.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

it('protects context-owned settings but leaves unowned and unrelated settings behavior unchanged', () => {
  const root = fixture();
  write(root, 'claude-other.json', { format: 'unrelated' });
  expect(check(root)).toEqual({});
  write(root, 'claude-context-context.json', state(root));
  expect(check(root).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PROJECTION-MANAGED');
  expect(check(root, '.claude/settings.json')).toEqual({});
  expect(check(root, '.claude/ordinary.json')).toEqual({});
});

it('protects settings during first-registration and removal transitions before any ownership file exists', () => {
  const root = fixture(),
    empty = { config: null, binding: null, state: null };
  write(root, 'lifecycle-pending.json', {
    format: 'ia.lifecycle-registration-pending.v1',
    id: 'context',
    before: empty,
    after: { config: '{}', binding: '{}', state: JSON.stringify(state(root)) },
  });
  expect(check(root).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PROJECTION-MANAGED');
});

it('recognizes segmented registration ownership as managed rather than corrupt metadata', () => {
  const root = fixture();
  write(root, 'claude-context-context.json', { ...state(root), format: 'ia.lifecycle-registration-state.v2' });
  expect(check(root).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PROJECTION-MANAGED');
});

it('refuses corrupt context ownership without treating arbitrary host files as registrations', () => {
  const root = fixture();
  write(root, 'claude-context-context.binding.json', { arbitrary: true });
  expect(check(root)).toEqual({});
  write(root, 'claude-context-context.json', { ...state(root), id: 'another-workspace' });
  expect(check(root).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PATH-UNSAFE');
});

it('protects settings.local.json while a guard ownership marker or guard journal exists', () => {
  const root = fixture(),
    guard = {
      format: 'ia.guard-registration-state.v1',
      id: 'workspace',
      cache: root,
      release: hash,
      created: true,
      group: { matcher: 'Write|Edit|MultiEdit', hooks: [] },
    };
  write(root, 'claude-guard-workspace.json', guard);
  expect(check(root).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PROJECTION-MANAGED');
  expect(check(root, '.claude/settings.json')).toEqual({});
  const other = fixture();
  write(other, 'guard-pending.json', {
    format: 'ia.guard-registration-pending.v1',
    id: 'workspace',
    before: { config: null, state: null },
    after: { config: '{}', state: JSON.stringify(guard) },
  });
  expect(check(other).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PROJECTION-MANAGED');
  write(root, 'claude-guard-workspace.json', { ...guard, id: 'another-workspace' });
  expect(check(root).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PATH-UNSAFE');
});
it('still recognizes guard and context ownership states that retain pre-existing settings containers', () => {
  const root = fixture(),
    guard = {
      format: 'ia.guard-registration-state.v1',
      id: 'workspace',
      cache: root,
      release: hash,
      created: false,
      group: { matcher: 'Write|Edit|MultiEdit', hooks: [] },
      existing: [['hooks']],
    };
  write(root, 'claude-guard-workspace.json', guard);
  expect(check(root).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PROJECTION-MANAGED');
  write(root, 'claude-guard-workspace.json', { ...guard, existing: 'hooks' });
  expect(check(root).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PATH-UNSAFE');
  const other = fixture();
  write(other, 'claude-context-context.json', { ...state(other), existing: [['hooks'], ['hooks', 'SessionStart']] });
  expect(check(other).hookSpecificOutput?.permissionDecisionReason).toContain('IA-HOOK-PROJECTION-MANAGED');
});
