import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { open } from '../../packages/db/src/index.js';
import { defaultActor, governingMandates, profileRefusal } from '../../packages/runtime/src/index.js';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

/**
 * The mandate resolver over a copy of the conformance corpus that adds two participants whose mandates scope the
 * foundation workspace, which states no composition.steward: `defaultActor` names neither, and the profile of the first
 * one's governing mandate refuses a move it does not list and a word it excludes; codes come only from execution.
 */
export function runActorFixtures(root: string): readonly FixtureResult[] {
  const workspace = mkdtempSync(resolve(tmpdir(), 'ia-actor-fixture-')),
    path = '.ia/src/actor-fixture.ia',
    foundation = 'workspace-system/definition/workspace/foundation-workspace',
    first = 'agent-system/binding/agent/actor-first';
  const pair = (name: string, authority: string): string =>
    `\n@agent ${name}\n  meaning\n    says "The ${name} fixture participant."\n    answers "Who is ${name}?"\n  governance\n    applies []\n\n@mandate ${name}-mandate\n  meaning\n    says "The ${name} fixture mandate."\n    answers "What may ${name} do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n    participant @agent ${name}\n    scope [@workspace foundation-workspace]\n${authority}`;
  try {
    cpSync(resolve(root, 'examples/conformance/native'), resolve(workspace, '.ia/src'), { recursive: true });
    writeFileSync(
      resolve(workspace, path),
      [
        '#! ia 1.0',
        pair('actor-first', '    moves [Observation]\n    excluded-words [hook]\n'),
        pair('actor-second', ''),
      ].join('\n'),
    );
    const handle = open(workspace, { cache: false });
    try {
      const within = handle.resolveScope().token,
        governing = () => governingMandates(handle, within, { actor: first, workspace: foundation });
      const fixtures = [
        {
          name: 'mandate-actor',
          expected: 'IA-RUNTIME-MANDATE-ACTOR',
          run: () => defaultActor(handle, within, foundation).refusal,
        },
        {
          name: 'profile-move',
          expected: 'IA-RUNTIME-MANDATE-MOVE',
          run: () => profileRefusal(governing(), 'author').refusal,
        },
        {
          name: 'profile-word',
          expected: 'IA-RUNTIME-MANDATE-WORD',
          run: () => profileRefusal(governing(), 'read', ['hook']).refusal,
        },
      ];
      return fixtures.map(({ name, expected, run }): FixtureResult => {
        const refusal = run(),
          observedCodes: readonly string[] = refusal === undefined ? [] : [refusal.code];
        const findings: Finding[] = observedCodes.includes(expected)
          ? []
          : [
              {
                code: 'IA-COMP-FIXTURE-MISMATCH',
                severity: 'error',
                path: 'packages/runtime/src/mandate-modes.ts',
                line: 1,
                message: `${name}: expected ${expected}, received ${refusal?.code ?? 'success'}`,
              },
            ];
        return { assessment: assess('COMP-FIXTURES', `runtime/${name}`, findings), observedCodes };
      });
    } finally {
      handle.close();
    }
  } finally {
    const created = relative(tmpdir(), workspace);
    if (isAbsolute(created) || !/^ia-actor-fixture-[\w-]+$/.test(created)) throw new Error('Unsafe cleanup');
    rmSync(workspace, { recursive: true, force: true });
  }
}
