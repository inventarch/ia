import '../temp/physical-temp.mjs';
import { createSystemFixture } from './fixture.js';
import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { open } from '../../packages/db/src/index.js';
import { execute, OPERATION_NAMES } from './execute.js';
import { field, text } from './shared.js';
import type { Result } from './types.js';

export interface ScenarioObservation {
  readonly identity: string;
  readonly operation: string;
  readonly expected: string;
  readonly observed: string;
  readonly pass: boolean;
  readonly result: Result;
}
export function runScenarios(root: string): {
  readonly ok: boolean;
  readonly observations: readonly ScenarioObservation[];
  readonly missing: readonly string[];
} {
  const db = open(root, { cache: false });
  try {
    const observations: ScenarioObservation[] = [];
    for (const record of db.records().filter((r) => r.discriminator === 'case')) {
      if (text(field(record, 'scenario', 'evaluator')) !== 'tools/systems/scenarios.ts') continue;
      const reference = field(record, 'scenario', 'operation');
      if (reference.kind !== 'ref' || reference.discriminator !== 'operation' || reference.fragment !== undefined)
        throw new Error(`Invalid scenario operation in ${record.identity}`);
      const expected = text(field(record, 'scenario', 'code')),
        input = JSON.parse(text(field(record, 'scenario', 'input'))) as unknown;
      const result = execute(root, reference.name, input),
        observed = result.ok ? 'pass' : result.code;
      const effectObserved = !result.ok || result.effects === 'read-only' || result.artifacts.length > 0;
      const kind = text(field(record, 'scenario', 'kind')),
        kindObserved = kind === 'success' ? result.ok : (kind === 'failure' || kind === 'refusal') && !result.ok;
      observations.push({
        identity: record.identity,
        operation: reference.name,
        expected,
        observed,
        pass: expected === observed && effectObserved && kindObserved,
        result,
      });
    }
    const missing = OPERATION_NAMES.flatMap((name) =>
      ['success', 'refusal']
        .filter(
          (mode) =>
            !observations.some(
              (o) => o.operation === name && o.pass && (mode === 'success' ? o.result.ok : !o.result.ok),
            ),
        )
        .map((mode) => `${name}/${mode}`),
    );
    return { ok: observations.every((o) => o.pass) && missing.length === 0, observations, missing };
  } finally {
    db.close();
  }
}
if (isEntry(process.argv[1], import.meta.url)) {
  try {
    const fixture = createSystemFixture(resolve(import.meta.dirname, '../..'));
    let result: ReturnType<typeof runScenarios>;
    try {
      result = runScenarios(fixture.root);
    } finally {
      fixture.close();
    }
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      for (const o of result.observations)
        process.stdout.write(`${o.pass ? 'PASS' : 'FAIL'} ${o.identity}: ${o.observed}\n`);
      process.stdout.write(
        `${result.ok ? 'PASS' : 'FAIL'}: ${result.observations.length} executed native scenarios; missing ${result.missing.join(', ') || 'none'}\n`,
      );
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
