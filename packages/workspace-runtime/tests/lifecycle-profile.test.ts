import { describe, expect, it } from 'vitest';
import {
  LifecycleError,
  SELECTED_CLAUDE_CODE_VERSION,
  decodeLifecycleEvent,
  isSegmentedLifecycleProfile,
  lifecycleProfile,
  segmentedLifecycleRow,
} from '../src/lifecycle-profile.js';
import { UNFOLDED_CLAUDE_CODE_ROWS, claudeCodeRows, profileFromRows } from '../src/lifecycle-rows.js';
import { metadataDigest } from '../src/resource-format.js';

const profile = lifecycleProfile('claude-code', '2.1.278');
const selected = lifecycleProfile('claude-code', '2.1.285');
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

/** The closed refusal the decoder throws for one input under one row, by default the retained 2.1.278 row; a decoded input fails the test. */
function refusal(
  text: string,
  row: ReturnType<typeof lifecycleProfile> = profile,
): { readonly code: string; readonly message: string } {
  try {
    decodeLifecycleEvent(row, text);
  } catch (error) {
    if (error instanceof LifecycleError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('Expected a closed lifecycle refusal');
}
const json = (value: unknown): string => JSON.stringify(value);
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

// HOST-02 (private source history) Claude Code 2.1.285 payloads, constructed from docs and binary inspection; the HOST-06 case
// at the end of this file holds captured ones. Field sets follow the hooks reference fetched 2026-09-30 and the 2.1.285 emitter read
// in the HOST-02 grounding (section 2.3). Values are placeholders: the decoder opens no path and keeps no metadata value.
const session285 = {
  session_id: '8f14e45f-ceea-467f-a0e6-4b1c2d3e5f60',
  transcript_path: '/home/user/.claude/projects/-fixed-project/8f14e45f-ceea-467f-a0e6-4b1c2d3e5f60.jsonl',
  cwd: '/fixed/project',
  scratchpad_dir: '/tmp/claude-1000/-fixed-project/8f14e45f-ceea-467f-a0e6-4b1c2d3e5f60/scratchpad',
};
const start285 = { ...session285, hook_event_name: 'SessionStart' };
const stale285 = {
  seconds_since_last_response: 5400,
  context_tokens: 182340,
  prompt_cache_likely_expired: true,
  estimated_cache_write_usd: 1.1396,
};
const prompt285 = {
  ...session285,
  prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'Author a native procedure',
};
const lastPrompt = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const positive285: [string, Record<string, unknown>][] = [
  ['SessionStart startup', { ...start285, source: 'startup', model: 'claude-opus-5' }],
  [
    'SessionStart startup under --agent',
    { ...start285, source: 'startup', model: 'claude-opus-5', agent_type: 'security-reviewer' },
  ],
  [
    'SessionStart resume of a titled session',
    { ...start285, source: 'resume', model: 'claude-opus-5', session_title: 'ia work', ...stale285 },
  ],
  ['SessionStart clear without a model', { ...start285, prompt_id: lastPrompt, source: 'clear' }],
  ['SessionStart compact', { ...start285, prompt_id: lastPrompt, source: 'compact', model: 'claude-opus-5' }],
  ['SessionStart fork', { ...start285, source: 'fork', model: 'claude-opus-5', ...stale285 }],
  ['UserPromptSubmit in an untitled session', prompt285],
  ['UserPromptSubmit under --agent', { ...prompt285, agent_type: 'security-reviewer' }],
];

// HOST-02 (private source history) review M2: the inclusive side of each decoder text bound. Each row sets one field of the
// constructed 2.1.285 prompt payload above exactly at its bound (the payloads HOST-06 captured are at the end of this file);
// the malformed table below refuses one byte past each upper bound, and only the prompt may be empty.
const inclusive285: [string, 'session_id' | 'transcript_path' | 'prompt', number, string][] = [
  ['a 256-byte session_id', 'session_id', 256, 's'.repeat(256)],
  ['a 4,096-byte transcript_path', 'transcript_path', 4096, '/' + 'x'.repeat(4095)],
  ['a prompt of exactly 256 KiB', 'prompt', 256 * 1024, 'x'.repeat(256 * 1024)],
  ['an empty prompt', 'prompt', 0, ''],
];

describe('Claude Code 2.1.285 payloads against the 2.1.278 decoder (HOST-02)', () => {
  it.each(positive285)(
    'decodes the constructed %s payload and keeps host metadata out of the event',
    (_name, fields) => {
      const start = fields['hook_event_name'] === 'SessionStart';
      expect(decodeLifecycleEvent(profile, json(fields))).toEqual({
        format: 'ia.lifecycle-event.v1',
        profile: profile.digest,
        host: 'claude-code',
        kind: start ? 'start' : 'prompt',
        source: start ? fields['source'] : null,
        session: session285.session_id,
        agent: null,
        cwd: '/fixed/project',
        promptId: fields['prompt_id'] ?? null,
        prompt: start ? null : fields['prompt'],
        key: start ? null : expect.stringMatching(/^[a-f0-9]{64}$/),
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        delivery: 'unconfirmed',
      });
    },
  );

  it.each(inclusive285)(
    'decodes a UserPromptSubmit with %s, the inclusive side of its bound',
    (_name, field, bytes, value) => {
      expect(Buffer.byteLength(value)).toBe(bytes);
      const fields = { ...prompt285, [field]: value },
        event = decodeLifecycleEvent(profile, json(fields));
      expect(event).toMatchObject({ kind: 'prompt', session: fields.session_id, prompt: fields.prompt });
      expect(event.prompt).toHaveLength(fields.prompt.length);
    },
  );

  // HOST-03 (private source history) flipped this HOST-02 characterization under H3-v1 (G-H3 #415, `@decision parallel-g-h3`). The
  // selected claude-code@2.1.285 row accepts the documented optional session_title on UserPromptSubmit: it is validated, kept
  // out of the decoded event and the retriable key, and enters only the inputDigest. The retained 2.1.278 row still refuses it.
  it('accepts session_title on a 2.1.285 UserPromptSubmit and keeps refusing it on the retained 2.1.278 row', () => {
    const titled = json({ ...prompt285, session_title: 'ia work' }),
      event = decodeLifecycleEvent(selected, titled),
      untitled = decodeLifecycleEvent(selected, json(prompt285));
    expect(event).toMatchObject({
      profile: selected.digest,
      kind: 'prompt',
      prompt: prompt285.prompt,
      promptId: prompt285.prompt_id,
    });
    expect(Object.values(event)).not.toContain('ia work');
    expect(event.key).toBe(untitled.key);
    expect(event.inputDigest).not.toBe(untitled.inputDigest);
    expect(refusal(titled)).toEqual({ code: 'IA-LIFECYCLE-INPUT', message: 'Unknown or non-data lifecycle field' });
    expect(decodeLifecycleEvent(profile, json({ ...start285, source: 'resume', session_title: 'ia work' })).kind).toBe(
      'start',
    );
  });
});

// Every other event in the hooks reference fetched 2026-09-30: its 33 documented events minus SessionStart and
// UserPromptSubmit. Each input is the reference's own example; PreToolUse uses its common-input example, and PostModelSwitch,
// which has none, is the PreModelSwitch example with the documented resume source.
const documented = {
  session_id: 'abc123',
  transcript_path: '/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl',
  cwd: '/Users/...',
};
const modelSwitch = {
  ...documented,
  from_model: 'claude-sonnet-5',
  to_model: 'claude-opus-5',
  requested_model: 'opus',
  source: 'command',
  context_tokens: 182340,
  prompt_cache_warm: true,
  cache_ttl: '5m',
  estimated_cache_write_usd: 1.1396,
  pricing: 'catalog',
};
const unsupported: [string, Record<string, unknown>][] = [
  ['Setup', { ...documented, hook_event_name: 'Setup', trigger: 'init' }],
  [
    'InstructionsLoaded',
    {
      ...documented,
      hook_event_name: 'InstructionsLoaded',
      file_path: '/Users/my-project/CLAUDE.md',
      memory_type: 'Project',
      load_reason: 'session_start',
    },
  ],
  [
    'UserPromptExpansion',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'example-skill',
      command_args: 'arg1 arg2',
      command_source: 'plugin',
      prompt: '/example-skill arg1 arg2',
    },
  ],
  [
    'MessageDisplay',
    {
      ...documented,
      hook_event_name: 'MessageDisplay',
      turn_id: '0c9e6a2f-7d41-4f4e-9a15-3f4f7c2b8d10',
      message_id: '5b2a9c8e-1f63-4d8a-b7c4-9e0d2a6f1c3b',
      index: 0,
      final: false,
      delta: 'Here is the plan:\n',
    },
  ],
  [
    'PreToolUse',
    {
      ...documented,
      prompt_id: '550e8400-e29b-41d4-a716-446655440000',
      scratchpad_dir: '/tmp/claude-1000/-home-user-my-project/abc123/scratchpad',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'Run test suite', timeout: 120000, run_in_background: false },
      tool_use_id: 'toolu_01ABC123...',
    },
  ],
  [
    'PermissionRequest',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules directory' },
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    },
  ],
  [
    'PostToolUse',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/path/to/file.txt', content: 'file content' },
      tool_response: { filePath: '/path/to/file.txt', type: 'create' },
      tool_use_id: 'toolu_01ABC123...',
      duration_ms: 12,
    },
  ],
  [
    'PostToolUseFailure',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test', description: 'Run test suite' },
      tool_use_id: 'toolu_01ABC123...',
      error: "Exit code 1\nError: Cannot find module 'express'",
      is_interrupt: false,
      duration_ms: 4187,
    },
  ],
  [
    'PostToolBatch',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'PostToolBatch',
      tool_calls: [
        {
          tool_name: 'Read',
          tool_input: { file_path: '/.../ledger/accounts.py' },
          tool_use_id: 'toolu_01...',
          tool_response: '1\tfrom __future__ import annotations\n2\t...',
        },
      ],
    },
  ],
  [
    'PermissionDenied',
    {
      ...documented,
      permission_mode: 'auto',
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/build', description: 'Clean build directory' },
      tool_use_id: 'toolu_01ABC123...',
      reason: '[Irreversible Local Destruction]',
    },
  ],
  [
    'Notification',
    {
      ...documented,
      hook_event_name: 'Notification',
      message: 'Claude needs your permission',
      title: 'Permission needed',
      notification_type: 'permission_prompt',
    },
  ],
  [
    'SubagentStart',
    { ...documented, hook_event_name: 'SubagentStart', agent_id: 'agent-abc123', agent_type: 'Explore' },
  ],
  [
    'SubagentStop',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'def456',
      agent_type: 'Explore',
      agent_transcript_path: '~/.claude/projects/.../abc123/subagents/agent-def456.jsonl',
      last_assistant_message: 'Analysis complete. Found 3 potential issues...',
      background_tasks: [],
      session_crons: [],
    },
  ],
  [
    'TaskCreated',
    {
      ...documented,
      hook_event_name: 'TaskCreated',
      task_id: 'task-001',
      task_subject: 'Implement user authentication',
      task_description: 'Add login and signup endpoints',
      teammate_name: 'implementer',
      team_name: 'session-a1b2c3d4',
    },
  ],
  [
    'TaskCompleted',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'TaskCompleted',
      task_id: 'task-001',
      task_subject: 'Implement user authentication',
      task_description: 'Add login and signup endpoints',
      teammate_name: 'implementer',
      team_name: 'session-a1b2c3d4',
    },
  ],
  [
    'Stop',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'Stop',
      stop_hook_active: true,
      last_assistant_message: "I've completed the refactoring. Here's a summary...",
      background_tasks: [],
      session_crons: [],
    },
  ],
  [
    'StopFailure',
    {
      ...documented,
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      error_details: '429 Too Many Requests',
      last_assistant_message: 'API Error: Rate limit reached',
    },
  ],
  [
    'TeammateIdle',
    {
      ...documented,
      permission_mode: 'default',
      hook_event_name: 'TeammateIdle',
      teammate_name: 'researcher',
      team_name: 'session-a1b2c3d4',
    },
  ],
  [
    'ConfigChange',
    {
      ...documented,
      hook_event_name: 'ConfigChange',
      source: 'project_settings',
      file_path: '/Users/.../my-project/.claude/settings.json',
    },
  ],
  [
    'CwdChanged',
    { ...documented, hook_event_name: 'CwdChanged', old_cwd: '/Users/my-project', new_cwd: '/Users/my-project/src' },
  ],
  [
    'DirectoryAdded',
    { ...documented, hook_event_name: 'DirectoryAdded', directory: '/Users/my-other-repo', source: 'slash_command' },
  ],
  [
    'FileChanged',
    { ...documented, hook_event_name: 'FileChanged', file_path: '/Users/my-project/.envrc', event: 'change' },
  ],
  ['WorktreeCreate', { ...documented, hook_event_name: 'WorktreeCreate', name: 'feature-auth' }],
  [
    'WorktreeRemove',
    {
      ...documented,
      hook_event_name: 'WorktreeRemove',
      worktree_path: '/Users/.../my-project/.claude/worktrees/feature-auth',
    },
  ],
  ['PreCompact', { ...documented, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }],
  [
    'PostCompact',
    {
      ...documented,
      hook_event_name: 'PostCompact',
      trigger: 'manual',
      compact_summary: 'Summary of the compacted conversation...',
    },
  ],
  ['PreModelSwitch', { ...modelSwitch, hook_event_name: 'PreModelSwitch' }],
  ['PostModelSwitch', { ...modelSwitch, hook_event_name: 'PostModelSwitch', source: 'resume' }],
  ['SessionEnd', { ...documented, hook_event_name: 'SessionEnd', reason: 'other' }],
  [
    'Elicitation',
    {
      ...documented,
      hook_event_name: 'Elicitation',
      mcp_server_name: 'my-mcp-server',
      message: 'Please provide your credentials',
      mode: 'form',
      requested_schema: { type: 'object', properties: { username: { type: 'string', title: 'Username' } } },
    },
  ],
  [
    'ElicitationResult',
    {
      ...documented,
      hook_event_name: 'ElicitationResult',
      mcp_server_name: 'my-mcp-server',
      action: 'accept',
      content: { username: 'alice' },
      mode: 'form',
      elicitation_id: 'elicit-123',
    },
  ],
];

