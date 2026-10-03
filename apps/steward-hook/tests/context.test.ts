import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { open } from '@inventarch/db';
import { LifecycleError, lifecycleProfile } from '@inventarch/agent-composition-system/lifecycle-profile';
import {
  createContextHookBinding,
  DEFAULT_CONTEXT_HOOK_BUDGETS,
  evaluateContextHook,
  evaluateContextHookPart,
  localContextHookHost,
  readContextHookBinding,
} from '../src/context.js';
import type { ContextHookBinding, ContextHookHost } from '../src/context.js';

const temporary = mkdtempSync(join(tmpdir(), 'ia-context-hook-')),
  root = join(temporary, 'project');
const hash = (character: string) => character.repeat(64),
  implementation = hash('a'),
  policy = hash('b');
const profile = lifecycleProfile('claude-code', '2.1.278');
const method = 'governance-system/definition/procedure/example-method';
let binding: ContextHookBinding;
const event = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'host-session',
    prompt_id: 'prompt-1',
    cwd: root,
    prompt: 'Author a native procedure',
    transcript_path: join(temporary, 'never-read-secret'),
    ...extra,
  });
function host(overrides: Partial<ContextHookHost> = {}): ContextHookHost {
  return {
    implementation: () => implementation,
    openCurrentView: async (binding) => {
      const reader = open(binding.root, { cache: false }),
        scope = reader.resolveScope({ identities: [method] });
      const pins = {
        binding: binding.digest,
        source: hash('c'),
        view: scope.revision,
        resources: hash('d'),
        installation: null,
        profile: profile.digest,
        policy,
        implementation,
      };
      return {
        reader,
        within: scope.token,
        pins,
        requiredParts: (input) => ({
          pins: input.pins,
          parts: [{ id: 'guide', text: 'Explicit approved local guide', citations: ['guide:exact'] }],
          missing: [],
          proof: hash('e'),
        }),
        close: () => reader.close(),
      };
    },
    assertCurrent: async () => {},
    ...overrides,
  };
}
beforeAll(() => {
  const repository = resolve(import.meta.dirname, '../../..');
  cpSync(join(repository, '.ia/src'), join(root, '.ia/src'), {
    recursive: true,
    filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
  });
  const manifest = JSON.parse(readFileSync(join(repository, '.ia/authoring.resources.json'), 'utf8')) as {
    files: { path: string; bytes: number; sha256: string }[];
  };
  for (const file of manifest.files) {
    const destination = resolve(root, file.path);
    if (!destination.startsWith(resolve(root) + sep)) throw new Error('Unsafe fixture resource');
    const bytes = readFileSync(resolve(repository, file.path));
    mkdirSync(resolve(destination, '..'), { recursive: true });
    writeFileSync(destination, bytes);
    // This fixture authors its own explicit manifest after copying current files; it never edits the repository manifest.
    file.bytes = bytes.length;
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  writeFileSync(join(root, '.ia/authoring.resources.json'), JSON.stringify(manifest));
  binding = createContextHookBinding({
    format: 'ia.context-hook-binding.v1',
    root,
    owner: 'local-owner',
    actor: 'local-actor',
    workspace: 'local-workspace',
    profile,
    view: { id: 'project', adopted: [], manifests: [{ source: 'self', root }] },
    scope: { root: '', identities: [method] },
    selection: { target: method, document: null, lifecycle: null },
    coordinate: { phase: 'act', primitive: 'Attention', category: 'process' },
    bootstrap: 'Author native procedures',
    budgets: { tokens: 20_000, records: 32, bytes: 80_000, timeoutMs: 3000 },
    policy,
    implementation,
  });
}, 30_000);
afterAll(() => {
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep) || !temporary.includes('ia-context-hook-'))
    throw new Error('Unsafe cleanup');
  rmSync(temporary, { recursive: true, force: true });
});

