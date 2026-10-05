import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

export function runHookFixtures(root: string): readonly FixtureResult[] {
  const fixture = resolve(root, 'packages/compliance/fixtures/loop');
  const event = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: resolve(fixture, '.ia/src/systems/governance-system/records/new.ia') },
  };
  const rows: readonly [string, unknown][] = [
    ['IA-HOOK-INPUT-INVALID', {}],
    ['IA-HOOK-PATH-UNSAFE', { ...event, cwd: resolve(fixture, '..'), tool_input: { file_path: 'relative.ia' } }],
    [
      'IA-HOOK-STEWARD-UNAVAILABLE',
      { ...event, tool_input: { file_path: resolve(fixture, '.ia/src/systems/absent/new.ia') } },
    ],
    ['IA-HOOK-IDENTITY-UNAVAILABLE', event],
    ['IA-HOOK-NOT-STEWARD', { ...event, agent_type: 'agent-steward' }],
    ['IA-HOOK-PROJECTION-MANAGED', { ...event, tool_input: { file_path: resolve(fixture, 'CLAUDE.md') } }],
    [
      'IA-HOOK-SHELL-WRITE',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo x > .ia/src/systems/governance-system/records/new.ia' },
        cwd: fixture,
      },
    ],
    [
      'IA-HOOK-SHELL-UNRESOLVED',
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo "unterminated' }, cwd: fixture },
    ],
  ];
  return rows.map(([expected, input]) => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'apps/steward-hook/tests/fixtures/steward-write.mjs'), '--root', fixture],
      { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 },
    );
    let observedCodes: string[] = [];
    try {
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      if (result.status === 0 && result.stderr === '' && output.hookSpecificOutput?.permissionDecision === 'deny')
        observedCodes = [output.hookSpecificOutput.permissionDecisionReason?.split(':')[0] ?? ''];
    } catch {
      /* The failed oracle below retains malformed/missing adapter evidence. */
    }
    const findings: Finding[] = observedCodes.includes(expected)
      ? []
      : [
          {
            code: 'IA-COMP-FIXTURE-MISMATCH',
            severity: 'error',
            path: 'apps/steward-hook',
            line: 1,
            message: `${expected} hook fixture received ${result.status}: ${result.stdout} ${result.stderr}`,
          },
        ];
    return { assessment: assess('COMP-FIXTURES', `hook/${expected}`, findings), observedCodes };
  });
}