describe('documented Claude Code events outside the profile (HOST-02)', () => {
  it.each(unsupported)('refuses the documented %s event at the event gate', (event, fields) => {
    expect(fields['hook_event_name']).toBe(event);
    expect(refusal(json(fields)).code).toBe('IA-LIFECYCLE-INPUT');
    expect(refusal(json({ ...session285, hook_event_name: event }))).toEqual({
      code: 'IA-LIFECYCLE-INPUT',
      message: 'Unsupported lifecycle event',
    });
  });

  it('names exactly two events and matches event names exactly', () => {
    expect(profile.events).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(new Set(unsupported.map(([event]) => event)).size).toBe(31);
    for (const event of ['sessionstart', 'USERPROMPTSUBMIT', 'SessionStart ', 'FutureLifecycleEvent']) {
      expect(refusal(json({ ...start285, source: 'startup', hook_event_name: event }))).toEqual({
        code: 'IA-LIFECYCLE-INPUT',
        message: 'Unsupported lifecycle event',
      });
    }
  });
});

let nested: unknown = {};
for (let level = 0; level < 16; level++) nested = { level: nested };
const malformed: [string, string, string][] = [
  ['empty stdin', '', 'Lifecycle input is not bounded unambiguous JSON'],
  ['truncated JSON', json(prompt285).slice(0, -1), 'Lifecycle input is not bounded unambiguous JSON'],
  ['trailing data', json(prompt285) + '{}', 'Lifecycle input is not bounded unambiguous JSON'],
  ['a byte-order mark', '\uFEFF' + json(prompt285), 'Lifecycle input is not bounded unambiguous JSON'],
  [
    'nesting beyond 16 levels',
    json({ ...prompt285, effort: nested }),
    'Lifecycle input is not bounded unambiguous JSON',
  ],
  [
    'a raw lone surrogate',
    json(prompt285).replace('Author', '\ud800'),
    'Lifecycle input exceeds its byte bound or is invalid UTF-8',
  ],
  [
    'stdin over 1 MiB',
    json({ ...prompt285, prompt: 'x'.repeat(1024 * 1024) }),
    'Lifecycle input exceeds its byte bound or is invalid UTF-8',
  ],
  ['a top-level array', '[]', 'Expected lifecycle object'],
  ['a top-level string', '"Author a native procedure"', 'Expected lifecycle object'],
  ['a top-level number', '42', 'Expected lifecycle object'],
  ['a top-level null', 'null', 'Expected lifecycle object'],
  ['effort as text', json({ ...prompt285, effort: 'high' }), 'Expected lifecycle object'],
  ['a __proto__ key', '{"__proto__":{},' + json(prompt285).slice(1), 'Unknown or non-data lifecycle field'],
  ['a constructor key', '{"constructor":"Object",' + json(prompt285).slice(1), 'Unknown or non-data lifecycle field'],
  [
    'the prompt source field the 2.1.285 SDK typing announces',
    json({ ...prompt285, source: 'user' }),
    'Unknown or non-data lifecycle field',
  ],
  ['served_call', json({ ...prompt285, served_call: true }), 'Unknown or non-data lifecycle field'],
  ['caller_session_id', json({ ...prompt285, caller_session_id: 'caller' }), 'Unknown or non-data lifecycle field'],
  [
    'a prompt on SessionStart',
    json({ ...start285, source: 'startup', prompt: 'Author a native procedure' }),
    'Unknown or non-data lifecycle field',
  ],
  [
    'a model on UserPromptSubmit',
    json({ ...prompt285, model: 'claude-opus-5' }),
    'Unknown or non-data lifecycle field',
  ],
  ['staleness on UserPromptSubmit', json({ ...prompt285, ...stale285 }), 'Unknown or non-data lifecycle field'],
  ['a missing hook_event_name', json(without(prompt285, 'hook_event_name')), 'Invalid or oversized lifecycle text'],
  ['a missing session_id', json(without(prompt285, 'session_id')), 'Invalid or oversized lifecycle text'],
  ['a missing cwd', json(without(prompt285, 'cwd')), 'Invalid or oversized lifecycle text'],
  ['a missing SessionStart source', json(start285), 'Invalid or oversized lifecycle text'],
  ['a numeric session_id', json({ ...prompt285, session_id: 1 }), 'Invalid or oversized lifecycle text'],
  ['a null cwd', json({ ...prompt285, cwd: null }), 'Invalid or oversized lifecycle text'],
  ['a numeric prompt', json({ ...prompt285, prompt: 42 }), 'Invalid or oversized lifecycle text'],
  ['a NUL in cwd', json({ ...prompt285, cwd: '/fixed/\u0000project' }), 'Invalid or oversized lifecycle text'],
  ['an escaped lone surrogate', json({ ...prompt285, prompt: 'Author \ud800' }), 'Invalid or oversized lifecycle text'],
  [
    'a session_id over 256 bytes',
    json({ ...prompt285, session_id: 's'.repeat(257) }),
    'Invalid or oversized lifecycle text',
  ],
  [
    'a transcript_path over 4096 bytes',
    json({ ...prompt285, transcript_path: '/' + 'x'.repeat(4096) }),
    'Invalid or oversized lifecycle text',
  ],
  [
    'a prompt over 256 KiB',
    json({ ...prompt285, prompt: 'x'.repeat(256 * 1024 + 1) }),
    'Invalid or oversized lifecycle text',
  ],
  ['an unknown SessionStart source', json({ ...start285, source: 'reload' }), 'Unsupported SessionStart source'],
  [
    'a differently cased SessionStart source',
    json({ ...start285, source: 'Startup' }),
    'Unsupported SessionStart source',
  ],
  [
    'the manual permission mode name',
    json({ ...prompt285, permission_mode: 'manual' }),
    'Unknown permission mode metadata',
  ],
  ['an unknown effort level', json({ ...prompt285, effort: { level: 'ultra' } }), 'Unknown effort metadata'],
  [
    'negative staleness',
    json({ ...start285, source: 'resume', ...stale285, seconds_since_last_response: -1 }),
    'Invalid cost metadata',
  ],
  [
    'fractional context_tokens',
    json({ ...start285, source: 'resume', ...stale285, context_tokens: 1.5 }),
    'Invalid cost metadata',
  ],
  [
    'a null cost, as a NaN estimate serializes',
    json({ ...start285, source: 'resume', ...stale285, estimated_cache_write_usd: null }),
    'Invalid cost metadata',
  ],
  [
    'an overflowing staleness number',
    json({ ...start285, source: 'resume', ...stale285 }).replace(
      '"seconds_since_last_response":5400',
      '"seconds_since_last_response":1e400',
    ),
    'Invalid cost metadata',
  ],
  [
    'a textual cache flag',
    json({ ...start285, source: 'resume', ...stale285, prompt_cache_likely_expired: 'true' }),
    'Invalid cache metadata',
  ],
];

