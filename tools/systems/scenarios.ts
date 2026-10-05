import '../temp/physical-temp.mjs';
import { createSystemFixture } from './fixture.js';
import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { open } from '../../packages/db/src/index.js';
import { execute, OPERATION_NAMES } from './execute.js';
import { field, text, object, string } from './shared.js';
import type { Result } from './types.js';

/** Test-only composition of real read-only operations. Production dispatch never recognizes this envelope. */
export function prepareScenario(
  input: unknown,
  prepare: (operation: string, input: unknown) => Result,
  readOnly: (operation: string) => boolean,
): { input: unknown; preparation?: Result } {
  if (input === null || typeof input !== 'object' || !('format' in input) || input.format !== 'ia.scenario.prepare.v1')
    return { input };
  const envelope = object(input, ['format', 'prepare', 'input', 'bindings']),
    first = object(envelope['prepare']);
  const indirect = Object.hasOwn(first, 'inputFrom');
  object(first, ['operation', indirect ? 'inputFrom' : 'input']);
  const operation = string(first['operation']);
  if (!readOnly(operation)) throw new Error('Scenario preparation requires one admitted read-only operation');
  const path = (value: unknown): readonly string[] => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 8 ||
      value.some((k) => typeof k !== 'string' || !k || ['__proto__', 'prototype', 'constructor'].includes(k))
    )
      throw new Error('Invalid scenario binding path');
    return value as string[];
  };
  const get = (value: unknown, keys: readonly string[]): unknown =>
    keys.reduce((current: unknown, key) => {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key))
        throw new Error('Scenario binding path is absent');
      return (current as Record<string, unknown>)[key];
    }, value);
  const prepared = prepare(operation, indirect ? get(envelope['input'], path(first['inputFrom'])) : first['input']);
  if (!prepared.ok || prepared.effects !== 'read-only' || prepared.artifacts.length)
    throw new Error('Scenario preparation did not produce an actual read-only success');
  if (!Array.isArray(envelope['bindings']) || !envelope['bindings'].length || envelope['bindings'].length > 8)
    throw new Error('Invalid scenario binding list');
  const output = JSON.parse(JSON.stringify(envelope['input'])) as unknown,
    targets = new Set<string>();
  for (const value of envelope['bindings']) {
    const binding = object(value, ['from', 'to']),
      from = path(binding['from']),
      to = path(binding['to']),
      id = JSON.stringify(to);
    if (targets.has(id)) throw new Error('Duplicate scenario binding target');
    targets.add(id);
    const parent = get(output, to.slice(0, -1)),
      key = to.at(-1)!;
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key))
      throw new Error('Scenario binding target is absent');
    (parent as Record<string, unknown>)[key] = JSON.parse(JSON.stringify(get(prepared, from))) as unknown;
  }
  return { input: output, preparation: prepared };
}

export interface ScenarioObservation {
  readonly identity: string;
  readonly operation: string;
  readonly expected: string;
  readonly observed: string;
  readonly pass: boolean;
  readonly result: Result;
  readonly preparation?: Result;
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
      const prepared = prepareScenario(
        input,
        (name, args) => execute(root, name, args),
        (name) => {
          const operations = db.records().filter((r) => r.discriminator === 'operation' && r.name === name);
          return operations.length === 1 && text(field(operations[0]!, 'execution', 'effects')) === 'read-only';
        },
      );
      const result = execute(root, reference.name, prepared.input),
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
        ...(prepared.preparation ? { preparation: prepared.preparation } : {}),
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
