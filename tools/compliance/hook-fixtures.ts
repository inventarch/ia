import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

/**
 * One observed refusal per steward-hook code. The legacy guard's rows run the loop fixture; the `@mandate` guard's
 * (`--hook`, milestone generation-binding plan amendment C10) run the conformance corpus with apps/cli's composition
 * fixture laid over it, copied to a temporary workspace that is removed afterwards.
 */
export function runHookFixtures(root: string): readonly FixtureResult[] {
  const fixture = resolve(root, 'packages/compliance/fixtures/loop');
  const event = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: resolve(fixture, '.ia/src/systems/governance-system/records/new.ia') },
  };
  const composition = resolve(root, 'apps/cli/tests/fixtures/composition-workspace/.ia/src'),
    hook = 'hook-authoring-system/binding/hook/note-edits',
    created: string[] = [];
  /** The composition workspace, its hooks.ia's `from` replaced by `to` when given. */
  const mandated = (from?: string, to?: string): string => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'ia-hook-fixture-'));
    created.push(workspace);
    cpSync(resolve(root, 'examples/conformance/native'), resolve(workspace, '.ia/src'), { recursive: true });
    cpSync(composition, resolve(workspace, '.ia/src'), { recursive: true });
    if (from !== undefined && to !== undefined) {
      const path = resolve(workspace, '.ia/src/hooks.ia');
      writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
    }
    return workspace;
  };
  const docs = (workspace: string, extra: Record<string, unknown> = {}) => ({
    ...event,
    tool_input: { file_path: resolve(workspace, 'docs/guide.md') },
    ...extra,
  });
  try {
    const subagent = mandated(),
      malformed = mandated('moves [Synthesis]', 'moves []');
    const rows: readonly [string, unknown, readonly string[]][] = [
      ['IA-HOOK-INPUT-INVALID', {}, ['--root', fixture]],
      [
        'IA-HOOK-PATH-UNSAFE',
        { ...event, cwd: resolve(fixture, '..'), tool_input: { file_path: 'relative.ia' } },
        ['--root', fixture],
      ],
      [
        'IA-HOOK-STEWARD-UNAVAILABLE',
        { ...event, tool_input: { file_path: resolve(fixture, '.ia/src/systems/absent/new.ia') } },
        ['--root', fixture],
      ],
      ['IA-HOOK-IDENTITY-UNAVAILABLE', event, ['--root', fixture]],
      ['IA-HOOK-NOT-STEWARD', { ...event, agent_type: 'agent-steward' }, ['--root', fixture]],
      [
        'IA-HOOK-PROJECTION-MANAGED',
        { ...event, tool_input: { file_path: resolve(fixture, 'CLAUDE.md') } },
        ['--root', fixture],
      ],
      // The loop fixture authors no @hook, so a registration naming one cannot be decided.
      ['IA-HOOK-DECLARATION-UNAVAILABLE', event, ['--root', fixture, '--hook', hook]],
      // docs-mandate binds the demo participant, not the reviewer subagent.
      [
        'IA-HOOK-NOT-MANDATED',
        docs(subagent, { agent_id: 'fixture-subagent', agent_type: 'reviewer' }),
        ['--root', subagent, '--hook', hook],
      ],
      // A governing mandate that states an empty move list fails admission (compliance C05), and a @mandate that fails
      // admission fails every selected edit closed (lane D).
      ['IA-HOOK-MANDATE-UNAVAILABLE', docs(malformed), ['--root', malformed, '--hook', hook]],
    ];
    return rows.map(([expected, input, args]) => {
      const result = spawnSync(
        process.execPath,
        [resolve(root, 'apps/steward-hook/tests/fixtures/steward-write.mjs'), ...args],
        { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000, windowsHide: true },
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
  } finally {
    for (const workspace of created) {
      const path = relative(tmpdir(), workspace);
      if (isAbsolute(path) || !path.startsWith('ia-hook-fixture-') || path.includes('..'))
        throw new Error('Unsafe cleanup');
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}
