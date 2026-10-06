import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { open } from '@inventarch/db';
import {
  decodeLifecycleEvent,
  LifecycleError,
  lifecycleProfile,
} from '@inventarch/workspace-runtime/lifecycle-profile';
import {
  assembleLifecycleContextSegments,
  prepareLifecycleContextSegments,
} from '@inventarch/workspace-runtime/lifecycle';
import type { LifecycleView } from '@inventarch/workspace-runtime/lifecycle';
import { openLocalAuthoringView } from '@inventarch/workspace-runtime/authoring-manifest';
import { prepareAuthoringTarget, resolveAuthoring } from '@inventarch/workspace-runtime/authoring';
import { resourceOccurrences } from '@inventarch/workspace-runtime/resources';
import {
  createContextHookBinding,
  DEFAULT_CONTEXT_HOOK_BUDGETS,
  evaluateContextHook,
  evaluateContextHookPart,
  localContextHookHost,
  readContextHookBinding,
  runContextHook,
} from '../src/context.js';
import type { ContextHookBinding, ContextHookHost } from '../src/context.js';
import { runBounded } from '@tools/testing/subprocess.js';
import type { BoundedResult } from '@tools/testing/subprocess.js';
import { withScope } from '@tools/testing/resources.js';
import type { ResourceScope } from '@tools/testing/resources.js';

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
        profile: binding.profile.digest,
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
  // #479: a 30,000 ms deadline, the external default; it was 3,000 ms, which one evaluation overran on windows-latest. No case that
  // reads this binding checks a deadline: each deadline refusal selects its own 5 ms or 1 ms binding.
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
    budgets: { tokens: 20_000, records: 32, bytes: 80_000, timeoutMs: 30_000 },
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

// HOST-02 (private source history) Claude Code 2.1.285 payloads, constructed from docs and binary inspection; the HOST-06 case
// in `lifecycle-profile.test.ts` holds captured ones. The transcript and scratchpad paths are never opened.
const claude285 = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    session_id: '8f14e45f-ceea-467f-a0e6-4b1c2d3e5f60',
    transcript_path: join(temporary, 'never-read-transcript.jsonl'),
    cwd: root,
    scratchpad_dir: join(temporary, 'never-read-scratchpad'),
    ...fields,
  });