describe('malformed Claude Code lifecycle input (HOST-02)', () => {
  it.each(malformed)('refuses %s with a closed input diagnostic', (_name, text, message) => {
    expect(refusal(text)).toEqual({ code: 'IA-LIFECYCLE-INPUT', message });
  });
});

// HOST-03 (private source history): H3-v1 (G-H3 #415, `@decision parallel-g-h3`) selects claude-code@2.1.285 exactly. The HOST-02
// tables above stay on the retained 2.1.278 row; here the same constructed payloads (the HOST-06 case at the end of this
// file holds captured ones) run against the selected row, which keeps every closed refusal and adds only the optional prompt session_title.
describe('the selected claude-code@2.1.285 row (HOST-03)', () => {
  it('makes exactly 2.1.278 and 2.1.285 available and infers no version range', () => {
    expect(SELECTED_CLAUDE_CODE_VERSION).toBe('2.1.285');
    expect(selected.version).toBe(SELECTED_CLAUDE_CODE_VERSION);
    for (const row of [profile, selected])
      expect(row).toMatchObject({
        format: 'ia.lifecycle-profile.v1',
        host: 'claude-code',
        available: true,
        reason: null,
        events: ['SessionStart', 'UserPromptSubmit'],
        maxContextCharacters: 10_000,
        maxContextParts: 12,
        maxInputBytes: 1024 * 1024,
        maxPromptBytes: 256 * 1024,
      });
    for (const version of ['2.1.277', '2.1.279', '2.1.284', '2.1.286', '2.1.2850', '2.1', ' 2.1.285', 'v2.1.285'])
      expect(lifecycleProfile('claude-code', version)).toMatchObject({
        available: false,
        events: [],
        reason: 'This host version has no qualified lifecycle profile.',
      });
    expect(lifecycleProfile('codex', '2.1.285').available).toBe(false);
    expect(refusal(json(prompt285), lifecycleProfile('claude-code', '2.1.286'))).toEqual({
      code: 'IA-LIFECYCLE-UNAVAILABLE',
      message: 'This host version has no qualified lifecycle profile.',
    });
  });

  // #447 review (finding 3): the field tables of these two rows are not in their digested profile bodies, and retained
  // bindings, the HOST-06 live evidence and `@decision parallel-g-h3` pin their digests. This one case pins both digests, both
  // field tables and the closed set of unfolded rows; every row added from here folds its table into its digest (below).
  it('keeps the claude-code@2.1.278 and 2.1.285 rows byte-identical and pins their unfolded field tables', () => {
    expect(profile.digest).toBe('911d05a7fbf511e2de10a26dc573092b1cc99a1082f239e3b51aa7a6a9df4733');
    expect(selected.digest).toBe('b25a5786a27e21e6b81449739d114d66be7c77ac9339c058919402111c8525b2');
    const { version: _retainedVersion, digest: _retainedDigest, ...retained } = profile,
      { version: _selectedVersion, digest: _selectedDigest, ...current } = selected;
    expect(current).toEqual(retained);
    expect(selected.digest).not.toBe(profile.digest);
    expect(claudeCodeRows.get('2.1.278')).toEqual(['prompt']);
    expect(claudeCodeRows.get('2.1.285')).toEqual(['prompt', 'session_title']);
    expect([...UNFOLDED_CLAUDE_CODE_ROWS]).toEqual(['2.1.278', '2.1.285']);
    for (const row of [profile, selected]) expect(Object.keys(row)).not.toContain('promptFields');
  });

  it.each(positive285)('decodes the constructed %s payload under the selected row', (_name, fields) => {
    const start = fields['hook_event_name'] === 'SessionStart';
    expect(decodeLifecycleEvent(selected, json(fields))).toEqual({
      format: 'ia.lifecycle-event.v1',
      profile: selected.digest,
      host: 'claude-code',
      kind: start ? 'start' : 'prompt',
      source: start ? fields['source'] : null,
      session: session285.session_id,
      agent: null,
      cwd: '/fixed/project',
      promptId: fields['prompt_id'] ?? null,
      prompt: start ? null : fields['prompt'],
      key: start ? null : expect.stringMatching(/^[a-f0-9]{64}$/),
      inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      delivery: 'unconfirmed',
    });
  });

  it.each(inclusive285)('decodes a UserPromptSubmit with %s under the selected row', (_name, field, bytes, value) => {
    expect(Buffer.byteLength(value)).toBe(bytes);
    expect(decodeLifecycleEvent(selected, json({ ...prompt285, [field]: value }))).toMatchObject({
      profile: selected.digest,
      kind: 'prompt',
    });
  });

  it.each(unsupported)(
    'refuses the documented %s event under the selected row with its exact closed diagnostic',
    (event, fields) => {
      // Only SubagentStart's example carries no field outside the closed union, so only it reaches the event gate.
      expect(refusal(json(fields), selected)).toEqual({
        code: 'IA-LIFECYCLE-INPUT',
        message: event === 'SubagentStart' ? 'Unsupported lifecycle event' : 'Unknown or non-data lifecycle field',
      });
      expect(refusal(json({ ...session285, hook_event_name: event }), selected)).toEqual({
        code: 'IA-LIFECYCLE-INPUT',
        message: 'Unsupported lifecycle event',
      });
    },
  );

  it.each(malformed)('refuses %s under the selected row with the same closed diagnostic', (_name, text, message) => {
    expect(refusal(text, selected)).toEqual({ code: 'IA-LIFECYCLE-INPUT', message });
  });

  it('bounds and types the prompt session_title as host metadata kept out of the event', () => {
    for (const session_title of ['t', 't'.repeat(4096)])
      expect(decodeLifecycleEvent(selected, json({ ...prompt285, session_title })).kind).toBe('prompt');
    for (const session_title of ['', 't'.repeat(4097), 42, null, 'nul\u0000title', ['ia work'], { title: 'ia work' }]) {
      expect(refusal(json({ ...prompt285, session_title }), selected)).toEqual({
        code: 'IA-LIFECYCLE-INPUT',
        message: 'Invalid or oversized lifecycle text',
      });
    }
  });
});

