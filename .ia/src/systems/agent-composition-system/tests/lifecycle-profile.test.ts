import { describe, expect, it } from 'vitest';
import { decodeLifecycleEvent, lifecycleProfile } from '../src/lifecycle-profile.js';

const profile = lifecycleProfile('claude-code', '2.1.278');
const input = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'host-session',
    cwd: '/fixed/project',
    transcript_path: '/private/never-read.jsonl',
    prompt: 'Implement the change',
    prompt_id: 'prompt-1',
    ...fields,
  });

describe('versioned lifecycle profile', () => {
  it('reads current Claude prompt fields and separates turns with repeated text', () => {
    const first = decodeLifecycleEvent(profile, input()),
      second = decodeLifecycleEvent(profile, input({ prompt_id: 'prompt-2' }));
    expect(first).toMatchObject({
      kind: 'prompt',
      prompt: 'Implement the change',
      session: 'host-session',
      delivery: 'unconfirmed',
    });
    expect(first.key).not.toBe(second.key);
    expect(first.inputDigest).not.toBe(second.inputDigest);
    expect(first).not.toHaveProperty('transcript_path');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('binds changed event content without confusing it with the retained event identity', () => {
    const first = decodeLifecycleEvent(profile, input()),
      changed = decodeLifecycleEvent(profile, input({ prompt: 'Different task' }));
    expect(first.key).toBe(changed.key);
    expect(first.inputDigest).not.toBe(changed.inputDigest);
    expect(decodeLifecycleEvent(profile, input({ prompt_id: undefined })).key).toBeNull();
  });

  it.each(['startup', 'resume', 'clear', 'compact', 'fork'])('always marks %s as fresh bootstrap', (source) => {
    const event = decodeLifecycleEvent(
      profile,
      JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'same',
        cwd: '/fixed',
        source,
        prompt_id: 'last-prompt',
      }),
    );
    expect(event).toMatchObject({ kind: 'start', source, key: null, prompt: null });
  });

  it('refuses unsupported installed Codex and unknown Claude versions', () => {
    expect(lifecycleProfile('codex', '0.116.0')).toMatchObject({ available: false });
    expect(() => decodeLifecycleEvent(lifecycleProfile('codex', '0.116.0'), input())).toThrow(/unavailable/i);
    expect(lifecycleProfile('claude-code', '2.1.277').available).toBe(false);
  });

  it.each([
    input({ user_prompt: 'obsolete' }),
    input({ root: '/foreign' }),
    input({ hook_event_name: 'PreCompact' }),
    input({ prompt: undefined }),
    input({ prompt: 'x'.repeat(256 * 1024 + 1) }),
    input({ prompt_id: '' }),
    '{"hook_event_name":"SessionStart","hook_event_name":"UserPromptSubmit"}',
  ])('refuses ambiguous, unbounded or unrecognized event input', (value) => {
    expect(() => decodeLifecycleEvent(profile, value)).toThrow();
  });
});