const prompt285 = {
  hook_event_name: 'UserPromptSubmit',
  prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  permission_mode: 'default',
  prompt: 'Author a native procedure',
};
const stale285 = {
  seconds_since_last_response: 5400,
  context_tokens: 182340,
  prompt_cache_likely_expired: true,
  estimated_cache_write_usd: 1.1396,
};
const served285: [string, Record<string, unknown>][] = [
  ['SessionStart startup', { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }],
  [
    'SessionStart resume',
    {
      hook_event_name: 'SessionStart',
      source: 'resume',
      model: 'claude-opus-5',
      session_title: 'ia work',
      ...stale285,
    },
  ],
  [
    'SessionStart clear',
    { hook_event_name: 'SessionStart', source: 'clear', prompt_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' },
  ],
  [
    'SessionStart compact',
    {
      hook_event_name: 'SessionStart',
      source: 'compact',
      model: 'claude-opus-5',
      prompt_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    },
  ],
  ['SessionStart fork', { hook_event_name: 'SessionStart', source: 'fork', model: 'claude-opus-5', ...stale285 }],
  ['UserPromptSubmit', prompt285],
];
const refused285: [string, string][] = [
  [
    'an unsupported PostCompact event',
    claude285({
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      compact_summary: 'Summary of the compacted conversation...',
    }),
  ],
  [
    'an unsupported SubagentStart event',
    claude285({ hook_event_name: 'SubagentStart', agent_id: 'agent-abc123', agent_type: 'Explore' }),
  ],
  ['an unsupported SessionEnd event', claude285({ hook_event_name: 'SessionEnd', reason: 'other' })],
  ['a top-level array', '[]'],
  ['empty stdin', ''],
];
const diagnostic = (code: string) => ({
  status: 'unavailable',
  delivery: 'not-generated',
  code,
  output: { systemMessage: `IA lifecycle context unavailable (${code}). No context was generated.` },
});

/** HOST-03 (private source history): the fixture binding re-created for another available row; every other selection is unchanged. */
function bindingFor(version: string): ContextHookBinding {
  const { digest: _digest, ...input } = binding;
  return createContextHookBinding({ ...input, profile: lifecycleProfile('claude-code', version) });
}

describe('Claude Code 2.1.285 events through the context executable (HOST-02)', () => {
  it.each(served285)(
    'answers a constructed %s event with exactly one bounded hookSpecificOutput frame',
    async (_name, fields) => {
      const result = await evaluateContextHookPart(binding, claude285(fields), 0, host());
      if (result.status !== 'generated' || !('hookSpecificOutput' in result.output))
        throw new Error(`Expected a generated frame: ${JSON.stringify(result)}`);
      const start = fields['hook_event_name'] === 'SessionStart',
        output = result.output.hookSpecificOutput;
      expect(Object.keys(result.output)).toEqual(['hookSpecificOutput']);
      expect(Object.keys(output).sort()).toEqual(['additionalContext', 'hookEventName']);
      expect(output.hookEventName).toBe(fields['hook_event_name']);
      expect(output.additionalContext.length).toBeLessThanOrEqual(10_000);
      expect(JSON.parse(output.additionalContext)).toMatchObject({
        format: 'ia.lifecycle-context-segment.v1',
        slot: 0,
        totalSlots: 12,
        delivery: 'unconfirmed',
        event: {
          kind: start ? 'start' : 'prompt',
          source: start ? fields['source'] : null,
          key: start ? null : expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
    },
  );

  // HOST-03 (private source history) flipped this HOST-02 characterization under H3-v1: a binding of the selected 2.1.285 row serves a
  // titled session's prompt, while a retained 2.1.278 binding still answers the fixed input diagnostic before opening a view.
  it('serves a 2.1.285 titled-session prompt under a 2.1.285 binding, and a retained 2.1.278 binding still refuses it', async () => {
    const openCurrentView = vi.fn(host().openCurrentView),
      titled = claude285({ ...prompt285, session_title: 'ia work' });
    const result = await evaluateContextHookPart(bindingFor('2.1.285'), titled, 0, host({ openCurrentView }));
    if (result.status !== 'generated' || !('hookSpecificOutput' in result.output))
      throw new Error(`Expected a generated frame: ${JSON.stringify(result)}`);
    expect(JSON.parse(result.output.hookSpecificOutput.additionalContext)).toMatchObject({
      pins: { profile: lifecycleProfile('claude-code', '2.1.285').digest },
      event: { kind: 'prompt', source: null },
    });
    expect(result.output.hookSpecificOutput.additionalContext).not.toContain('ia work');
    expect(openCurrentView).toHaveBeenCalledOnce();
    expect(await evaluateContextHookPart(binding, titled, 0, host({ openCurrentView }))).toEqual(
      diagnostic('IA-LIFECYCLE-INPUT'),
    );
    expect(openCurrentView).toHaveBeenCalledOnce();
  });

  it.each(refused285)(
    'answers %s with only the fixed input diagnostic, before opening a view',
    async (_name, input) => {
      const openCurrentView = vi.fn(host().openCurrentView);
      expect(await evaluateContextHookPart(binding, input, 0, host({ openCurrentView }))).toEqual(
        diagnostic('IA-LIFECYCLE-INPUT'),
      );
      expect(openCurrentView).not.toHaveBeenCalled();
    },
  );
});

function tree(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(directory, entry.name),
        stat = lstatSync(path),
        row = `${prefix}${entry.name} ${stat.size} ${stat.mtimeMs}`;
      return entry.isDirectory() ? [row, ...tree(path, `${prefix}${entry.name}/`)] : [row];
    });
}

describe('context executable binding, session and effect fixtures (HOST-02)', () => {
  it('refuses relative, missing and linked cwd spellings before opening a view', async () => {
    const openCurrentView = vi.fn(host().openCurrentView),
      selected = host({ openCurrentView });
    const outside = join(temporary, 'host-02-cwd-alias'),
      links = join(root, 'host-02-links'),
      inside = join(links, 'ia');
    symlinkSync(root, outside, 'junction');
    mkdirSync(links);
    symlinkSync(join(root, '.ia'), inside, 'junction');
    try {
      const answer = (cwd: string) => evaluateContextHookPart(binding, claude285({ ...prompt285, cwd }), 0, selected);
      expect(await answer('project')).toEqual(diagnostic('IA-LIFECYCLE-BINDING'));
      expect(await answer(join(root, 'host-02-missing'))).toEqual(diagnostic('IA-LIFECYCLE-UNAVAILABLE'));
      expect(await answer(outside)).toEqual(diagnostic('IA-LIFECYCLE-BINDING'));
      expect(await answer(join(outside, '.ia'))).toEqual(diagnostic('IA-LIFECYCLE-BINDING'));
      expect(await answer(inside)).toEqual(diagnostic('IA-LIFECYCLE-BINDING'));
      expect(openCurrentView).not.toHaveBeenCalled();
    } finally {
      rmSync(links, { recursive: true, force: true });
    }
  });

  // Characterization: a nested checkout or worktree under the root passes today, and its context still comes from the
  // bound root's view. Refusing it is a proposed refuse-only binding check (HOST-02 grounding 6.2 f), not a HOST-02 change.
  it('serves a nested worktree cwd from the bound root view today', async () => {
    const worktree = join(root, '.claude', 'worktrees', 'host-02-nested');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: ../../../.git/worktrees/host-02-nested\n');
    try {
      const nested = await evaluateContextHookPart(binding, claude285({ ...prompt285, cwd: worktree }), 0, host());
      const direct = await evaluateContextHookPart(binding, claude285(prompt285), 0, host());
      if (nested.status !== 'generated' || direct.status !== 'generated')
        throw new Error('Expected generated context for both cwd values');
      expect(nested.prepared.pins).toEqual(direct.prepared.pins);
      expect(nested.prepared.id).not.toBe(direct.prepared.id);
    } finally {
      rmSync(join(root, '.claude'), { recursive: true, force: true });
    }
  });

  it('refuses a binding that names another root, and does not consult CLAUDE_PROJECT_DIR today', async () => {
    const other = join(temporary, 'host-02-other-project');
    mkdirSync(other);
    const { digest: _digest, ...input } = binding;
    const foreign = createContextHookBinding({
      ...input,
      root: other,
      view: { ...input.view, manifests: [{ source: 'self', root: other }] },
    });
    const path = join(root, '.ia/distributions/hosts/claude-context-host-02-foreign.binding.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(foreign));
    expect(() => readContextHookBinding(root, path)).toThrow(/another root/);
    await expect(
      runContextHook(['--root', root, '--binding', path, '--part', '0'], claude285(prompt285)),
    ).rejects.toThrow(/another root/);
    // Characterization: the documented CLAUDE_PROJECT_DIR is never compared with the bound root. The proposed refuse-only
    // check (HOST-02 grounding, W8) is outside HOST-02.
    vi.stubEnv('CLAUDE_PROJECT_DIR', other);
    try {
      expect((await evaluateContextHookPart(binding, claude285(prompt285), 0, host())).status).toBe('generated');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('treats the host session as event identity only, and never assembles frames across sessions', async () => {
    const first = await evaluateContextHookPart(
      binding,
      claude285({ ...prompt285, session_id: 'session-a' }),
      0,
      host(),
    );
    const second = await evaluateContextHookPart(
      binding,
      claude285({ ...prompt285, session_id: 'session-b' }),
      0,
      host(),
    );
    if (
      first.status !== 'generated' ||
      second.status !== 'generated' ||
      !('outputs' in first.prepared) ||
      !('outputs' in second.prepared)
    )
      throw new Error('Expected generated segment sets');
    const a = first.prepared.outputs.map((output) => output.hookSpecificOutput.additionalContext),
      b = second.prepared.outputs.map((output) => output.hookSpecificOutput.additionalContext);
    expect(first.prepared.pins).toEqual(second.prepared.pins);
    expect(first.prepared.id).not.toBe(second.prepared.id);
    expect(assembleLifecycleContextSegments(a).id).toBe(first.prepared.id);
    expect(() => assembleLifecycleContextSegments([...a.slice(0, 6), ...b.slice(6)])).toThrow();
  });

  it('keeps writes and retained event admission out of the local profile', async () => {
    const local = localContextHookHost();
    expect(Object.keys(local).sort()).toEqual(['assertCurrent', 'implementation', 'openCurrentView']);
    const { digest: _digest, ...input } = binding;
    const selected = createContextHookBinding({
      ...input,
      scope: { root: '', identities: null },
      budgets: DEFAULT_CONTEXT_HOOK_BUDGETS,
    });
    const before = tree(root);
    expect(
      (
        await evaluateContextHookPart(selected, claude285(prompt285), 0, {
          ...local,
          implementation: () => implementation,
        })
      ).status,
    ).toBe('generated');
    expect(tree(root)).toEqual(before);
  }, 60_000);
});

describe('selected claude-code@2.1.285 bootstrap through the context executable (HOST-03)', () => {
  it.each(served285)(
    'serves a constructed %s event under a 2.1.285 binding with a frame pinned to that row',
    async (_name, fields) => {
      const result = await evaluateContextHookPart(bindingFor('2.1.285'), claude285(fields), 0, host());
      if (result.status !== 'generated' || !('hookSpecificOutput' in result.output))
        throw new Error(`Expected a generated frame: ${JSON.stringify(result)}`);
      expect(result.output.hookSpecificOutput.hookEventName).toBe(fields['hook_event_name']);
      expect(JSON.parse(result.output.hookSpecificOutput.additionalContext)).toMatchObject({
        slot: 0,
        totalSlots: 12,
        delivery: 'unconfirmed',
        pins: { profile: lifecycleProfile('claude-code', '2.1.285').digest },
      });
    },
  );

  it('refuses a 2.1.285 bootstrap whose required material is missing with only the fixed diagnostic', async () => {
    const missing = host({
      openCurrentView: async (...args) => ({
        ...(await host().openCurrentView(...args)),
        requiredParts: (input) => ({
          pins: input.pins,
          parts: [],
          missing: [{ id: 'guide', reason: 'not admitted' }],
          proof: hash('e'),
        }),
      }),
    });
    expect(
      await evaluateContextHookPart(
        bindingFor('2.1.285'),
        claude285({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5' }),
        0,
        missing,
      ),
    ).toEqual(diagnostic('IA-LIFECYCLE-REQUIRED'));
  });

  it('reports the selected row in the v2 identity handshake', async () => {
    expect(await runContextHook(['identity'], '')).toEqual({
      format: 'ia.context-hook-identity.v2',
      implementation: expect.stringMatching(/^[a-f0-9]{64}$/),
      profile: lifecycleProfile('claude-code', '2.1.285').digest,
      slots: 12,
      characters: 10_000,
    });
  });

  it('rebuilds the same bootstrap pins and required material, writing nothing, from a relocated workspace through the real local host', async () => {
    // HOST-03 (private source history) relocation and determinism. Each fresh() run imports the context executable into a new module
    // graph, so composition's content-keyed native-context cache starts empty and the run rebuilds; a second run in the same
    // graph constructs exactly one EditorSnapshot fewer, because it reuses that cache. The workspace copied to another physical
    // root and bound there yields the same source, view, resource, installation, profile, policy and implementation pins and
    // the same required parts; only the binding pin, which digests the fixed root, differs. No run changes the fixture root.
    const snapshots = { count: 0 },
      relocated = join(temporary, 'host-03-relocated');
    const fresh = async () => {
      vi.resetModules();
      return import('../src/context.js');
    };
    const start = async (hook: typeof import('../src/context.js'), at: string) => {
      const { digest: _digest, ...input } = binding,
        counted = snapshots.count;
      const bound = hook.createContextHookBinding({
        ...input,
        root: at,
        view: { ...input.view, manifests: [{ source: 'self', root: at }] },
        scope: { root: '', identities: null },
        budgets: DEFAULT_CONTEXT_HOOK_BUDGETS,
        profile: lifecycleProfile('claude-code', '2.1.285'),
      });
      const result = await hook.evaluateContextHookPart(
        bound,
        claude285({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5', cwd: at }),
        0,
        { ...hook.localContextHookHost(), implementation: () => implementation },
      );
      if (result.status !== 'generated')
        throw new Error(`Expected generated bootstrap context: ${JSON.stringify(result)}`);
      return {
        snapshots: snapshots.count - counted,
        id: result.prepared.id,
        pins: result.prepared.pins,
        required: JSON.parse(result.prepared.payload).required,
      };
    };
    try {
      // HOST-04 (private source history), from the HOST-03 review (m10): the mock and the copy are made inside the try, so the
      // finally always undoes them, even when the copy fails.
      vi.doMock('@inventarch/db/editor', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@inventarch/db/editor')>();
        class CountedSnapshot extends actual.EditorSnapshot {
          constructor(...input: ConstructorParameters<typeof actual.EditorSnapshot>) {
            super(...input);
            snapshots.count += 1;
          }
        }
        return { ...actual, EditorSnapshot: CountedSnapshot };
      });
      cpSync(root, relocated, { recursive: true });
      const before = tree(root);
      const graph = await fresh(),
        cold = await start(graph, root),
        warm = await start(graph, root),
        again = await start(await fresh(), root),
        moved = await start(await fresh(), relocated);
      expect(cold.snapshots - warm.snapshots).toBe(1);
      expect([again.snapshots, moved.snapshots]).toEqual([cold.snapshots, cold.snapshots]);
      for (const run of [warm, again]) expect({ ...run, snapshots: 0 }).toEqual({ ...cold, snapshots: 0 });
      const { binding: originalBinding, ...originalPins } = cold.pins,
        { binding: movedBinding, ...movedPins } = moved.pins;
      expect(movedPins).toEqual(originalPins);
      expect(movedBinding).not.toBe(originalBinding);
      expect(moved.required).toEqual(cold.required);
      expect(moved.required.parts.length).toBeGreaterThan(0);
      expect(tree(root)).toEqual(before);
    } finally {
      vi.doUnmock('@inventarch/db/editor');
      vi.resetModules();
      rmSync(relocated, { recursive: true, force: true });
    }
  }, 120_000);
});

/** HOST-04 (private source history): the fixture binding re-created for the selected row at another root, with the full native scope. */
function boundAt(at: string, change: Partial<Parameters<typeof createContextHookBinding>[0]> = {}): ContextHookBinding {
  const { digest: _digest, ...input } = binding;
  return createContextHookBinding({
    ...input,
    root: at,
    view: { ...input.view, manifests: [{ source: 'self', root: at }] },
    scope: { root: '', identities: null },
    budgets: DEFAULT_CONTEXT_HOOK_BUDGETS,
    profile: lifecycleProfile('claude-code', '2.1.285'),
    ...change,
  });
}
/** HOST-04: the local host's own view, selection and pins with a narrower resource permission; the cases check it against the local host. */
function permittedHost(denied: (key: string) => boolean): ContextHookHost {
  const checks = new WeakMap<LifecycleView, () => void>();
  return {
    implementation: () => implementation,
    openCurrentView: async (bound) => {
      const local = openLocalAuthoringView({ root: bound.root, ...bound.view, scope: bound.scope });
      try {
        const target = resourceOccurrences(local.capture).occurrences.find(
          (item) => item.identity === bound.selection.target,
        );
        if (!target) throw new Error('Fixture target is not admitted');
        const authoring = resolveAuthoring(local.capture, local.resources, local.index, {
          reader: local.reader,
          within: local.within,
          allowedResources: local.resources.files
            .map((file) => file.key)
            .filter((key) => !denied(`${key.source}@${key.revision}:${key.path}`)),
          allowedSystems: local.systems,
          allowedRegistrations: local.registrations,
          allowedArtifacts: local.index.artifacts.map((artifact) => artifact.id),
          allowedDocuments: local.index.documents.map((document) => document.id),
        });
        const pins = {
          binding: bound.digest,
          source: local.capture.revision,
          view: local.reader.snapshot({ within: local.within }).revision,
          resources: local.resources.digest,
          installation: local.capture.activation?.generation ?? null,
          profile: bound.profile.digest,
          policy: bound.policy,
          implementation: bound.implementation,
        };
        const view: LifecycleView = {
          reader: local.reader,
          within: local.within,
          pins,
          close: () => local.close(),
          requiredParts: (input) => {
            const result = prepareAuthoringTarget(authoring, { ...bound.selection, target });
            return { pins: input.pins, parts: result.parts, missing: result.missing, proof: result.proof };
          },
        };
        checks.set(view, () => local.assertCurrent());
        return view;
      } catch (error) {
        local.close();
        throw error;
      }
    },
    assertCurrent: (view) => {
      const check = checks.get(view);
      if (!check) throw new Error('Unrecognized fixture view');
      check();
    },
  };
}
/** The producer's citation grammar: <source>@<revision>:<path>#sha256=<digest>, then optional &lines=<a>-<b> and &identity=<identity>. */
const citationGrammar =
  /^(.+?)@([a-f0-9]{64}):(.+)#sha256=([a-f0-9]{64})(?:&lines=([0-9]+)-([0-9]+))?(?:&identity=(.+))?$/;

describe('prompt-scoped runtime and resource context through the context executable (HOST-04)', () => {
  // HOST-04 (private source history): a 2.1.285 binding serves UserPromptSubmit context through the real local host, from the
  // explicit manifest and the binding's own scope. Each refusal is the fixed closed diagnostic; no case writes the fixture root.
  const real = (): ContextHookHost => ({ ...localContextHookHost(), implementation: () => implementation });

  it('delivers allowed context through the real local host with exact resource attribution and finite bounds, writing nothing', async () => {
    const selected = boundAt(root),
      before = tree(root),
      result = await evaluateContextHookPart(selected, claude285(prompt285), 0, real());
    if (result.status !== 'generated' || !('outputs' in result.prepared))
      throw new Error(`Expected generated context: ${JSON.stringify(result)}`);
    const outputs = result.prepared.outputs,
      frames = outputs.map((output) => output.hookSpecificOutput.additionalContext),
      payload = JSON.parse(result.prepared.payload);
    expect(frames).toHaveLength(12);
    expect(Math.max(...frames.map((frame) => frame.length))).toBeLessThanOrEqual(10_000);
    for (const output of outputs) {
      expect(Object.keys(output)).toEqual(['hookSpecificOutput']);
      expect(Object.keys(output.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName']);
    }
    expect(assembleLifecycleContextSegments(frames).payload).toBe(result.prepared.payload);
    expect(result.prepared.usage.bytes).toBe(
      outputs.reduce((sum, output) => sum + Buffer.byteLength(JSON.stringify(output)), 0),
    );
    expect(result.prepared.usage.bytes).toBeLessThanOrEqual(DEFAULT_CONTEXT_HOOK_BUDGETS.bytes);
    expect(result.prepared.usage.tokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_HOOK_BUDGETS.tokens);
    expect(result.prepared.usage.records).toBe(
      payload.required.parts.length +
        new Set(payload.context.included.map((entry: { identity: string }) => entry.identity)).size,
    );
    expect(result.prepared.usage.records).toBeLessThanOrEqual(DEFAULT_CONTEXT_HOOK_BUDGETS.records);
    expect(Object.keys(payload.pins).sort()).toEqual([
      'binding',
      'implementation',
      'installation',
      'policy',
      'profile',
      'resources',
      'source',
      'view',
    ]);
    const view = openLocalAuthoringView({ root, ...selected.view, scope: selected.scope });
    try {
      expect(payload.pins).toMatchObject({
        binding: selected.digest,
        source: view.capture.revision,
        view: view.reader.snapshot({ within: view.within }).revision,
        resources: view.resources.digest,
        profile: lifecycleProfile('claude-code', '2.1.285').digest,
      });
      expect(payload.context.included.map((entry: { address: string }) => entry.address)).toContain(
        `${method}#${String(selected.coordinate['phase'])}/${String(selected.coordinate['primitive'])}`,
      );
      for (const entry of payload.context.included) {
        expect(view.reader.get(entry.identity, { within: view.within })).toBeDefined();
        expect(entry.citations.length).toBeGreaterThan(0);
      }
      const citations: string[] = payload.required.parts.flatMap((part: { citations: string[] }) => part.citations);
      expect(citations.length).toBeGreaterThanOrEqual(payload.required.parts.length);
      for (const citation of citations) {
        const match = citationGrammar.exec(citation);
        if (!match) throw new Error(`Required citation outside the producer grammar: ${citation}`);
        expect([match[1], match[2]]).toEqual([selected.view.id, payload.pins.source]);
        expect(match[4]).toBe(
          createHash('sha256')
            .update(readFileSync(join(root, match[3]!)))
            .digest('hex'),
        );
        if (match[7] !== undefined) expect(view.reader.get(match[7], { within: view.within })).toBeDefined();
      }
      expect(citations.some((citation) => citationGrammar.exec(citation)?.[7] === method)).toBe(true);
      expect(citations.some((citation) => !citation.includes('&identity='))).toBe(true);
    } finally {
      view.close();
    }
    expect(tree(root)).toEqual(before);
  }, 120_000);

  it('refuses hidden, denied and missing required material with only the fixed REQUIRED diagnostic', async () => {
    const prompt = claude285(prompt285);
    // Hidden by the binding's own scope: the target's guide and system records, then the target itself.
    expect(
      await evaluateContextHookPart(boundAt(root, { scope: { root: '', identities: [method] } }), prompt, 0, real()),
    ).toEqual(diagnostic('IA-LIFECYCLE-REQUIRED'));
    expect(
      await evaluateContextHookPart(boundAt(root, { scope: { root: '', identities: [] } }), prompt, 0, real()),
    ).toEqual(diagnostic('IA-LIFECYCLE-REQUIRED'));
    // The local host's own refusal, which the fixed output does not carry: exactly the REQUIRED pair when no identity is in scope.
    const hidden = boundAt(root, { scope: { root: '', identities: [] } }),
      view = await real().openCurrentView(
        hidden,
        decodeLifecycleEvent(hidden.profile, prompt),
        new AbortController().signal,
      );
    try {
      expect(() =>
        view.requiredParts({
          reader: view.reader,
          within: view.within,
          pins: view.pins,
          coordinate: hidden.coordinate as Readonly<Record<string, string>>,
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'IA-LIFECYCLE-REQUIRED',
          message: 'Required authoring context is unavailable',
        }),
      );
    } finally {
      view.close();
    }
    // Denied: one resource the required material cites leaves the resource permission; with every permission the packet is the local host's own.
    const shipped = await evaluateContextHookPart(boundAt(root), prompt, 0, real()),
      control = await evaluateContextHookPart(
        boundAt(root),
        prompt,
        0,
        permittedHost(() => false),
      );
    if (shipped.status !== 'generated' || control.status !== 'generated')
      throw new Error('Expected generated context from both hosts');
    expect(control.prepared.id).toBe(shipped.prepared.id);
    const resource = (JSON.parse(shipped.prepared.payload).required.parts as { citations: string[] }[])
      .flatMap((part) => part.citations)
      .find((citation) => !citation.includes('&identity='));
    if (!resource) throw new Error('Expected a cited required resource');
    const key = resource.slice(0, resource.indexOf('#sha256='));
    expect(
      await evaluateContextHookPart(
        boundAt(root),
        prompt,
        0,
        permittedHost((candidate) => candidate === key),
      ),
    ).toEqual(diagnostic('IA-LIFECYCLE-REQUIRED'));
    // Missing: the required-parts port reports an absent obligation.
    const missing = host({
      openCurrentView: async (...args) => ({
        ...(await host().openCurrentView(...args)),
        requiredParts: (input) => ({
          pins: input.pins,
          parts: [],
          missing: [{ id: 'guide', reason: 'not admitted' }],
          proof: hash('e'),
        }),
      }),
    });
    expect(await evaluateContextHookPart(bindingFor('2.1.285'), prompt, 0, missing)).toEqual(
      diagnostic('IA-LIFECYCLE-REQUIRED'),
    );
  }, 120_000);

  it('refuses a prompt whose source changes during its slot with only the fixed STALE diagnostic, and the next slot reads the changed source', async () => {
    const copy = join(temporary, 'host-04-stale'),
      record = join(copy, '.ia/src/systems/agent-composition-system/records/composition.ia');
    try {
      cpSync(root, copy, { recursive: true });
      const local = real(),
        changing: ContextHookHost = {
          ...local,
          openCurrentView: async (...args) => {
            const view = await local.openCurrentView(...args);
            writeFileSync(record, readFileSync(record, 'utf8') + '\n');
            return view;
          },
        };
      const at = boundAt(copy),
        prompt = claude285({ ...prompt285, cwd: copy }),
        first = await evaluateContextHookPart(at, prompt, 0, local);
      if (first.status !== 'generated') throw new Error(`Expected generated context: ${JSON.stringify(first)}`);
      expect(await evaluateContextHookPart(at, prompt, 0, changing)).toEqual(diagnostic('IA-LIFECYCLE-STALE'));
      const next = await evaluateContextHookPart(at, prompt, 0, local);
      if (next.status !== 'generated') throw new Error(`Expected generated context: ${JSON.stringify(next)}`);
      expect(next.prepared.pins.source).not.toBe(first.prepared.pins.source);
      // The local host's own refusal, which the fixed output does not carry: exactly the STALE pair after the record changes.
      const signal = new AbortController().signal,
        view = await local.openCurrentView(at, decodeLifecycleEvent(at.profile, prompt), signal);
      try {
        writeFileSync(record, readFileSync(record, 'utf8') + '\n');
        expect(() => local.assertCurrent(view, at, signal)).toThrow(
          expect.objectContaining({
            code: 'IA-LIFECYCLE-STALE',
            message: 'Local authoring source or resource selection changed',
          }),
        );
      } finally {
        view.close();
      }
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 120_000);

  // #447 review: the local host answers STALE only when the owners report that current bytes differ from those its open view
  // captured or pinned, and lets every other re-check failure through to the generic handling. Each case uses its own binding
  // with the default budgets, on its own copy of the fixture root.
  const recheck = (run: () => unknown): { name: string; code: unknown; message: string } => {
    try {
      run();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { name: error.name, code: (error as { code?: unknown }).code, message: error.message };
    }
    throw new Error('Expected the freshness re-check to refuse');
  };
  /** Patches one `node:fs` export for one synchronous run; the owners' named imports see the patch once it is synced. */
  type Hooked = (...args: unknown[]) => unknown;
  const mutableFs = createRequire(import.meta.url)('node:fs') as Record<
    'openSync' | 'readSync' | 'readFileSync',
    Hooked
  >;
  function patched(name: keyof typeof mutableFs, replace: (original: Hooked) => Hooked, run: () => unknown): void {
    const original = mutableFs[name];
    mutableFs[name] = replace(original);
    syncBuiltinESMExports();
    try {
      run();
    } finally {
      mutableFs[name] = original;
      syncBuiltinESMExports();
    }
  }
  /** Runs `action` once, just before the first open of a path ending with `suffix`. */
  const atOpen =
    (suffix: string, action: () => void) =>
    (run: () => unknown): void => {
      let armed = true;
      try {
        patched(
          'openSync',
          (open) =>
            (path, ...rest) => {
              if (armed && String(path).endsWith(suffix)) {
                armed = false;
                action();
              }
              return open(path, ...rest);
            },
          run,
        );
      } finally {
        expect(armed, `open mutation must fire exactly once: ${suffix}`).toBe(false);
      }
    };
  /** Runs `action` once, after the first read through a descriptor opened with numeric flags, as the owners open, on a path ending with `suffix`. */
  const afterRead =
    (suffix: string, action: () => void) =>
    (run: () => unknown): void => {
      let descriptor: unknown = null,
        armed = true;
      try {
        patched(
          'openSync',
          (open) =>
            (path, flags, ...rest) => {
              const fd = open(path, flags, ...rest);
              if (armed && descriptor === null && typeof flags === 'number' && String(path).endsWith(suffix))
                descriptor = fd;
              return fd;
            },
          () =>
            patched(
              'readSync',
              (read) =>
                (fd, ...rest) => {
                  const count = read(fd, ...rest);
                  if (armed && fd === descriptor) {
                    armed = false;
                    action();
                  }
                  return count;
                },
              run,
            ),
        );
      } finally {
        expect(armed, `read mutation must fire exactly once: ${suffix}`).toBe(false);
      }
    };
  /** Runs `action` once, just before the first whole-file read of a path ending with `suffix`. */
  const atReadFile =
    (suffix: string, action: () => void) =>
    (run: () => unknown): void => {
      let armed = true;
      try {
        patched(
          'readFileSync',
          (readFile) =>
            (path, ...rest) => {
              if (armed && String(path).endsWith(suffix)) {
                armed = false;
                action();
              }
              return readFile(path, ...rest);
            },
          run,
        );
      } finally {
        expect(armed, `whole-file mutation must fire exactly once: ${suffix}`).toBe(false);
      }
    };
  it('answers STALE whenever the re-check finds the source or resource selection changed', async () => {
    const copy = join(temporary, 'host-04-recheck-changed'),
      manifest = join(copy, '.ia/authoring.resources.json'),
      record = join(copy, '.ia/src/systems/agent-composition-system/records/composition.ia');
    try {
      cpSync(root, copy, { recursive: true });
      const at = boundAt(copy),
        local = real(),
        prompt = claude285({ ...prompt285, cwd: copy }),
        event = decodeLifecycleEvent(at.profile, prompt),
        signal = new AbortController().signal;
      const resourcePath = (JSON.parse(readFileSync(manifest, 'utf8')) as { files: { path: string }[] }).files[0]!.path,
        resource = join(copy, resourcePath);
      const append = (path: string) => () => appendFileSync(path, '\n'),
        aside = `${record}.aside`;
      const before =
        (action: () => void) =>
        (run: () => unknown): void => {
          action();
          run();
        };
      const rows: [string, (run: () => unknown) => void, { name: string; code: string; message: string | RegExp }][] = [
        [
          'a source edit after the view opened',
          before(append(record)),
          {
            name: 'ResourceError',
            code: 'IA-RESOURCE-INVALID',
            message: 'Local authoring source or selected resource view changed',
          },
        ],
        [
          'a selected resource edited off its pin after the view opened',
          before(append(resource)),
          { name: 'ResourceError', code: 'IA-RESOURCE-INVALID', message: 'Resource differs from its pinned size/hash' },
        ],
        [
          "a source edit at the re-check's manifest open",
          atOpen(join('.ia', 'authoring.resources.json'), append(record)),
          {
            name: 'ResourceError',
            code: 'IA-RESOURCE-INVALID',
            message: 'Physical native source differs from its captured revision',
          },
        ],
        [
          'the manifest changing while the re-check reads it',
          afterRead(join('.ia', 'authoring.resources.json'), append(manifest)),
          { name: 'ResourceError', code: 'IA-RESOURCE-INVALID', message: 'Authoring manifest changed while loading' },
        ],
        [
          'a selected resource changing while the re-check reads it',
          afterRead(join(...resourcePath.split('/')), append(resource)),
          { name: 'ResourceError', code: 'IA-RESOURCE-INVALID', message: 'Resource changed while capturing' },
        ],
        [
          'a source removed as the native capture reads it',
          atReadFile(join('agent-composition-system', 'records', 'composition.ia'), () => renameSync(record, aside)),
          {
            name: 'DbError',
            code: 'IA-DB-SOURCE-CHANGED',
            message:
              /^IA-DB-SOURCE-CHANGED: Cannot read exact UTF-8 source \.ia\/src\/systems\/agent-composition-system\/records\/composition\.ia: Error: ENOENT/,
          },
        ],
      ];
      expect(at.budgets).toEqual(DEFAULT_CONTEXT_HOOK_BUDGETS);
      expect((await evaluateContextHookPart(at, prompt, 0, local)).status).toBe('generated');
      const original = new Map([record, manifest, resource].map((path) => [path, readFileSync(path)]));
      const restore = () => {
        if (existsSync(aside)) renameSync(aside, record);
        for (const [path, bytes] of original) writeFileSync(path, bytes);
      };
      for (const [name, change, owner] of rows) {
        // The owner's own refusal for this change, then the local host's answer for the same change.
        const view = openLocalAuthoringView({ root: copy, ...at.view, scope: at.scope });
        try {
          expect(view.assertCurrent()).toBeUndefined();
          expect(
            recheck(() => change(() => view.assertCurrent())),
            name,
          ).toEqual({
            ...owner,
            message: typeof owner.message === 'string' ? owner.message : expect.stringMatching(owner.message),
          });
        } finally {
          view.close();
          restore();
        }
        const hosted = await local.openCurrentView(at, event, signal);
        try {
          expect(local.assertCurrent(hosted, at, signal)).toBeUndefined();
          expect(
            recheck(() => change(() => local.assertCurrent(hosted, at, signal))),
            name,
          ).toEqual({
            name: 'LifecycleError',
            code: 'IA-LIFECYCLE-STALE',
            message: 'Local authoring source or resource selection changed',
          });
        } finally {
          hosted.close();
          restore();
        }
      }
      // Through the slot, a change after the view opened answers the fixed STALE diagnostic.
      const changing: ContextHookHost = {
        ...local,
        openCurrentView: async (...args) => {
          const view = await local.openCurrentView(...args);
          append(record)();
          return view;
        },
      };
      try {
        expect(await evaluateContextHookPart(at, prompt, 0, changing)).toEqual(diagnostic('IA-LIFECYCLE-STALE'));
      } finally {
        restore();
      }
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 120_000);
  it('does not answer STALE for a closed view or an unchanged manifest the re-check cannot read', async () => {
    const copy = join(temporary, 'host-04-recheck-failed'),
      manifest = join(copy, '.ia/authoring.resources.json'),
      link = join(temporary, 'host-04-recheck-manifest-link.json');
    try {
      cpSync(root, copy, { recursive: true });
      const at = boundAt(copy),
        local = real(),
        prompt = claude285({ ...prompt285, cwd: copy }),
        signal = new AbortController().signal,
        bytes = readFileSync(manifest);
      expect(at.budgets).toEqual(DEFAULT_CONTEXT_HOOK_BUDGETS);
      const first = await evaluateContextHookPart(at, prompt, 0, local);
      if (first.status !== 'generated') throw new Error(`Expected generated context: ${JSON.stringify(first)}`);
      // A closed view: the owner's refusal passes through unchanged.
      const closed = await local.openCurrentView(at, decodeLifecycleEvent(at.profile, prompt), signal);
      closed.close();
      expect(recheck(() => local.assertCurrent(closed, at, signal))).toEqual({
        name: 'ResourceError',
        code: 'IA-RESOURCE-INVALID',
        message: 'Local authoring view is closed',
      });
      // A second hard link to the unchanged manifest after the view opened: the re-capture refuses to read it.
      const view = await local.openCurrentView(at, decodeLifecycleEvent(at.profile, prompt), signal);
      try {
        expect(local.assertCurrent(view, at, signal)).toBeUndefined();
        linkSync(manifest, link);
        expect(recheck(() => local.assertCurrent(view, at, signal))).toEqual({
          name: 'ResourceError',
          code: 'IA-RESOURCE-INVALID',
          message: 'Authoring manifest must be one bounded regular file',
        });
      } finally {
        view.close();
        rmSync(link, { force: true });
      }
      // Through the slot, the same failure answers the generic UNAVAILABLE diagnostic, and the manifest bytes never changed.
      const linking: ContextHookHost = {
        ...local,
        openCurrentView: async (...args) => {
          const view = await local.openCurrentView(...args);
          linkSync(manifest, link);
          return view;
        },
      };
      try {
        expect(await evaluateContextHookPart(at, prompt, 0, linking)).toEqual(diagnostic('IA-LIFECYCLE-UNAVAILABLE'));
      } finally {
        rmSync(link, { force: true });
      }
      expect(readFileSync(manifest).equals(bytes)).toBe(true);
      const next = await evaluateContextHookPart(at, prompt, 0, local);
      if (next.status !== 'generated') throw new Error(`Expected generated context: ${JSON.stringify(next)}`);
      expect(next.prepared.pins).toEqual(first.prepared.pins);
    } finally {
      rmSync(link, { force: true });
      rmSync(copy, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses a prompt beyond its byte budget with only the fixed BUDGET diagnostic', async () => {
    const { digest: _digest, ...input } = bindingFor('2.1.285');
    expect(
      await evaluateContextHookPart(
        createContextHookBinding({ ...input, budgets: { ...input.budgets, bytes: 128 } }),
        claude285(prompt285),
        0,
        host(),
      ),
    ).toEqual(diagnostic('IA-LIFECYCLE-BUDGET'));
  });

  it('answers an event from another project before opening any view', async () => {
    const other = join(temporary, 'host-04-other-project'),
      openCurrentView = vi.fn(host().openCurrentView);
    mkdirSync(other, { recursive: true });
    expect(
      await evaluateContextHookPart(
        bindingFor('2.1.285'),
        claude285({ ...prompt285, cwd: other }),
        0,
        host({ openCurrentView }),
      ),
    ).toEqual(diagnostic('IA-LIFECYCLE-BINDING'));
    expect(openCurrentView).not.toHaveBeenCalled();
  });

  it('keeps session metadata out of selection: equal pins and context, distinct packets that never assemble together', async () => {
    const selected = bindingFor('2.1.285');
    const first = await evaluateContextHookPart(
      selected,
      claude285({ ...prompt285, session_id: 'session-a' }),
      0,
      host(),
    );
    const second = await evaluateContextHookPart(
      selected,
      claude285({ ...prompt285, session_id: 'session-b', session_title: 'ia work', permission_mode: 'plan' }),
      0,
      host(),
    );
    if (
      first.status !== 'generated' ||
      second.status !== 'generated' ||
      !('outputs' in first.prepared) ||
      !('outputs' in second.prepared)
    )
      throw new Error('Expected generated segment sets');
    const a = JSON.parse(first.prepared.payload),
      b = JSON.parse(second.prepared.payload);
    expect(b.pins).toEqual(a.pins);
    expect(b.context).toEqual(a.context);
    expect(b.required).toEqual(a.required);
    expect(second.prepared.id).not.toBe(first.prepared.id);
    expect(b.event.key).not.toBe(a.event.key);
    const mixed = [...first.prepared.outputs.slice(0, 6), ...second.prepared.outputs.slice(6)].map(
      (output) => output.hookSpecificOutput.additionalContext,
    );
    expect(() => assembleLifecycleContextSegments(mixed)).toThrow(
      expect.objectContaining({
        code: 'IA-LIFECYCLE-BUDGET',
        message: 'Lifecycle segment set exceeds its bound or has missing, mixed or invalid data',
      }),
    );
  });

  it('selects each project from its own bytes in one process: other bytes rebuild, identical bytes share only content-derived context', async () => {
    // HOST-04: within one module graph, this path reuses composition's content-keyed native context between calls. A project
    // with other bytes rebuilds it and is served its own text; a byte-identical copy reuses it, gets the same content-derived
    // pins and still differs by its root-bound binding pin. The mock and the copies are made inside the try.
    const snapshots = { count: 0 },
      other = join(temporary, 'host-04-other-bytes'),
      same = join(temporary, 'host-04-same-bytes');
    const run = async (hook: typeof import('../src/context.js'), at: string) => {
      const counted = snapshots.count,
        result = await hook.evaluateContextHookPart(boundAt(at), claude285({ ...prompt285, cwd: at }), 0, {
          ...hook.localContextHookHost(),
          implementation: () => implementation,
        });
      if (result.status !== 'generated') throw new Error(`Expected generated context: ${JSON.stringify(result)}`);
      return {
        snapshots: snapshots.count - counted,
        id: result.prepared.id,
        pins: result.prepared.pins,
        payload: JSON.parse(result.prepared.payload),
      };
    };
    try {
      vi.doMock('@inventarch/db/editor', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@inventarch/db/editor')>();
        class CountedSnapshot extends actual.EditorSnapshot {
          constructor(...input: ConstructorParameters<typeof actual.EditorSnapshot>) {
            super(...input);
            snapshots.count += 1;
          }
        }
        return { ...actual, EditorSnapshot: CountedSnapshot };
      });
      cpSync(root, other, { recursive: true });
      cpSync(root, same, { recursive: true });
      vi.resetModules();
      const hook = await import('../src/context.js');
      const a = await run(hook, root),
        cell: string = a.payload.context.included.find((entry: { identity: string }) => entry.identity === method).text;
      const record = join(other, '.ia/src/systems/agent-composition-system/records/composition.ia'),
        source = readFileSync(record, 'utf8');
      expect(source.split(cell)).toHaveLength(2);
      writeFileSync(record, source.replace(cell, `${cell} Project B.`));
      const b = await run(hook, other),
        again = await run(hook, root),
        c = await run(hook, same);
      expect(b.snapshots).toBe(a.snapshots);
      expect([again.snapshots, c.snapshots]).toEqual([a.snapshots - 1, a.snapshots - 1]);
      expect(JSON.stringify(b.payload)).toContain(`${cell} Project B.`);
      expect(JSON.stringify(a.payload)).not.toContain('Project B.');
      expect(again.id).toBe(a.id);
      const { binding: aBinding, ...aPins } = a.pins,
        { binding: bBinding, ...bPins } = b.pins,
        { binding: cBinding, ...cPins } = c.pins;
      expect(cPins).toEqual(aPins);
      expect(new Set([aBinding, bBinding, cBinding]).size).toBe(3);
      expect(c.id).not.toBe(a.id);
      expect((Object.keys(aPins) as (keyof typeof aPins)[]).filter((key) => aPins[key] !== bPins[key]).sort()).toEqual([
        'resources',
        'source',
        'view',
      ]);
    } finally {
      vi.doUnmock('@inventarch/db/editor');
      vi.resetModules();
      for (const path of [other, same]) rmSync(path, { recursive: true, force: true });
    }
  }, 120_000);
});

/** HOST-05 (private source history): the emitted context executable, the module the cache launcher imports, run as new Node processes. */
const emitted = resolve(import.meta.dirname, '../dist/context.js');
/** The installed test profile's subprocess bound (tools/testing/tasks.json); a direct Vitest run uses the same value. */
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 120_000;
// process.getBuiltinModule runs only inside children under the permission model, where spawn, worker and write attempts are refused; it does not evade the spawn ratchet: every child of this test process starts through runBounded.
/** Test instrument, not product code: it reports on stderr every call that could start a child process or a worker thread, and every call of an fs entry point that writes a file. */
const watched = [
  "const fs = process.getBuiltinModule('node:fs'), childProcess = process.getBuiltinModule('node:child_process'), cluster = process.getBuiltinModule('node:cluster'), workerThreads = process.getBuiltinModule('node:worker_threads');",
  "const watch = (target, name, label = name, when = () => true) => { const original = target[name]; target[name] = function (...input) { if (when(input)) fs.writeSync(2, 'host-05: ' + label + ' called\\n'); return Reflect.apply(original, this, input); }; };",
  "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) watch(childProcess, name);",
  "watch(cluster, 'fork'); const Worker = workerThreads.Worker;",
  "workerThreads.Worker = class extends Worker { constructor(...input) { fs.writeSync(2, 'host-05: Worker called\\n'); super(...input); } };",
  "const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } = fs.constants, writing = ([, flags]) => typeof flags === 'number' ? (flags & (O_WRONLY | O_RDWR | O_APPEND | O_CREAT | O_TRUNC)) !== 0 : typeof flags === 'string' && /[wa+]/.test(flags);",
  "for (const name of ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'mkdirSync', 'rmSync', 'renameSync', 'copyFileSync', 'symlinkSync', 'createWriteStream']) watch(fs, name);",
  "watch(fs, 'openSync', 'openSync', writing); watch(fs, 'open', 'open', writing);",
  "for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'copyFile', 'symlink']) watch(fs.promises, name, 'promises.' + name); watch(fs.promises, 'open', 'promises.open', writing);",
  "process.getBuiltinModule('node:module').syncBuiltinESMExports();",
].join('\n');
/** Test instrument, not product code: it runs `action` when the process opens the bound manifest for the `count`-th time. It loads before the watch, so `open` is Node's own openSync. */
function atManifestOpen(count: number, action: string): string {
  return [
    "const fs = process.getBuiltinModule('node:fs'), open = fs.openSync; let opened = 0;",
    `fs.openSync = (file, ...rest) => { if (String(file).endsWith(${JSON.stringify(join('.ia', 'authoring.resources.json'))}) && ++opened === ${count}) { ${action} } return open(file, ...rest); };`,
    "process.getBuiltinModule('node:module').syncBuiltinESMExports();",
  ].join('\n');
}
interface Launch {
  readonly preload?: string;
  readonly write?: string;
  readonly plain?: boolean;
  readonly signal?: AbortSignal;
  readonly onStderr?: (chunk: string) => void;
}
/** Each started process's wall time, start to exit (#479). It bounds that process's preparation time from above; each case reports them once. */
const walls: number[] = [];
/** The suite's one way to start a process: Node under its permission model, read access only, with a case's instrument and then the watch above, unless plain. */
async function runNode(argv: readonly string[], input: string | Buffer, options: Launch = {}): Promise<BoundedResult> {
  const instruments = [...(options.preload === undefined ? [] : [options.preload]), watched].flatMap((source) => [
    '--import',
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]);
  const flags = options.plain
    ? []
    : [
        '--permission',
        '--allow-fs-read=*',
        ...(options.write === undefined ? [] : [`--allow-fs-write=${options.write}`]),
        ...instruments,
      ];
  const result = await runBounded(process.execPath, [...flags, ...argv], {
    input,
    timeoutMs: SUBPROCESS,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
  });
  walls.push(result.durationMs);
  return result;
}
const launch = (args: readonly string[], input: string | Buffer, options: Launch = {}): Promise<BoundedResult> =>
  runNode([emitted, ...args], input, options);
/** One context answer: the process exits by itself with status 0 and an empty stderr, and prints one JSON value. */
function answered(result: BoundedResult): unknown {
  expect({
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    stderr: result.stderr,
  }).toEqual({ status: 0, signal: null, timedOut: false, truncated: false, stderr: '' });
  return JSON.parse(result.stdout);
}
/** Exactly the fixed diagnostic, byte for byte. */
function diagnosed(result: BoundedResult, code: string): void {
  answered(result);
  expect(result.stdout).toBe(JSON.stringify(diagnostic(code).output));
}
/** The implementation a new process reports in its identity handshake; registration pins exactly this value. */
async function identify(): Promise<string> {
  const { implementation: reported } = answered(await launch(['identity'], '')) as { implementation: string };
  expect(reported).toMatch(/^[a-f0-9]{64}$/);
  return reported;
}
/** A disposable copy of the suite's fixture root, owned by the case's scope. */
function ownWorkspace(scope: ResourceScope, name: string): string {
  const at = scope.own(name, join(temporary, name), (path) => rmSync(path, { recursive: true, force: true }));
  cpSync(root, at, { recursive: true });
  return at;
}
/** HOST-04's boundAt for `at` with the maximum 60,000 ms deadline unless `change` selects budgets, written at its managed path as registration writes it, with the slot arguments that name it. */
function bindAt(
  at: string,
  name: string,
  change: Partial<Parameters<typeof createContextHookBinding>[0]>,
): { readonly binding: ContextHookBinding; readonly args: (part: number) => string[] } {
  const bound = boundAt(at, { budgets: { ...DEFAULT_CONTEXT_HOOK_BUDGETS, timeoutMs: 60_000 }, ...change }),
    path = join(at, `.ia/distributions/hosts/claude-context-${name}.binding.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(bound));
  return { binding: bound, args: (part) => ['--root', at, '--binding', path, '--part', String(part)] };
}
interface SlotFrame {
  readonly packetId: string;
  readonly pins: Readonly<Record<string, string | null>>;
  readonly event: {
    readonly kind: string;
    readonly source: string | null;
    readonly key: string | null;
    readonly inputDigest: string;
  };
  readonly dataCount: number;
  readonly wholeDigest: string;
}
/** A slot's additionalContext: stdout is exactly one hookSpecificOutput for the event, of at most 10,000 characters. */
function contextOf(result: BoundedResult, hookEventName = 'UserPromptSubmit'): string {
  const output = answered(result) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(Object.keys(output)).toEqual(['hookSpecificOutput']);
  expect(Object.keys(output.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName']);
  expect(output.hookSpecificOutput.hookEventName).toBe(hookEventName);
  expect(output.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10_000);
  return output.hookSpecificOutput.additionalContext;
}
const slotFrame = (result: BoundedResult, hookEventName?: string): SlotFrame =>
  JSON.parse(contextOf(result, hookEventName)) as SlotFrame;
/** The twelve slot processes of one event, four at a time. */
async function allSlots(args: (part: number) => string[], input: string): Promise<BoundedResult[]> {
  const results: BoundedResult[] = [];
  for (let first = 0; first < 12; first += 4)
    results.push(...(await Promise.all([0, 1, 2, 3].map((offset) => launch(args(first + offset), input)))));
  return results;
}

describe('the context executable in new processes on the selected claude-code@2.1.285 row (HOST-05)', () => {
  // HOST-05 (private source history): each case owns a disposable copy of the suite's fixture root and runs the executable this
  // source builds as separate Node processes, with constructed 2.1.285 payloads. Bindings pin the implementation that the
  // identity handshake reports, as registration does. A run that is not plain has read access only, under Node's permission model.
  const selectedDigest = lifecycleProfile('claude-code', '2.1.285').digest,
    compact = served285.find(([name]) => name === 'SessionStart compact')?.[1];
  // #479: one line per case with its processes' wall times. The longest bounds every one of its preparations, so the margin
  // to the 60,000 ms deadline is at least the deadline minus that maximum; Vitest's own report gives the case's duration.
  afterEach((context) => {
    const times = walls.splice(0);
    if (times.length > 0)
      console.info(
        'HOST-05 process wall times',
        JSON.stringify({
          case: context.task.name,
          processes: times.length,
          maxMs: Math.round(Math.max(...times)),
          totalMs: Math.round(times.reduce((sum, time) => sum + time, 0)),
        }),
      );
  });

  it('reports the selected row in its identity handshake, the same in every process, and refuses any other identity argument with status 1', async () => {
    const first = await launch(['identity'], ''),
      second = await launch(['identity'], ''),
      extra = await launch(['identity', 'extra'], '');
    expect(answered(first)).toEqual({
      format: 'ia.context-hook-identity.v2',
      implementation: expect.stringMatching(/^[a-f0-9]{64}$/),
      profile: selectedDigest,
      slots: 12,
      characters: 10_000,
    });
    answered(second);
    expect(second.stdout).toBe(first.stdout);
    expect({ status: extra.status, stderr: extra.stderr, stdout: extra.stdout }).toEqual({
      status: 1,
      stderr: '',
      stdout: JSON.stringify(diagnostic('IA-LIFECYCLE-UNAVAILABLE').output),
    });
  }, 300_000);

  it(
    'delivers one prompt through twelve slot processes, and a duplicate delivery prints byte-identical frames',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-duplicate'),
          reported = await identify(),
          selected = bindAt(at, 'host-05', { implementation: reported }),
          input = claude285({ ...prompt285, cwd: at }),
          before = tree(at);
        const first = await allSlots(selected.args, input);
        const packet = assembleLifecycleContextSegments(first.map((result) => contextOf(result))),
          payload = JSON.parse(packet.payload);
        expect(first.map((result) => slotFrame(result).packetId)).toEqual(Array.from({ length: 12 }, () => packet.id));
        expect(Object.keys(payload.pins).sort()).toEqual([
          'binding',
          'implementation',
          'installation',
          'policy',
          'profile',
          'resources',
          'source',
          'view',
        ]);
        expect(payload.pins).toMatchObject({
          binding: selected.binding.digest,
          implementation: reported,
          policy: selected.binding.policy,
          profile: selectedDigest,
        });
        expect(payload.event).toEqual({
          kind: 'prompt',
          source: null,
          key: decodeLifecycleEvent(selected.binding.profile, input).key,
          inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        // #479: the duplicate delivery runs the first and last slots that carry data and slot 11, an empty-slot marker while fewer than
        // twelve slots carry data, each in a new process, instead of all twelve again. This case is the suite's one twelve-process assembly.
        const compared = [...new Set([0, slotFrame(first[0]!).dataCount - 1, 11])],
          duplicate = await Promise.all(compared.map((part) => launch(selected.args(part), input)));
        for (const result of duplicate) answered(result);
        expect(duplicate.map((result) => result.stdout)).toEqual(compared.map((part) => first[part]!.stdout));
        expect(tree(at)).toEqual(before);
      }),
    300_000,
  );

  it(
    'keeps volatile prompt metadata out of the event key: a title or a permission mode changes only the input digest and packet, another prompt id changes the key',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-metadata'),
          selected = bindAt(at, 'host-05', { implementation: await identify() }),
          before = tree(at);
        const slot0 = async (fields: Record<string, unknown>) =>
          slotFrame(await launch(selected.args(0), claude285({ ...prompt285, cwd: at, ...fields })));
        const base = await slot0({}),
          titled = await slot0({ session_title: 'ia work' }),
          planned = await slot0({ permission_mode: 'plan' }),
          retried = await slot0({ prompt_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' });
        for (const variant of [titled, planned]) {
          expect(variant.event.key).toBe(base.event.key);
          expect(variant.event.inputDigest).not.toBe(base.event.inputDigest);
          expect(variant.packetId).not.toBe(base.packetId);
          expect(variant.pins).toEqual(base.pins);
        }
        expect(retried.event.key).not.toBe(base.event.key);
        expect(retried.packetId).not.toBe(base.packetId);
        expect(retried.pins).toEqual(base.pins);
        expect(tree(at)).toEqual(before);
      }),
    300_000,
  );

  it(
    'serves a source edit made between two processes from the next process, and from a compact SessionStart after it',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-refresh'),
          reported = await identify(),
          selected = bindAt(at, 'host-05', { implementation: reported }),
          input = claude285({ ...prompt285, cwd: at });
        const record = join(at, '.ia/src/systems/agent-composition-system/records/composition.ia'),
          source = readFileSync(record, 'utf8');
        // The method cell's current text, read in this process as HOST-04's cache-scope case reads it.
        const real = { ...localContextHookHost(), implementation: () => reported },
          local = await evaluateContextHookPart(selected.binding, input, 0, real);
        if (local.status !== 'generated' || !compact)
          throw new Error(`Expected generated context and the constructed compact payload: ${JSON.stringify(local)}`);
        const cell: string = JSON.parse(local.prepared.payload).context.included.find(
          (entry: { identity: string }) => entry.identity === method,
        ).text;
        const earlier = slotFrame(await launch(selected.args(0), input));
        expect(source.split(cell)).toHaveLength(2);
        writeFileSync(record, source.replace(cell, `${cell} Edited between processes.`));
        // #479: one slot process after the edit, not twelve; P2 holds the twelve-process assembly. That process prints exactly the frame
        // the test process prepares from the edited workspace, and the frame carries the digest of the whole packet, whose method cell is edited.
        const next = await launch(selected.args(0), input),
          later = slotFrame(next),
          edited = await evaluateContextHookPart(selected.binding, input, 0, real);
        if (edited.status !== 'generated')
          throw new Error(`Expected generated context from the edited workspace: ${JSON.stringify(edited)}`);
        expect(next.stdout).toBe(JSON.stringify(edited.output));
        expect(later.wholeDigest).toBe(createHash('sha256').update(edited.prepared.payload).digest('hex'));
        const view = openLocalAuthoringView({ root: at, ...selected.binding.view, scope: selected.binding.scope });
        try {
          expect(later.pins).toMatchObject({
            source: view.capture.revision,
            view: view.reader.snapshot({ within: view.within }).revision,
            resources: view.resources.digest,
          });
        } finally {
          view.close();
        }
        expect(later.pins['source']).not.toBe(earlier.pins['source']);
        expect(
          JSON.parse(edited.prepared.payload).context.included.find(
            (entry: { identity: string }) => entry.identity === method,
          ).text,
        ).toBe(`${cell} Edited between processes.`);
        const compacted = slotFrame(await launch(selected.args(0), claude285({ ...compact, cwd: at })), 'SessionStart');
        expect(compacted.event).toMatchObject({ kind: 'start', source: 'compact', key: null });
        expect(compacted.pins).toEqual(later.pins);
      }),
    300_000,
  );

  it(
    'refuses a prompt whose source changes during its slot process with only the fixed STALE diagnostic, and serves the next process',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-stale'),
          selected = bindAt(at, 'host-05', { implementation: await identify() }),
          input = claude285({ ...prompt285, cwd: at });
        const record = join(at, '.ia/src/systems/agent-composition-system/records/composition.ia'),
          size = lstatSync(record).size;
        // The second open of the bound manifest is the local host's first freshness re-check, after the slot's view opened. The
        // instrument appends one newline to the record there, before that re-check reads it, so that re-check finds the change. It
        // loads before the watch and writes through Node's own openSync, which it captured, so the watch reports no write of its own.
        const changed = atManifestOpen(
          2,
          `const fd = open(${JSON.stringify(record)}, 'a'); fs.writeSync(fd, '\\n'); fs.closeSync(fd); fs.writeSync(2, 'host-05: source changed\\n');`,
        );
        const stale = await launch(selected.args(0), input, { preload: changed, write: record });
        expect({
          status: stale.status,
          signal: stale.signal,
          timedOut: stale.timedOut,
          stderr: stale.stderr,
          stdout: stale.stdout,
        }).toEqual({
          status: 0,
          signal: null,
          timedOut: false,
          stderr: 'host-05: source changed\n',
          stdout: JSON.stringify(diagnostic('IA-LIFECYCLE-STALE').output),
        });
        expect(lstatSync(record).size).toBe(size + 1);
        slotFrame(await launch(selected.args(0), input));
      }),
    300_000,
  );

  it(
    'serves each supported SessionStart source as a fresh bootstrap of the same view, and answers unsupported events with only the fixed INPUT diagnostic',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-session-start'),
          selected = bindAt(at, 'host-05', { implementation: await identify() }),
          before = tree(at),
          frames: SlotFrame[] = [];
        for (const [, fields] of served285.filter(([name]) => name.startsWith('SessionStart ')))
          frames.push(slotFrame(await launch(selected.args(0), claude285({ ...fields, cwd: at })), 'SessionStart'));
        expect(frames.map((started) => started.event)).toEqual(
          ['startup', 'resume', 'clear', 'compact', 'fork'].map((source) => ({
            kind: 'start',
            source,
            key: null,
            inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          })),
        );
        for (const started of frames) expect(started.pins).toEqual(frames[0]!.pins);
        expect(new Set(frames.map((started) => started.packetId)).size).toBe(5);
        expect(frames[0]!.pins['profile']).toBe(selectedDigest);
        const unsupported = refused285.filter(([name]) => name.startsWith('an unsupported ')),
          messages = new Map([
            ['PostCompact', 'Unknown or non-data lifecycle field'],
            ['SubagentStart', 'Unsupported lifecycle event'],
            ['SessionEnd', 'Unknown or non-data lifecycle field'],
          ]);
        expect(unsupported).toHaveLength(3);
        for (const [, text] of unsupported) {
          diagnosed(await launch(selected.args(0), text), 'IA-LIFECYCLE-INPUT');
          expect(() => decodeLifecycleEvent(selected.binding.profile, text)).toThrow(
            expect.objectContaining({
              code: 'IA-LIFECYCLE-INPUT',
              message: messages.get(JSON.parse(text).hook_event_name),
            }),
          );
        }
        expect(tree(at)).toEqual(before);
      }),
    300_000,
  );

  it(
    'refuses at a 1 ms preparation deadline with only the fixed DEADLINE diagnostic, and delivers at the 60,000 ms maximum',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-deadline'),
          reported = await identify(),
          input = claude285({ ...prompt285, cwd: at });
        const late = bindAt(at, 'host-05-late', {
            implementation: reported,
            budgets: { ...DEFAULT_CONTEXT_HOOK_BUDGETS, timeoutMs: 1 },
          }),
          ample = bindAt(at, 'host-05-ample', {
            implementation: reported,
            budgets: { ...DEFAULT_CONTEXT_HOOK_BUDGETS, timeoutMs: 60_000 },
          });
        diagnosed(await launch(late.args(0), input), 'IA-LIFECYCLE-DEADLINE');
        slotFrame(await launch(ample.args(0), input));
        // The refusal that the fixed output does not carry, at the method: the selector over the real local host, as the executable calls it.
        const bound = late.binding,
          realHost = { ...localContextHookHost(), implementation: () => reported },
          event = decodeLifecycleEvent(bound.profile, input),
          signal = new AbortController().signal;
        await expect(
          prepareLifecycleContextSegments(
            {
              profile: bound.profile,
              coordinate: bound.coordinate,
              bootstrap: bound.bootstrap,
              budgets: bound.budgets,
              binding: bound.digest,
              policy: bound.policy,
              implementation: bound.implementation,
            },
            event,
            {
              openCurrentView: () => realHost.openCurrentView(bound, event, signal),
              assertCurrent: (view) => realHost.assertCurrent(view, bound, signal),
            },
          ),
        ).rejects.toMatchObject({ code: 'IA-LIFECYCLE-DEADLINE', message: 'Lifecycle context deadline exceeded' });
      }),
    300_000,
  );

  it(
    'prints nothing from a slot process stopped at its last freshness check, and answers malformed input or a misplaced binding with one exit-0 diagnostic',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-interrupted'),
          selected = bindAt(at, 'host-05', { implementation: await identify() }),
          input = claude285({ ...prompt285, cwd: at }),
          misplaced = join(at, 'claude-context-host-05.binding.json');
        writeFileSync(misplaced, JSON.stringify(selected.binding));
        const before = tree(at);
        // The third open of the bound manifest is the slot's last freshness re-check, after selection. The instrument reports that point
        // and blocks; the test ends the process when it reads the report, so the stop is at a known point and never on a timer.
        const stop = new AbortController(),
          paused = atManifestOpen(
            3,
            "fs.writeSync(2, 'host-05: paused\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
          );
        let seen = '';
        const stopped = await launch(selected.args(0), input, {
          preload: paused,
          signal: stop.signal,
          onStderr: (chunk) => {
            seen += chunk;
            if (seen.includes('host-05: paused')) stop.abort();
          },
        });
        expect({ stdout: stopped.stdout, stderr: stopped.stderr, timedOut: stopped.timedOut }).toEqual({
          stdout: '',
          stderr: 'host-05: paused\n',
          timedOut: false,
        });
        diagnosed(await launch(selected.args(0), '{bad json'), 'IA-LIFECYCLE-INPUT');
        diagnosed(await launch(selected.args(0), Buffer.from([0xc3, 0x28])), 'IA-LIFECYCLE-UNAVAILABLE');
        diagnosed(
          await launch(['--root', at, '--binding', misplaced, '--part', '0'], input),
          'IA-LIFECYCLE-UNAVAILABLE',
        );
        expect(tree(at)).toEqual(before);
      }),
    300_000,
  );

  it(
    'starts no child process or worker thread and writes nothing: plain runs print the same bytes, and the same flags refuse all three',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-effects'),
          selected = bindAt(at, 'host-05', { implementation: await identify() }),
          retained = bindAt(at, 'host-05-retained', { profile: lifecycleProfile('claude-code', '2.1.278') });
        const input = claude285({ ...prompt285, cwd: at }),
          before = tree(at);
        // The two paths: a generated prompt, and the retained binding's refusal under another implementation pin.
        for (const [args, refusal] of [
          [selected.args(0), null],
          [retained.args(0), 'IA-LIFECYCLE-BINDING'],
        ] as const) {
          const guarded = await launch(args, input),
            plain = await launch(args, input, { plain: true });
          if (refusal === null) contextOf(guarded);
          else diagnosed(guarded, refusal);
          answered(plain);
          expect(plain.stdout).toBe(guarded.stdout);
        }
        expect(tree(at)).toEqual(before);
        const attempts = [
          "() => process.getBuiltinModule('node:child_process').spawnSync(process.execPath, ['-e', ''])",
          "() => new (process.getBuiltinModule('node:worker_threads').Worker)('', { eval: true })",
          `() => process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(join(at, 'host-05-control.txt'))}, '')`,
        ];
        const control = await runNode(
          [
            '--input-type=module',
            '-e',
            `const codes = []; for (const attempt of [${attempts.join(', ')}]) { try { attempt(); codes.push('allowed'); } catch (error) { codes.push(error.code); } } process.stdout.write(JSON.stringify(codes));`,
          ],
          '',
        );
        expect({ status: control.status, stderr: control.stderr, codes: JSON.parse(control.stdout) }).toEqual({
          status: 0,
          stderr: 'host-05: spawnSync called\nhost-05: Worker called\nhost-05: writeFileSync called\n',
          codes: ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED'],
        });
        expect(tree(at)).toEqual(before);
      }),
    300_000,
  );

  it(
    'refuses a retained 2.1.278 binding in a new process of the executable that reports 2.1.285: INPUT for a titled prompt, BINDING otherwise, before any view opens',
    () =>
      withScope(async (scope) => {
        const at = ownWorkspace(scope, 'host-05-cross-version'),
          identity = answered(await launch(['identity'], '')) as { implementation: string; profile: string },
          retained = lifecycleProfile('claude-code', '2.1.278');
        expect(identity.profile).toBe(selectedDigest);
        expect(identity.profile).not.toBe(retained.digest);
        // A retained binding pins the implementation of the executable it was registered with: here the suite's stand-in digest.
        const registered = bindAt(at, 'host-05-retained', { profile: retained }),
          current = bindAt(at, 'host-05-current', { profile: retained, implementation: identity.implementation });
        expect(registered.binding).toMatchObject({
          profile: { version: '2.1.278', digest: retained.digest },
          implementation: hash('a'),
          policy: hash('b'),
        });
        const untitled = claude285({ ...prompt285, cwd: at }),
          titled = claude285({ ...prompt285, cwd: at, session_title: 'ia work' });
        // Opening a view opens the bound manifest; this instrument reports its first open, so an empty stderr shows no view opened.
        const noView = { preload: atManifestOpen(1, "fs.writeSync(2, 'host-05: view opened\\n');") };
        diagnosed(await launch(registered.args(0), titled, noView), 'IA-LIFECYCLE-INPUT');
        expect(() => decodeLifecycleEvent(retained, titled)).toThrow(
          expect.objectContaining({ code: 'IA-LIFECYCLE-INPUT', message: 'Unknown or non-data lifecycle field' }),
        );
        diagnosed(await launch(registered.args(0), untitled, noView), 'IA-LIFECYCLE-BINDING');
        // Only the implementation pin differs from the refused binding: under the pin of the executable that runs, the retained row is served.
        expect(slotFrame(await launch(current.args(0), untitled)).pins).toMatchObject({
          profile: retained.digest,
          implementation: identity.implementation,
          binding: current.binding.digest,
        });
        console.info(
          'HOST-05 cross-version pins',
          JSON.stringify({
            executable: identity,
            registered: {
              binding: registered.binding.digest,
              profile: retained.digest,
              implementation: registered.binding.implementation,
              policy: registered.binding.policy,
            },
            current: current.binding.digest,
          }),
        );
      }),
    300_000,
  );
});

describe('the installation pin through the real local host (PT3)', () => {
  // PT3 (private source history): a workspace with an activated installed generation yields a packet whose installation pin is
  // that generation, and a fresh evaluation reports the generation activation moved to. The installed state is written in
  // process with @inventarch/db/distribution's own recipes and read back by its verifying reader; no archive is packed. This case has
  // its own binding with the default 30,000 ms deadline, not the suite's shared binding.
  it(
    'pins the active installed generation, then the generation activation moves to, then the rolled-back one',
    () =>
      withScope(async (scope) => {
        const distribution = await import('@inventarch/db/distribution'),
          json = distribution.canonicalDistributionJson;
        const at = ownWorkspace(scope, 'pt3-installation'),
          folder = '.ia/src/systems/pt3-fixture-system',
          written = new Set<string>();
        const put = (path: string, content: string | Uint8Array): void => {
          const target = join(at, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        };
        // One original fixture system that requires two authored systems of the copied workspace; 0.1.1 changes one record.
        const release = (version: string) => {
          const files = new Map<string, Buffer>([
            [
              `${folder}/release.ia`,
              Buffer.from(
                `#! ia 1.0\n\n@workspace pt3-fixture-workspace\n  meaning\n    says "PT3 fixture generation ${version}"\n    answers "Which fixture system is selected?"\n  composition\n    systems [@system pt3-fixture-system]\n@distribution pt3-fixture-release\n  meaning\n    says "Original PT3 qualification release"\n    answers "What is installed?"\n  distribution\n    records [@workspace pt3-fixture-workspace]\n`,
              ),
            ],
            [
              `${folder}/steward.ia`,
              Buffer.from(
                '#! ia 1.0\n\n@agent pt3-fixture-steward\n  meaning\n    says "Maintains the original PT3 qualification fixture."\n    answers "Who maintains the PT3 fixture?"\n  governance\n    applies [workspace]\n    requires "Keep the fixture structural"\n',
              ),
            ],
            [
              `${folder}/system.ia`,
              Buffer.from(
                '#! ia 1.0\n\n@system pt3-fixture-system\n  provider "fixture"\n  version "0.1.0"\n  describes "Original fixture system for the PT3 foundation update and rollback qualification"\n  steward @agent pt3-fixture-steward\n  requires\n    - agent-system\n    - workspace-system\n',
              ),
            ],
          ]);
          const manifest = distribution.decodeBundleManifest({
            formatVersion: 1,
            id: 'fixture/pt3-system',
            version,
            distribution: 'workspace-system/definition/distribution/pt3-fixture-release',
            engine: '^0.1.0',
            language: ['1.0'],
            source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
            license: 'Apache-2.0',
            description: 'Original PT3 qualification fixture',
            roots: ['workspace-system/definition/workspace/pt3-fixture-workspace'],
            systems: [{ name: 'pt3-fixture-system', path: folder, provider: 'fixture', version: '0.1.0' }],
            dependencies: [],
            files: [...files].map(([path, bytes]) => ({
              path,
              bytes: bytes.length,
              sha256: distribution.sha256(bytes),
              role: 'source',
            })),
          });
          const manifestDigest = distribution.sha256(json(manifest)),
            archiveDigest = distribution.sha256(`pt3-fixture-archive-${version}`),
            bundle = { manifest, files, archiveDigest, manifestDigest };
          const lock = distribution.decodeDistributionLock({
            formatVersion: 1,
            engine: '^0.1.0',
            requests: [{ id: manifest.id, range: version }],
            packages: [
              {
                id: manifest.id,
                version,
                archive: archiveDigest,
                manifest: manifestDigest,
                location: `sha256:${archiveDigest}`,
                dependencies: [],
              },
            ],
          });
          const bundles = new Map([[manifest.id, bundle]]),
            inputs = distribution.deriveGenerationInputs(lock, bundles),
            workspace = distribution.installationWorkspace(lock, inputs, bundles);
          return {
            bundle,
            lock,
            inputs,
            workspace,
            generation: distribution.generationDigest(lock, inputs, workspace),
          };
        };
        // Activation as the installer leaves it: immutable store and generation, then the portable lock and the active pointer.
        const activate = (selected: ReturnType<typeof release>, previous: string | null, counter: number): void => {
          if (!written.has(selected.generation)) {
            written.add(selected.generation);
            const store = `.ia/distributions/store/${selected.bundle.archiveDigest}`,
              generation = `.ia/distributions/generations/${selected.generation}`;
            for (const [path, bytes] of selected.bundle.files) put(`${store}/${path}`, bytes);
            put(`${store}/distribution.json`, json(selected.bundle.manifest));
            put(`${generation}/lock.json`, json(selected.lock));
            put(`${generation}/inputs.json`, json(selected.inputs));
            if (selected.workspace !== null) put(`${generation}/workspace.ia`, selected.workspace);
          }
          put('.ia/distributions.lock.json', json(selected.lock));
          put(
            '.ia/distributions/active.json',
            json({ formatVersion: 1, generation: selected.generation, previous, counter }),
          );
        };
        const bound = createContextHookBinding({
          format: 'ia.context-hook-binding.v1',
          root: at,
          owner: 'local-owner',
          actor: 'local-actor',
          workspace: 'local-workspace',
          profile: lifecycleProfile('claude-code', '2.1.285'),
          view: { id: 'project', adopted: [], manifests: [{ source: 'self', root: at }] },
          scope: { root: '', identities: null },
          selection: { target: method, document: null, lifecycle: null },
          coordinate: { phase: 'act', primitive: 'Attention', category: 'process' },
          bootstrap: 'Author native procedures',
          budgets: DEFAULT_CONTEXT_HOOK_BUDGETS,
          policy,
          implementation,
        });
        expect(bound.budgets.timeoutMs).toBe(30_000);
        const pins = async (): Promise<{ installation: string | null; source: string }> => {
          const result = await evaluateContextHookPart(bound, claude285({ ...prompt285, cwd: at }), 0, {
            ...localContextHookHost(),
            implementation: () => implementation,
          });
          if (result.status !== 'generated') throw new Error(`Expected generated context: ${JSON.stringify(result)}`);
          return JSON.parse(result.prepared.payload).pins;
        };
        const clean = await pins();
        expect(clean.installation).toBeNull();
        const first = release('0.1.0'),
          second = release('0.1.1');
        expect(second.generation).not.toBe(first.generation);
        activate(first, null, 1);
        const one = await pins();
        expect(one.installation).toBe(first.generation);
        expect(one.source).not.toBe(clean.source);
        activate(second, first.generation, 2);
        const two = await pins();
        expect(two.installation).toBe(second.generation);
        expect(two.source).not.toBe(one.source);
        // Rollback re-activates the first generation under a new counter: its pin returns, and the source pin is a new capture.
        activate(first, second.generation, 3);
        const back = await pins();
        expect(back.installation).toBe(first.generation);
        expect([one.source, two.source]).not.toContain(back.source);
      }),
    300_000,
  );
});