// HOST-04 (private source history), from the HOST-03 review (m8): each Claude Code row is keyed by its literal version, so a
// re-pin of SELECTED_CLAUDE_CODE_VERSION that adds no row fails here instead of silently moving the row that retained
// bindings pin.
describe('the selected Claude Code version (HOST-04)', () => {
  it('names an available row, whatever its value', () => {
    expect(lifecycleProfile('claude-code', SELECTED_CLAUDE_CODE_VERSION)).toMatchObject({
      host: 'claude-code',
      version: SELECTED_CLAUDE_CODE_VERSION,
      available: true,
      reason: null,
      events: ['SessionStart', 'UserPromptSubmit'],
    });
  });
});

// #447 review (findings 3 and 6). 2.1.300 stands for any Claude Code row added from here: it is not installed, so the
// cases build it through the internal profileFromRows seam over the installed table plus that one row.
const withRow = (fields: readonly string[]): ReadonlyMap<string, readonly string[]> =>
  new Map<string, readonly string[]>([...claudeCodeRows, ['2.1.300', fields]]);
describe('profile row field tables and segmented digests (#447 review)', () => {
  /** Other profiles, a row that is not installed, altered digest strings and non-strings. */
  const unsegmented: unknown[] = [
    lifecycleProfile('ia-native', '1').digest,
    lifecycleProfile('claude-code', '2.1.286').digest,
    lifecycleProfile('codex', '0.116.0').digest,
    profileFromRows(withRow(['prompt']), 'claude-code', '2.1.300').digest,
    profile.digest.toUpperCase(),
    ` ${selected.digest}`,
    '',
    null,
    undefined,
    42,
    [profile.digest],
    { digest: profile.digest },
  ];
  it('folds the field table of a row added from here into its digested body and leaves the two unfolded rows unchanged', () => {
    const added = profileFromRows(withRow(['prompt']), 'claude-code', '2.1.300'),
      edited = profileFromRows(withRow(['prompt', 'session_title']), 'claude-code', '2.1.300');
    expect(added).toMatchObject({
      host: 'claude-code',
      version: '2.1.300',
      available: true,
      reason: null,
      promptFields: ['prompt'],
    });
    expect(edited.promptFields).toEqual(['prompt', 'session_title']);
    expect(edited.digest).not.toBe(added.digest);
    const { digest, ...body } = edited;
    expect(digest).toBe(metadataDigest(body));
    for (const version of ['2.1.278', '2.1.285'])
      expect(profileFromRows(withRow(['prompt']), 'claude-code', version)).toEqual(
        lifecycleProfile('claude-code', version),
      );
  });

  it('treats exactly the digests of the two installed Claude Code rows as segmented', () => {
    expect([isSegmentedLifecycleProfile(profile.digest), isSegmentedLifecycleProfile(selected.digest)]).toEqual([
      true,
      true,
    ]);
    for (const value of unsegmented) expect(isSegmentedLifecycleProfile(value), String(value)).toBe(false);
  });

  it('names the installed row a segmented digest belongs to and answers null for every other value', () => {
    expect(segmentedLifecycleRow(profile.digest)).toEqual({ host: 'claude-code', version: '2.1.278' });
    expect(segmentedLifecycleRow(selected.digest)).toEqual({ host: 'claude-code', version: '2.1.285' });
    expect(Object.isFrozen(segmentedLifecycleRow(profile.digest))).toBe(true);
    for (const value of unsegmented) expect(segmentedLifecycleRow(value), String(value)).toBeNull();
  });
});