describe('fixed-root context hook consumer', () => {
  it('pins the finite external fanout default while keeping explicit retained budgets unchanged', () => {
    expect(DEFAULT_CONTEXT_HOOK_BUDGETS).toEqual({ tokens: 20_000, records: 32, bytes: 80_000, timeoutMs: 30_000 });
    expect(Object.isFrozen(DEFAULT_CONTEXT_HOOK_BUDGETS)).toBe(true);
    const { digest: _digest, ...input } = binding;
    const selected = createContextHookBinding({ ...input, budgets: DEFAULT_CONTEXT_HOOK_BUDGETS });
    const historical = createContextHookBinding({
      ...input,
      budgets: { ...DEFAULT_CONTEXT_HOOK_BUDGETS, timeoutMs: 10_000 },
    });
    expect(selected.digest).not.toBe(historical.digest);
    expect(historical.budgets.timeoutMs).toBe(10_000);
    for (const timeoutMs of [0, NaN, 1.5, 60_001])
      expect(() =>
        createContextHookBinding({ ...input, budgets: { ...DEFAULT_CONTEXT_HOOK_BUDGETS, timeoutMs } }),
      ).toThrow(/bound/i);
  });
  it('still refuses an unresponsive host at the explicit finite preparation deadline', async () => {
    const { digest: _digest, ...input } = binding;
    const selected = createContextHookBinding({ ...input, budgets: { ...DEFAULT_CONTEXT_HOOK_BUDGETS, timeoutMs: 5 } });
    const result = await evaluateContextHookPart(
      selected,
      event(),
      0,
      host({ openCurrentView: () => new Promise(() => {}) }),
    );
    expect(result).toMatchObject({ status: 'unavailable', delivery: 'not-generated', code: 'IA-LIFECYCLE-DEADLINE' });
    expect(result.output).not.toHaveProperty('hookSpecificOutput');
  });
  it.each([
    'Author a native procedure',
    'IA_M6_12345678-1234-1234-1234-123456789abc Please author a native procedure.',
  ])(
    'runs the real explicit manifest and required-authoring bridge against an isolated current view: %s',
    async (prompt) => {
      const { digest: _digest, ...input } = binding;
      const selected = createContextHookBinding({
        ...input,
        scope: { root: '', identities: null },
        budgets: DEFAULT_CONTEXT_HOOK_BUDGETS,
      });
      const local = localContextHookHost();
      let diagnostic = '';
      const result = await evaluateContextHookPart(selected, event({ prompt }), 0, {
        ...local,
        implementation: () => implementation,
        openCurrentView: async (...args) => {
          try {
            return await local.openCurrentView(...args);
          } catch (error) {
            diagnostic = String(error);
            throw error;
          }
        },
        assertCurrent: async (...args) => {
          try {
            await local.assertCurrent(...args);
          } catch (error) {
            diagnostic = String(error);
            throw error;
          }
        },
      });
      expect(result.status, diagnostic || JSON.stringify(result)).toBe('generated');
      if (result.status !== 'generated') throw new Error('Required context was not generated');
      expect(result.prepared.payload).toContain('Read the supplied label');
      const payload = JSON.parse(result.prepared.payload) as {
        required: { parts: { text: string; citations: string[] }[] };
      };
      expect(
        payload.required.parts.some((part) =>
          part.citations.some((citation) => citation.includes('reference/playbook.md')),
        ),
      ).toBe(true);
      console.info(
        'Isolated full authoring hook usage',
        JSON.stringify({
          ...result.prepared.usage,
          requiredParts: payload.required.parts.length,
          requiredBytes: Buffer.byteLength(JSON.stringify(payload.required)),
        }),
      );
      expect(result.prepared.usage.tokens).toBeLessThanOrEqual(selected.budgets.tokens);
      expect(result.prepared.usage.bytes).toBeLessThanOrEqual(selected.budgets.bytes);
    },
    60_000,
  );
  it('returns independently fresh bounded slot markers and refuses invalid slots before opening', async () => {
    const openCurrentView = vi.fn(host().openCurrentView),
      selected = host({ openCurrentView });
    const first = await evaluateContextHookPart(binding, event(), 0, selected),
      last = await evaluateContextHookPart(binding, event(), 11, selected);
    expect(first.status).toBe('generated');
    expect(last.status).toBe('generated');
    expect(openCurrentView).toHaveBeenCalledTimes(2);
    if (!('hookSpecificOutput' in first.output) || !('hookSpecificOutput' in last.output))
      throw new Error('Missing generated frames');
    const one = JSON.parse(first.output.hookSpecificOutput.additionalContext),
      twelve = JSON.parse(last.output.hookSpecificOutput.additionalContext);
    expect(one.packetId).toBe(twelve.packetId);
    expect(twelve.slot).toBe(11);
    expect(twelve.chunk).toBe(null);
    expect(first.output.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);
    for (const part of [-1, 12, 1.5, NaN])
      expect((await evaluateContextHookPart(binding, event(), part, selected)).status).toBe('unavailable');
    expect(openCurrentView).toHaveBeenCalledTimes(2);
  });
  it('delivers current scoped context without reading transcript metadata or writing source/cache', async () => {
    const path = join(root, '.ia/src/systems/agent-composition-system/records/composition.ia'),
      before = readFileSync(path, 'utf8');
    const result = await evaluateContextHook(binding, event(), host());
    expect(result.status).toBe('generated');
    expect(JSON.stringify(result.output)).toContain('Explicit approved local guide');
    expect(JSON.stringify(result.output)).toContain('Read the supplied label');
    expect(result.delivery).toBe('unconfirmed');
    expect(readFileSync(path, 'utf8')).toBe(before);
    const fresh = await evaluateContextHook(
      binding,
      event({ hook_event_name: 'SessionStart', source: 'compact', prompt: undefined }),
      host(),
    );
    expect(fresh.output).toMatchObject({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: expect.any(String) },
    });
  });
  it('rejects foreign cwd, alias roots, forged binding fields and changed implementation before opening', async () => {
    const openCurrentView = vi.fn(host().openCurrentView);
    const foreign = await evaluateContextHook(binding, event({ cwd: temporary }), host({ openCurrentView }));
    expect(foreign.status).toBe('unavailable');
    expect(openCurrentView).not.toHaveBeenCalled();
    expect((await evaluateContextHook(binding, event({ root: temporary }), host({ openCurrentView }))).status).toBe(
      'unavailable',
    );
    expect(
      (await evaluateContextHook(binding, event(), host({ implementation: () => hash('f'), openCurrentView }))).status,
    ).toBe('unavailable');
    expect(openCurrentView).not.toHaveBeenCalled();
    const alias = join(temporary, 'alias');
    symlinkSync(root, alias, 'junction');
    const { digest: _digest, ...input } = binding;
    expect(() => createContextHookBinding({ ...input, root: alias })).toThrow(/physical|alias/i);
    expect(() => createContextHookBinding({ ...binding, credential: 'never-allowed' } as never)).toThrow();
  });
  it('only reads an unchanged closed binding from its fixed managed path', () => {
    const directory = join(root, '.ia/distributions/hosts');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'claude-context-fixture.binding.json');
    writeFileSync(path, JSON.stringify(binding));
    expect(readContextHookBinding(root, path)).toEqual(binding);
    writeFileSync(path, JSON.stringify({ ...binding, actor: 'changed' }));
    expect(() => readContextHookBinding(root, path)).toThrow(/digest|binding/i);
    const outside = join(temporary, 'foreign.binding.json');
    writeFileSync(outside, JSON.stringify(binding));
    expect(() => readContextHookBinding(root, outside)).toThrow();
  });
  it('returns a bounded explicit unavailable result for malformed or incomplete context', async () => {
    const result = await evaluateContextHook(binding, '{bad json', host());
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result.output)).not.toContain(root);
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThan(512);
    const pending = host();
    const result2 = await evaluateContextHook(
      binding,
      event(),
      host({
        openCurrentView: async (...args) => ({
          ...(await pending.openCurrentView(...args)),
          requiredParts: (input) => ({
            pins: input.pins,
            parts: [],
            missing: [{ id: 'guide', reason: 'not admitted' }],
            proof: hash('e'),
          }),
        }),
      }),
    );
    expect(result2.status).toBe('unavailable');
    expect(JSON.stringify(result2.output)).toContain('IA-LIFECYCLE-REQUIRED');
    const privateCode = await evaluateContextHook(
      binding,
      event(),
      host({
        assertCurrent: () => {
          throw new LifecycleError('private-secret-from-host', 'private source detail');
        },
      }),
    );
    expect(JSON.stringify(privateCode)).not.toContain('private-secret');
    expect(JSON.stringify(privateCode)).not.toContain('private source');
  });
});
