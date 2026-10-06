import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { open } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { digest } from '@inventarch/session-system';
import { DEFAULT_TOKENIZER, context } from '@inventarch/runtime';
import { createNativeLifecycleEvent, decodeLifecycleEvent, lifecycleProfile } from '../src/lifecycle-profile.js';
import {
  prepareLifecycleContext,
  prepareScopedContext,
  serializeLifecycleContext,
  prepareScopedContextSegments,
  prepareLifecycleContextSegments,
  assembleLifecycleContextSegments,
} from '../src/lifecycle.js';
import type { LifecyclePins, LifecycleView, RequiredContextParts } from '../src/lifecycle.js';

const temporary = mkdtempSync(join(tmpdir(), 'ia-lifecycle-'));
const root = join(temporary, 'project'),
  method = 'governance-system/definition/procedure/sample-procedure';
const law = 'governance-system/governance/law/sample-rule';
const profile = lifecycleProfile('claude-code', '2.1.278');
const event = decodeLifecycleEvent(
  profile,
  JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session',
    prompt_id: 'p1',
    cwd: root,
    prompt: 'Author a native method',
  }),
);
const coordinate = { phase: 'orient', primitive: 'Decision', category: 'process' };
const budgets = { tokens: 20_000, records: 32, bytes: 80_000, timeoutMs: 5000 };
let reader: Handle;
function pins(view = reader.revision): LifecyclePins {
  return {
    binding: digest('registered'),
    source: digest('capture'),
    view,
    resources: digest('resources'),
    installation: null,
    profile: profile.digest,
    policy: digest('policy'),
    implementation: digest('implementation'),
  };
}
function required(input: { pins: LifecyclePins }): RequiredContextParts {
  return {
    pins: input.pins,
    parts: [{ id: 'required-guide', text: 'Required native authoring guide', citations: ['guide@sha256:exact'] }],
    missing: [],
    proof: digest('verified-guide-proof'),
  };
}
function request() {
  return {
    reader,
    within: reader.resolveScope({ identities: [method, law] }).token,
    pins: pins(),
    profile,
    event,
    coordinate,
    text: event.prompt!,
    budgets,
    requiredParts: required,
  };
}

beforeAll(() => {
  cpSync(resolve(import.meta.dirname, '../../..', 'examples/conformance/native'), join(root, '.ia/src'), {
    recursive: true,
    filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
  });
  reader = open(root, { cache: false });
}, 30_000);
afterAll(() => {
  reader?.close();
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep) || !temporary.includes('ia-lifecycle-'))
    throw new Error('Unsafe cleanup');
  rmSync(temporary, { recursive: true, force: true });
});