/** Payloads the pinned claude-code 2.1.285 host sent to a capture hook beside the IA slots in the HOST-06 live run, byte for byte. */
const captured285: readonly [string, string][] = [
  [
    'SessionStart startup',
    '{"session_id":"290a5132-9b73-4b2b-925e-b59c3bae03cb","transcript_path":"/private/tmp/ia-host06.1AJquJ/live/config/projects/-private-tmp-ia-host06-1AJquJ-live-ws/290a5132-9b73-4b2b-925e-b59c3bae03cb.jsonl","cwd":"/private/tmp/ia-host06.1AJquJ/live/ws","hook_event_name":"SessionStart","source":"startup"}\n',
  ],
  [
    'UserPromptSubmit',
    '{"session_id":"290a5132-9b73-4b2b-925e-b59c3bae03cb","transcript_path":"/private/tmp/ia-host06.1AJquJ/live/config/projects/-private-tmp-ia-host06-1AJquJ-live-ws/290a5132-9b73-4b2b-925e-b59c3bae03cb.jsonl","cwd":"/private/tmp/ia-host06.1AJquJ/live/ws","prompt_id":"20c0061d-a92b-4845-8225-8bf0acc5dc4e","permission_mode":"auto","hook_event_name":"UserPromptSubmit","prompt":"Orient on this workspace"}\n',
  ],
  [
    'SessionStart resume',
    '{"session_id":"290a5132-9b73-4b2b-925e-b59c3bae03cb","transcript_path":"/private/tmp/ia-host06.1AJquJ/live/config/projects/-private-tmp-ia-host06-1AJquJ-live-ws/290a5132-9b73-4b2b-925e-b59c3bae03cb.jsonl","cwd":"/private/tmp/ia-host06.1AJquJ/live/ws","hook_event_name":"SessionStart","source":"resume","seconds_since_last_response":0,"context_tokens":3,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0}\n',
  ],
  [
    'SessionStart compact',
    '{"session_id":"290a5132-9b73-4b2b-925e-b59c3bae03cb","transcript_path":"/private/tmp/ia-host06.1AJquJ/live/config/projects/-private-tmp-ia-host06-1AJquJ-live-ws/290a5132-9b73-4b2b-925e-b59c3bae03cb.jsonl","cwd":"/private/tmp/ia-host06.1AJquJ/live/ws","prompt_id":"b4815eb7-0745-434a-8ffe-da92f8f4ea5f","hook_event_name":"SessionStart","source":"compact","model":"claude-opus-5-5"}\n',
  ],
  [
    'SessionStart fork',
    '{"session_id":"0110bd04-ca70-4d2a-ae59-7eddfd99178c","transcript_path":"/private/tmp/ia-host06.1AJquJ/live/config/projects/-private-tmp-ia-host06-1AJquJ-live-ws/0110bd04-ca70-4d2a-ae59-7eddfd99178c.jsonl","cwd":"/private/tmp/ia-host06.1AJquJ/live/ws","hook_event_name":"SessionStart","source":"fork","seconds_since_last_response":31,"context_tokens":3,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0}\n',
  ],
  [
    'SessionStart clear',
    '{"session_id":"77c86c4d-f74d-401b-918d-880d36be058f","transcript_path":"/private/tmp/ia-host06.1AJquJ/live/config/projects/-private-tmp-ia-host06-1AJquJ-live-ws/77c86c4d-f74d-401b-918d-880d36be058f.jsonl","cwd":"/private/tmp/ia-host06.1AJquJ/live/ws","hook_event_name":"SessionStart","source":"clear"}\n',
  ],
  [
    'titled SessionStart startup',
    '{"session_id":"a352bbfd-905f-4630-be9b-015e5c8fd29f","transcript_path":"/private/tmp/ia-host06.1AJquJ/live/config/projects/-private-tmp-ia-host06-1AJquJ-live-ws/a352bbfd-905f-4630-be9b-015e5c8fd29f.jsonl","cwd":"/private/tmp/ia-host06.1AJquJ/live/ws","hook_event_name":"SessionStart","source":"startup","session_title":"ia work"}\n',
  ],
  [
    'titled UserPromptSubmit',
    '{"session_id":"a352bbfd-905f-4630-be9b-015e5c8fd29f","transcript_path":"/private/tmp/ia-host06.1AJquJ/live/config/projects/-private-tmp-ia-host06-1AJquJ-live-ws/a352bbfd-905f-4630-be9b-015e5c8fd29f.jsonl","cwd":"/private/tmp/ia-host06.1AJquJ/live/ws","prompt_id":"8498167d-7959-4866-8f44-216924b461a9","permission_mode":"auto","hook_event_name":"UserPromptSubmit","prompt":"Orient on this workspace","session_title":"ia work"}\n',
  ],
];
describe('payloads captured from the pinned claude-code 2.1.285 host (HOST-06)', () => {
  it('decodes every captured payload on the selected row and refuses the titled prompt on the retained 2.1.278 row', () => {
    for (const [name, text] of captured285) {
      const row = JSON.parse(text) as Record<string, unknown>,
        start = row['hook_event_name'] === 'SessionStart';
      expect(decodeLifecycleEvent(selected, text), name).toMatchObject({
        kind: start ? 'start' : 'prompt',
        source: row['source'] ?? null,
        session: row['session_id'],
        cwd: row['cwd'],
        promptId: row['prompt_id'] ?? null,
        prompt: row['prompt'] ?? null,
      });
      expect(decodeLifecycleEvent(selected, text).key === null, name).toBe(start);
    }
    expect(() =>
      decodeLifecycleEvent(profile, captured285.find(([name]) => name === 'titled UserPromptSubmit')![1]),
    ).toThrow(expect.objectContaining({ code: 'IA-LIFECYCLE-INPUT', message: 'Unknown or non-data lifecycle field' }));
  });
});