describe('shared scoped lifecycle context', () => {
  it('summarizes host omission diagnostics without losing included, required or citation data', () => {
    const input = { ...request(), budgets: { ...budgets, records: 2 } },
      claude = JSON.parse(prepareScopedContext(input).payload);
    const native = lifecycleProfile('ia-native', '1'),
      event = createNativeLifecycleEvent({
        session: 'comparison',
        profile: 'author',
        invocation: null,
        text: input.text,
      });
    const original = JSON.parse(
      prepareScopedContext({ ...input, profile: native, event, pins: { ...input.pins, profile: native.digest } })
        .payload,
    );
    expect(claude.required).toEqual(original.required);
    expect(claude.context.included).toEqual(original.context.included);
    expect(claude.context.followed).toEqual(original.context.followed);
    const raw = context(
      input.reader,
      { within: input.within, revision: input.pins.view, coordinate: input.coordinate, text: input.text },
      { tokens: input.budgets.tokens, records: input.budgets.records - 1 },
    );
    if (!raw.ok) throw new Error('Runtime context unexpectedly unavailable');
    expect(raw.packet.omitted.length).toBeGreaterThan(0);
    expect(original.context.omitted).toEqual(claude.context.omitted);
    expect(
      claude.context.omitted.every(
        (row: Record<string, unknown>) => Object.keys(row).sort().join(',') === 'count,reason',
      ),
    ).toBe(true);
    expect(claude.context.omitted.reduce((sum: number, row: { count: number }) => sum + row.count, 0)).toBe(
      raw.packet.omitted.length,
    );
    for (const row of claude.context.omitted)
      expect(row.count).toBe(
        raw.packet.omitted.filter((item: { reason: string }) => item.reason === row.reason).length,
      );
    expect(claude.pins).toEqual(input.pins);
  });
  it('preserves complete required material across bounded segments while native remains unsegmented', async () => {
    const input = request(),
      requiredParts = (value: { pins: LifecyclePins }) => ({
        ...required(value),
        parts: [{ id: 'full-guide', text: 'Required full guide 🧭\n'.repeat(900), citations: ['exact-guide'] }],
      });
    expect(() => prepareScopedContext({ ...input, requiredParts })).toThrow(/budget|bound/i);
    const segmented = prepareScopedContextSegments({ ...input, requiredParts });
    expect(segmented.outputs).toHaveLength(12);
    expect(segmented.usage.bytes).toBe(
      segmented.outputs.reduce((sum, output) => sum + Buffer.byteLength(JSON.stringify(output)), 0),
    );
    expect(segmented.usage.bytes).toBeLessThanOrEqual(budgets.bytes);
    expect(
      assembleLifecycleContextSegments(segmented.outputs.map((output) => output.hookSpecificOutput.additionalContext))
        .payload,
    ).toBe(segmented.payload);
    const native = lifecycleProfile('ia-native', '1'),
      nativeEvent = createNativeLifecycleEvent({
        session: 'native',
        profile: 'author',
        invocation: null,
        text: input.text,
      });
    expect(
      prepareScopedContext({
        ...input,
        requiredParts,
        profile: native,
        event: nativeEvent,
        pins: { ...input.pins, profile: native.digest },
      }).payload.length,
    ).toBeGreaterThan(10_000);
    expect(() =>
      prepareScopedContextSegments({
        ...input,
        profile: native,
        event: nativeEvent,
        pins: { ...input.pins, profile: native.digest },
      }),
    ).toThrow();
    let opens = 0;
    const binding = {
      profile,
      coordinate,
      bootstrap: 'Bootstrap',
      budgets,
      binding: pins().binding,
      policy: pins().policy,
      implementation: pins().implementation,
    };
    const host = {
      openCurrentView: async () => {
        opens++;
        return { ...input, requiredParts, close: () => {} };
      },
      assertCurrent: () => {},
    };
    expect((await prepareLifecycleContextSegments(binding, event, host)).id).toBe(
      (await prepareLifecycleContextSegments(binding, event, host)).id,
    );
    expect(opens).toBe(2);
    expect(() =>
      prepareScopedContextSegments({ ...input, requiredParts, budgets: { ...budgets, bytes: 1000 } }),
    ).toThrow(/budget|bound/i);
  });
  it('uses an explicit retained native profile and measures its own payload wrapper', () => {
    const native = lifecycleProfile('ia-native', '1'),
      input = request();
    const event = createNativeLifecycleEvent({
      session: 'native-session',
      profile: 'native-profile',
      invocation: 'model-attempt-1',
      text: 'Author a native method',
    });
    const prepared = prepareScopedContext({
      ...input,
      profile: native,
      event,
      pins: { ...input.pins, profile: native.digest },
    });
    expect(prepared.output).toMatchObject({ format: 'ia.native-context.v1', additionalContext: expect.any(String) });
    expect(prepared.output).not.toHaveProperty('hookSpecificOutput');
    expect(prepared.usage.bytes).toBe(Buffer.byteLength(JSON.stringify(prepared.output)));
    expect(() => decodeLifecycleEvent(native, '{}')).toThrow(/native.*factory/i);
  });
  it('selects actual native context and counts the complete Claude wrapper without leaking scope tokens', () => {
    const input = request(),
      prepared = prepareScopedContext(input),
      output = serializeLifecycleContext(prepared),
      serialized = JSON.stringify(output);
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: expect.stringContaining('Required native authoring guide'),
      },
    });
    expect(serialized).toContain('Sample fixture statement 6.');
    expect(serialized).not.toContain(input.within);
    expect(serialized).not.toContain(root.replaceAll('\\', '\\\\'));
    expect(prepared.usage.bytes).toBe(Buffer.byteLength(serialized));
    expect(prepared.usage.tokens).toBe(DEFAULT_TOKENIZER.count(serialized));
    expect(prepared.delivery).toBe('unconfirmed');
    const payload = JSON.parse(prepared.payload);
    expect(
      payload.context.included.every(
        (entry: Record<string, unknown>) => !Object.hasOwn(entry, 'score') && !Object.hasOwn(entry, 'clauses'),
      ),
    ).toBe(true);
    expect(
      payload.context.followed.every(
        (edge: Record<string, unknown>) => !Object.hasOwn(edge, 'assertions') && Array.isArray(edge['citations']),
      ),
    ).toBe(true);
    expect(
      prepareScopedContext({ ...input, within: reader.resolveScope({ identities: [method, law] }).token }).id,
    ).toBe(prepared.id);
  });

  it('refuses missing guides, incomplete coordinates, stale pins and full-wrapper overflow', () => {
    expect(() => prepareScopedContext({ ...request(), text: 'Content changed outside its event' })).toThrow(
      /event|input/i,
    );
    expect(() =>
      prepareScopedContext({
        ...request(),
        requiredParts: (input) => ({ ...required(input), missing: [{ id: 'guide', reason: 'unavailable' }] }),
      }),
    ).toThrow(/required/i);
    expect(() => prepareScopedContext({ ...request(), coordinate: { phase: 'orient' } })).toThrow();
    expect(() => prepareScopedContext({ ...request(), pins: pins(digest('stale')) })).toThrow(/view|stale/i);
    expect(() =>
      prepareScopedContext({
        ...request(),
        requiredParts: (input) => ({ ...required(input), pins: { ...input.pins, resources: digest('stale') } }),
      }),
    ).toThrow(/pin|stale/i);
    expect(() => prepareScopedContext({ ...request(), budgets: { ...budgets, bytes: 128 } })).toThrow(/budget|bound/i);
    expect(() => prepareScopedContext({ ...request(), budgets: { ...budgets, tokens: 1 } })).toThrow(
      /budget|blocking|bound/i,
    );
  });

  it('keeps required native blocking guidance when optional selection shrinks', () => {
    const first = prepareScopedContext(request());
    const minimum = prepareScopedContext({ ...request(), budgets: { ...budgets, records: 2 } });
    expect(minimum.usage.bytes).toBeLessThan(first.usage.bytes);
    const limited = prepareScopedContext({ ...request(), budgets: { ...budgets, bytes: minimum.usage.bytes + 100 } });
    expect(limited.payload).toContain('sample-rule');
    expect(limited.payload).toContain('Required native authoring guide');
    expect(limited.payload).not.toContain('Sample fixture statement 6.');
    expect(limited.payload).toContain('"reason":"budget"');
  });

  it('reserves required authoring and blocking guidance while explicitly omitting optional retrieval', () => {
    const full = prepareScopedContext(request());
    const minimum = prepareScopedContext({ ...request(), optional: 'omit' });
    expect(minimum.payload).toContain('Required native authoring guide');
    expect(minimum.payload).toContain('sample-rule');
    expect(minimum.payload).not.toContain('Sample fixture statement 6.');
    expect(minimum.usage.bytes).toBeLessThan(full.usage.bytes);
    expect(() => prepareScopedContext({ ...request(), optional: 'omit', budgets: { ...budgets, bytes: 128 } })).toThrow(
      /budget|bound/i,
    );
  });

  it('snapshots caller binding before awaiting and refuses a changed current binding', async () => {
    const input = request(),
      close = vi.fn();
    const binding = {
      profile,
      coordinate: { ...coordinate },
      bootstrap: 'Bootstrap',
      budgets: { ...budgets },
      binding: pins().binding,
      policy: pins().policy,
      implementation: pins().implementation,
    };
    let resume!: () => void,
      observed = '';
    const pending = prepareLifecycleContext(binding, event, {
      openCurrentView: async (copy) => {
        observed = copy.policy;
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
        return { ...input, close };
      },
      assertCurrent: async () => {},
    });
    binding.policy = digest('replacement-policy');
    binding.coordinate.primitive = 'Memory';
    binding.budgets.bytes = 1;
    await Promise.resolve();
    resume();
    expect((await pending).payload).toContain('Sample fixture statement 6.');
    expect(observed).toBe(input.pins.policy);
    expect(close).toHaveBeenCalledOnce();
    let checks = 0;
    await expect(
      prepareLifecycleContext({ ...binding, policy: input.pins.policy, coordinate, budgets }, event, {
        openCurrentView: async () => ({ ...input, close }),
        assertCurrent: async () => {
          if (++checks === 2) throw new Error('Current source binding changed');
        },
      }),
    ).rejects.toThrow(/changed/i);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('joins only stable prompt identities to an explicit retained adapter without suppressing replay output', async () => {
    const input = request(),
      saved = new Map<string, string>();
    let opens = 0,
      accepts = 0;
    const binding = {
      profile,
      coordinate,
      bootstrap: 'Bootstrap',
      budgets,
      binding: pins().binding,
      policy: pins().policy,
      implementation: pins().implementation,
    };
    const host = {
      openCurrentView: async () => {
        opens++;
        return { ...input, close: () => {} };
      },
      assertCurrent: async () => {},
      acceptInput: async (identity: { key: string | null; inputDigest: string }) => {
        accepts++;
        expect(identity.key).not.toBe(event.key);
        const prior = saved.get(identity.key!);
        if (prior && prior !== identity.inputDigest) throw new Error('Changed event bytes');
        saved.set(identity.key!, identity.inputDigest);
      },
    };
    const first = await prepareLifecycleContext(binding, event, host),
      replay = await prepareLifecycleContext(binding, event, host);
    expect(replay.id).toBe(first.id);
    expect(replay.delivery).toBe('unconfirmed');
    expect(accepts).toBe(2);
    expect(opens).toBe(2);
    const changed = decodeLifecycleEvent(
      profile,
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session',
        prompt_id: 'p1',
        cwd: root,
        prompt: 'Changed bytes',
      }),
    );
    await expect(prepareLifecycleContext(binding, changed, host)).rejects.toThrow(/changed/i);
    const compact = decodeLifecycleEvent(
      profile,
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'session', cwd: root }),
    );
    await prepareLifecycleContext(binding, compact, host);
    expect(accepts).toBe(3);
    expect(opens).toBe(4);
  });

  it('makes all scope and delivery pins part of context identity', () => {
    const input = request(),
      first = prepareScopedContext(input);
    for (const name of ['binding', 'source', 'resources', 'installation', 'policy', 'implementation'] as const) {
      expect(
        prepareScopedContext({ ...input, pins: { ...input.pins, [name]: digest(`changed-${name}`) } }).id,
      ).not.toBe(first.id);
    }
  });
  it('does not let a required-material callback change the already selected method coordinate', () => {
    const coordinate = { phase: 'orient', primitive: 'Decision', category: 'process' };
    const prepared = prepareScopedContext({
      ...request(),
      coordinate,
      requiredParts: (input) => {
        coordinate.primitive = 'Memory';
        return required(input);
      },
    });
    expect(prepared.payload.includes('Sample fixture statement 6.')).toBe(true);
    expect(JSON.parse(prepared.payload).context.coordinate.values.primitive).toBe('Decision');
  });
  it('refuses a host view retargeted during the current-authority callback', async () => {
    const input = request(),
      close = vi.fn(),
      view = { ...input, close };
    const binding = {
      profile,
      coordinate,
      bootstrap: 'Bootstrap',
      budgets,
      binding: pins().binding,
      policy: pins().policy,
      implementation: pins().implementation,
    };
    await expect(
      prepareLifecycleContext(binding, event, {
        openCurrentView: async () => view,
        assertCurrent: async () => {
          view.pins = { ...view.pins, resources: digest('other-resource-selection') };
        },
      }),
    ).rejects.toThrow(/stale|changed|differ/i);
    expect(close).toHaveBeenCalledOnce();
  });

  it('reopens fresh bootstrap views, including repeated compact payloads, while retained readers stay exact', async () => {
    const retained = prepareScopedContext(request()),
      path = join(root, '.ia/src/systems/governance-system/records/sample-procedure.ia');
    const original = readFileSync(path, 'utf8');
    const start = decodeLifecycleEvent(
      profile,
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'same', cwd: root }),
    );
    let opens = 0,
      closes = 0;
    const binding = {
      profile,
      coordinate,
      bootstrap: 'Author a native method',
      budgets,
      binding: pins().binding,
      policy: pins().policy,
      implementation: pins().implementation,
    };
    const host = {
      openCurrentView: async (): Promise<LifecycleView> => {
        opens++;
        const db = open(root, { cache: false });
        return {
          reader: db,
          within: db.resolveScope({ identities: [method, law] }).token,
          pins: { ...pins(db.revision), source: digest(readFileSync(path, 'utf8')) },
          requiredParts: required,
          close: () => {
            closes++;
            db.close();
          },
        };
      },
      assertCurrent: async () => {},
    };
    const first = await prepareLifecycleContext(binding, start, host);
    writeFileSync(path, original.replace('Sample fixture statement 6.', 'Determine freshly whether'));
    try {
      const second = await prepareLifecycleContext(binding, start, host);
      expect(first.id).not.toBe(second.id);
      expect(second.payload).toContain('Determine freshly whether');
      expect(prepareScopedContext(request()).id).toBe(retained.id);
      expect(opens).toBe(2);
      expect(closes).toBe(2);
    } finally {
      writeFileSync(path, original);
    }
  }, 30_000);

  it('bounds uncooperative host waits and closes a view that arrives after cancellation', async () => {
    const abort = new AbortController(),
      close = vi.fn();
    let finish!: (view: LifecycleView) => void;
    const binding = {
      profile,
      coordinate,
      bootstrap: 'Bootstrap',
      budgets,
      binding: pins().binding,
      policy: pins().policy,
      implementation: pins().implementation,
    };
    const pending = prepareLifecycleContext(
      binding,
      event,
      {
        openCurrentView: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        assertCurrent: async () => {},
      },
      abort.signal,
    );
    await Promise.resolve();
    abort.abort();
    await expect(pending).rejects.toThrow(/cancel|abort/i);
    finish({ ...request(), close });
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    await expect(
      prepareLifecycleContext({ ...binding, budgets: { ...budgets, timeoutMs: 20 } }, event, {
        openCurrentView: async () => ({ ...request(), close }),
        assertCurrent: () => new Promise(() => {}),
      }),
    ).rejects.toThrow(/deadline|time/i);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('synchronous selection deadline (HOST-02)', () => {
  it('refuses a packet whose synchronous selection outlasts the deadline, which no abort signal can interrupt', async () => {
    // HOST-02 (private source history) timeout fixture: the timer cannot fire inside synchronous selection, so only the
    // post-selection deadline check stops a late packet; the executable's outer host timeout bounds the wall clock.
    let completed = false;
    const binding = {
      profile,
      coordinate,
      bootstrap: 'Bootstrap',
      budgets: { ...budgets, timeoutMs: 200 },
      binding: pins().binding,
      policy: pins().policy,
      implementation: pins().implementation,
    };
    const slow = (input: { pins: LifecyclePins }): RequiredContextParts => {
      const until = Date.now() + 400;
      while (Date.now() < until) {
        /* synchronous work */
      }
      completed = true;
      return required(input);
    };
    await expect(
      prepareLifecycleContextSegments(binding, event, {
        openCurrentView: async () => ({ ...request(), requiredParts: slow, close: () => {} }),
        assertCurrent: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'IA-LIFECYCLE-DEADLINE' });
    expect(completed).toBe(true);
  });
});

describe('selected claude-code@2.1.285 bootstrap (HOST-03)', () => {
  it('emits a deterministic twelve-slot bootstrap pinned to its own row, reporting the selected source and resources', async () => {
    // HOST-03 (private source history): the existing selector and transport emit the H3-v1 SessionStart bootstrap. Each run opens its
    // own cache-disabled reader, so nothing selected in one run is reused by the next. The packet pins its own profile and the
    // view's source, resources, installation and policy. Before the transport accepted this row, every segmented request ended
    // in a misleading IA-LIFECYCLE-BUDGET or IA-LIFECYCLE-CONTEXT refusal.
    const selected = lifecycleProfile('claude-code', '2.1.285'),
      expected = { ...pins(), profile: selected.digest };
    const binding = {
      profile: selected,
      coordinate,
      bootstrap: 'Author a native method',
      budgets,
      binding: expected.binding,
      policy: expected.policy,
      implementation: expected.implementation,
    };
    let opens = 0,
      closes = 0;
    const host = {
      openCurrentView: async (): Promise<LifecycleView> => {
        opens++;
        const db = open(root, { cache: false });
        return {
          reader: db,
          within: db.resolveScope({ identities: [method, law] }).token,
          pins: { ...expected, view: db.revision },
          requiredParts: required,
          close: () => {
            closes++;
            db.close();
          },
        };
      },
      assertCurrent: async () => {},
    };
    const start = (source: string) =>
      decodeLifecycleEvent(
        selected,
        JSON.stringify({
          hook_event_name: 'SessionStart',
          source,
          session_id: 'session',
          cwd: root,
          model: 'claude-opus-5',
        }),
      );
    const first = await prepareLifecycleContextSegments(binding, start('startup'), host),
      again = await prepareLifecycleContextSegments(binding, start('startup'), host);
    expect([opens, closes]).toEqual([2, 2]);
    expect(again.outputs).toEqual(first.outputs);
    expect(first.outputs.map((output) => output.hookSpecificOutput.hookEventName)).toEqual(
      Array(12).fill('SessionStart'),
    );
    const payload = JSON.parse(
      assembleLifecycleContextSegments(first.outputs.map((output) => output.hookSpecificOutput.additionalContext))
        .payload,
    );
    expect(payload.pins).toEqual(expected);
    expect(payload.event).toMatchObject({ kind: 'start', source: 'startup', key: null });
    expect(payload.required.parts.map((part: { id: string }) => part.id)).toEqual(['required-guide']);
    for (const source of ['resume', 'clear', 'compact', 'fork'])
      expect((await prepareLifecycleContextSegments(binding, start(source), host)).id).not.toBe(first.id);
    await expect(
      prepareLifecycleContextSegments(binding, start('startup'), {
        ...host,
        openCurrentView: async () => ({ ...request(), close: () => {} }),
      }),
    ).rejects.toMatchObject({ code: 'IA-LIFECYCLE-STALE', message: 'Current lifecycle binding pins differ' });
    // #447 review (reviewer-reported): this case opens six cache-disabled views and ran past vitest's 5 s default on a slow
    // Windows host, so it takes the 120 s bound the HOST-04 cases in apps/steward-hook/tests/context.test.ts use.
  }, 120_000);
});

describe('prompt-scoped runtime and resource context on the selected claude-code@2.1.285 row (HOST-04)', () => {
  // HOST-04 (private source history): selection is the runtime door's own context(), the function behind ia_context, over the
  // caller's admitted view. These cases pin that behavior for 2.1.285 prompts with exact diagnostics. Each bound is tested
  // on both sides of a measured minimum, so no case depends on the size of the corpus.
  const selected = lifecycleProfile('claude-code', '2.1.285'),
    keys = ['binding', 'implementation', 'installation', 'policy', 'profile', 'resources', 'source', 'view'];
  const ask = (identities: readonly string[] | null, prompt = 'Author a native method') => ({
    ...request(),
    within: reader.resolveScope(identities === null ? {} : { identities: [...identities] }).token,
    pins: { ...pins(), profile: selected.digest },
    profile: selected,
    text: prompt,
    event: decodeLifecycleEvent(
      selected,
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session',
        prompt_id: 'p1',
        cwd: root,
        prompt,
      }),
    ),
  });
  const delivered = (input: Parameters<typeof prepareScopedContextSegments>[0]) =>
    JSON.parse(
      assembleLifecycleContextSegments(
        prepareScopedContextSegments(input).outputs.map((output) => output.hookSpecificOutput.additionalContext),
      ).payload,
    );
  const refused = (code: string, message: string) => expect.objectContaining({ code, message });
  const generous = { ...budgets, tokens: 256 * 1024, bytes: 1024 * 1024 };
  /** The serialized size of the smallest deliverable packet, measured at a budget of its own value because the packet embeds its budgets. */
  const minimum = (identities: readonly string[], key: 'bytes' | 'tokens'): number => {
    let bound = budgets[key];
    for (let round = 0; round < 4; round++) {
      const used = prepareScopedContextSegments({
        ...ask(identities),
        optional: 'omit',
        budgets: { ...budgets, [key]: bound },
      }).usage[key];
      if (used === bound) return bound;
      bound = used;
    }
    throw new Error(`No stable ${key} minimum`);
  };

  it('selects the declared method cell and keeps the declared phase and primitive whatever the prompt says', () => {
    const first = delivered(ask([method, law])).context;
    expect(first.coordinate.values).toMatchObject({ phase: 'orient', primitive: 'Decision', category: 'process' });
    expect(first.coordinate.sources).toMatchObject({ phase: 'declared', primitive: 'declared', category: 'declared' });
    expect(first.included[0]).toMatchObject({
      address: `${method}#orient/Decision`,
      identity: method,
      kind: 'definition',
      text: expect.stringMatching(/^Sample fixture statement /),
    });
    const planned = delivered({
      ...ask([method, law]),
      coordinate: { phase: 'plan', primitive: 'Inference', category: 'process' },
    }).context;
    expect(planned.included[0]).toMatchObject({
      address: `${method}#plan/Inference`,
      identity: method,
      kind: 'definition',
    });
    expect(planned.included[0].text).not.toBe(first.included[0].text);
    const steered = delivered(
      ask([method, law], 'In the act phase, recall Memory, then plan Inference for this change'),
    ).context;
    expect(steered.coordinate.values).toMatchObject({ phase: 'orient', primitive: 'Decision' });
    expect(steered.coordinate.sources).toMatchObject({ phase: 'declared', primitive: 'declared' });
    expect(steered.included[0]).toMatchObject({ address: `${method}#orient/Decision`, text: first.included[0].text });
  });

  it("delivers exactly the runtime door's ranking, identities, texts and citations for the same scoped request", () => {
    const input = { ...ask(null), budgets: generous },
      payload = delivered(input);
    const door = context(
      reader,
      { within: input.within, revision: input.pins.view, coordinate: input.coordinate, text: input.text },
      { tokens: generous.tokens, records: generous.records - 1 },
      { tokenizer: DEFAULT_TOKENIZER },
    );
    if (!door.ok) throw new Error(`Runtime door refused: ${door.code}`);
    const project = (entry: {
      address: string;
      identity: string;
      kind: string;
      text: string;
      citations: unknown;
      severity?: string;
    }) => ({
      address: entry.address,
      identity: entry.identity,
      kind: entry.kind,
      text: entry.text,
      citations: entry.citations,
      severity: entry.severity,
    });
    expect(payload.context.included.map(project)).toEqual(door.packet.included.map(project));
    const steps = door.packet.included.map((entry) => entry.step);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBeGreaterThan(1);
    expect(
      door.packet.included.filter((entry) => entry.severity === 'blocking').map((entry) => entry.identity),
    ).toContain(law);
    expect(payload.context.omitted).toEqual(
      (['budget', 'disqualified', 'unresolved'] as const)
        .map((reason) => ({ reason, count: door.packet.omitted.filter((row) => row.reason === reason).length }))
        .filter((row) => row.count > 0),
    );
    expect(
      payload.context.followed.map((edge: { from: string; predicate: string; to: string }) => [
        edge.from,
        edge.predicate,
        edge.to,
      ]),
    ).toEqual(door.packet.followed.map((edge) => [edge.from, edge.predicate, edge.to]));
    expect(Object.keys(payload.pins).sort()).toEqual(keys);
    expect(payload.pins).toEqual({ ...pins(), profile: selected.digest });
  });

  it('never delivers or reveals a record outside the view scope', () => {
    const narrow = JSON.stringify(delivered(ask([method, law]))),
      broad = delivered({ ...ask(null), budgets: generous });
    const hidden = [
      ...new Set<string>(broad.context.included.map((entry: { identity: string }) => entry.identity)),
    ].filter((identity) => identity !== method && identity !== law);
    expect(hidden.length).toBeGreaterThan(0);
    for (const identity of hidden) expect(narrow).not.toContain(identity);
  });

  it('refuses missing required material, stale pins, an incomplete coordinate and changed text with exact diagnostics', async () => {
    expect(() =>
      prepareScopedContextSegments({
        ...ask([method, law]),
        requiredParts: (input) => ({ ...required(input), missing: [{ id: 'guide', reason: 'unavailable' }] }),
      }),
    ).toThrow(refused('IA-LIFECYCLE-REQUIRED', 'Required authoring context is unavailable'));
    expect(() =>
      prepareScopedContextSegments({
        ...ask([method, law]),
        pins: { ...pins(digest('stale')), profile: selected.digest },
      }),
    ).toThrow(refused('IA-LIFECYCLE-STALE', 'Lifecycle view/profile pins differ'));
    expect(() =>
      prepareScopedContextSegments({
        ...ask([method, law]),
        requiredParts: (input) => ({ ...required(input), pins: { ...input.pins, resources: digest('stale') } }),
      }),
    ).toThrow(refused('IA-LIFECYCLE-STALE', 'Required context pins differ'));
    expect(() => prepareScopedContextSegments({ ...ask([method, law]), coordinate: { phase: 'orient' } })).toThrow(
      refused('IA-LIFECYCLE-COORDINATE', 'Lifecycle context requires explicit phase and primitive coordinates'),
    );
    expect(() =>
      prepareScopedContextSegments({ ...ask([method, law]), text: 'Content changed outside its event' }),
    ).toThrow(refused('IA-LIFECYCLE-INPUT', 'Lifecycle selection text differs from its event input'));
    const input = ask([method, law]),
      close = vi.fn(),
      binding = {
        profile: selected,
        coordinate,
        bootstrap: 'Bootstrap',
        budgets,
        binding: input.pins.binding,
        policy: input.pins.policy,
        implementation: input.pins.implementation,
      };
    await expect(
      prepareLifecycleContextSegments(binding, input.event, {
        openCurrentView: async () => ({ ...input, pins: { ...input.pins, policy: digest('other-policy') }, close }),
        assertCurrent: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'IA-LIFECYCLE-STALE', message: 'Current lifecycle binding pins differ' });
    const view = { ...input, close };
    await expect(
      prepareLifecycleContextSegments(binding, input.event, {
        openCurrentView: async () => view,
        assertCurrent: async () => {
          view.pins = { ...view.pins, resources: digest('other-resources') };
        },
      }),
    ).rejects.toMatchObject({
      code: 'IA-LIFECYCLE-STALE',
      message: 'Lifecycle view binding changed during a host callback',
    });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('delivers at the exact minimum serialized byte size and refuses one byte less', () => {
    for (const [identities, refusal] of [
      [
        [method, law],
        refused('IA-LIFECYCLE-CONTEXT', 'Lifecycle context unavailable: IA-GRAPH-BUDGET-BLOCKING-OVERFLOW'),
      ],
      [
        [method],
        refused('IA-LIFECYCLE-BUDGET', 'Required context and complete host wrapper exceed the delivery budget'),
      ],
    ] as const) {
      const bytes = minimum(identities, 'bytes');
      expect(prepareScopedContextSegments({ ...ask(identities), budgets: { ...budgets, bytes } }).usage.bytes).toBe(
        bytes,
      );
      expect(() =>
        prepareScopedContextSegments({ ...ask(identities), budgets: { ...budgets, bytes: bytes - 1 } }),
      ).toThrow(refusal);
    }
  });

  it('delivers at the exact minimum serialized token count and refuses one token less', () => {
    for (const [identities, refusal] of [
      [
        [method, law],
        refused('IA-LIFECYCLE-CONTEXT', 'Lifecycle context unavailable: IA-GRAPH-BUDGET-BLOCKING-OVERFLOW'),
      ],
      [
        [method],
        refused('IA-LIFECYCLE-BUDGET', 'Required context and complete host wrapper exceed the delivery budget'),
      ],
    ] as const) {
      const tokens = minimum(identities, 'tokens');
      expect(prepareScopedContextSegments({ ...ask(identities), budgets: { ...budgets, tokens } }).usage.tokens).toBe(
        tokens,
      );
      expect(() =>
        prepareScopedContextSegments({ ...ask(identities), budgets: { ...budgets, tokens: tokens - 1 } }),
      ).toThrow(refusal);
    }
  });

  it('bounds required parts and blocking governance by the record budget on both sides', () => {
    expect(prepareScopedContextSegments({ ...ask([method]), budgets: { ...budgets, records: 1 } }).usage.records).toBe(
      1,
    );
    expect(() => prepareScopedContextSegments({ ...ask([method]), budgets: { ...budgets, records: 0 } })).toThrow(
      refused('IA-LIFECYCLE-BUDGET', 'Required context exceeds record budget'),
    );
    expect(
      prepareScopedContextSegments({ ...ask([method, law]), budgets: { ...budgets, records: 2 } }).usage.records,
    ).toBe(2);
    expect(() => prepareScopedContextSegments({ ...ask([method, law]), budgets: { ...budgets, records: 1 } })).toThrow(
      refused('IA-LIFECYCLE-CONTEXT', 'Lifecycle context unavailable: IA-GRAPH-BUDGET-BLOCKING-OVERFLOW'),
    );
  });

  it('admits exactly 1 MiB of required material to delivery and refuses one byte more before delivery', () => {
    const sized =
      (bytes: number) =>
      (input: { pins: LifecyclePins }): RequiredContextParts => ({
        ...required(input),
        parts: [
          {
            id: 'sized-guide',
            text: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(['exact-guide']))),
            citations: ['exact-guide'],
          },
        ],
      });
    expect(() => prepareScopedContextSegments({ ...ask([method]), requiredParts: sized(1024 * 1024) })).toThrow(
      refused('IA-LIFECYCLE-BUDGET', 'Required context and complete host wrapper exceed the delivery budget'),
    );
    expect(() => prepareScopedContextSegments({ ...ask([method]), requiredParts: sized(1024 * 1024 + 1) })).toThrow(
      refused('IA-LIFECYCLE-BUDGET', 'Required context exceeds its byte bound'),
    );
  });
});
