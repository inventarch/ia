import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { CompiledRecord, Location } from '../../packages/language/src/index.js';
import { open } from '../../packages/db/src/index.js';
import { Door, deliveryView, mandateAuthorityOf, mandateRefusal, readBody } from '../../packages/runtime/src/index.js';
import type { DeliveryResult, DoorResponse } from '../../packages/runtime/src/index.js';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

/** Real native-tree door requests; observed codes come only from execution. */
export function runRuntimeFixtures(root: string): readonly FixtureResult[] {
  const base = 'packages/compliance/fixtures/loop',
    door = new Door(resolve(root, base), { cache: false });
  const coordinate = { phase: 'act', primitive: 'Decision', category: 'process' };
  const choices = ['a', 'b'].map((name) => `governance-system/definition/procedure/choice-${name}`);
  const fixtures = [
    { name: 'invalid-operation', expected: 'IA-RUNTIME-REQUEST-INVALID', input: { operation: 'invented' } },
    {
      name: 'invalid-budget',
      expected: 'IA-RUNTIME-BUDGET-INVALID',
      input: { operation: 'context', params: { text: '', coordinate, budget: { tokens: -1, records: 1 } } },
    },
    {
      name: 'blocking-overflow',
      expected: 'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW',
      input: { operation: 'context', params: { text: '', coordinate, budget: { tokens: 0, records: 0 } } },
    },
    {
      name: 'incomplete',
      expected: 'coordinate-incomplete',
      input: { operation: 'select', params: { text: '', coordinate: { phase: 'act' }, candidates: choices } },
    },
    {
      name: 'tied',
      expected: 'deny-wins-tie',
      input: { operation: 'select', params: { text: '', coordinate, candidates: choices } },
    },
    {
      name: 'no-candidate',
      expected: 'no-candidate',
      input: { operation: 'select', params: { text: '', coordinate, candidates: [] } },
    },
    // MACHINE_PROTOCOL version 2: a scope key past its depth cap, refused by the Door's position operation with the cap
    // as its next command, which a door that does not serve position, refusing it as an unknown operation, never names.
    {
      name: 'invalid-scope-key',
      expected: 'IA-RUNTIME-REQUEST-INVALID',
      next: 'ia position --depth 2',
      input: { operation: 'position', params: { depth: 3 } },
    },
  ];
  try {
    return fixtures.map(({ name, expected, next, input }): FixtureResult => {
      const result = door.request(input),
        observedCodes = result.ok ? [] : [result.code],
        observedNext = !result.ok && 'next' in result ? result.next : undefined,
        received = result.ok
          ? 'success'
          : `${result.code}${observedNext === undefined ? '' : ` naming ${String(observedNext)}`}`;
      const findings: Finding[] =
        observedCodes.includes(expected) && (next === undefined || observedNext === next)
          ? []
          : [
              {
                code: 'IA-COMP-FIXTURE-MISMATCH',
                severity: 'error',
                path: base,
                line: 1,
                message: `${name}: expected ${expected}${next === undefined ? '' : ` naming ${next}`}, received ${received}`,
              },
            ];
      return { assessment: assess('COMP-FIXTURES', `runtime/${name}`, findings), observedCodes };
    });
  } finally {
    door.close();
  }
}

/** The conformance sample-mandate allows Observation and Verification and excludes the hook word; codes come only from execution. */
export function runMandateFixtures(records: readonly CompiledRecord[]): readonly FixtureResult[] {
  const path = '.ia/src/systems/agent-system/records/sample-mandate.ia',
    mandate = records.find((r) => r.discriminator === 'mandate' && r.name === 'sample-mandate');
  const fixtures = [
    { name: 'mandate-move', expected: 'IA-RUNTIME-MANDATE-MOVE', mode: 'author', words: [] },
    { name: 'mandate-word', expected: 'IA-RUNTIME-MANDATE-WORD', mode: 'read', words: ['hook'] },
  ] as const;
  return fixtures.map(({ name, expected, mode, words }): FixtureResult => {
    const refusal = mandate === undefined ? undefined : mandateRefusal(mandateAuthorityOf(mandate), mode, words),
      observedCodes = refusal === undefined ? [] : [refusal.code];
    const findings: Finding[] = observedCodes.includes(expected)
      ? []
      : [
          {
            code: 'IA-COMP-FIXTURE-MISMATCH',
            severity: 'error',
            path,
            line: 1,
            message: `${name}: expected ${expected}, received ${refusal?.code ?? 'success'}`,
          },
        ];
    return { assessment: assess('COMP-FIXTURES', `runtime/${name}`, findings), observedCodes };
  });
}

/**
 * Body reads over a copy of the conformance corpus that adds one `@spec` whose source locator names a document the
 * fixture never writes, read once as authored and once with its source at runtime placement, by `readBody` and again by
 * the Door's `read` operation (MACHINE_PROTOCOL version 2) with its own workspace reader; codes come only from
 * execution.
 */
export function runReadFixtures(root: string): readonly FixtureResult[] {
  const workspace = mkdtempSync(resolve(tmpdir(), 'ia-read-fixture-')),
    path = '.ia/src/systems/work-system/records/read-fixture.ia',
    spec = 'work-system/contract/spec/read-fixture',
    runtime: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' };
  try {
    cpSync(resolve(root, 'examples/conformance/native'), resolve(workspace, '.ia/src'), { recursive: true });
    mkdirSync(dirname(resolve(workspace, path)), { recursive: true });
    writeFileSync(
      resolve(workspace, path),
      '#! ia 1.0\n\n@spec read-fixture\n  meaning\n    says "A spec whose document is never written."\n  work\n    title "Read fixture"\n    status draft\n    source "docs/absent.md"\n',
    );
    const authored = open(workspace, { cache: false }),
      placed = open(workspace, { cache: false, locations: { [path]: runtime } }),
      door = new Door(workspace, { cache: false }),
      placedDoor = new Door(workspace, { cache: false, locations: { [path]: runtime } });
    const read = (file: string): Uint8Array => readFileSync(resolve(workspace, file));
    const body = (handle: typeof authored) => (locator: string) => readBody(handle, locator, { read });
    const request =
      (gate: Door) =>
      (locator: string): DoorResponse =>
        gate.request({ operation: 'read', params: { locator } });
    const fixtures = [
      {
        name: 'read-unadmitted',
        expected: 'IA-RUNTIME-READ-UNADMITTED',
        run: body(authored),
        locator: `${spec}-absent`,
      },
      {
        name: 'read-fragment',
        expected: 'IA-RUNTIME-READ-FRAGMENT',
        run: body(authored),
        locator: `${spec}#REQ-ABSENT`,
      },
      { name: 'read-unreachable', expected: 'IA-RUNTIME-READ-UNREACHABLE', run: body(authored), locator: spec },
      { name: 'read-placement', expected: 'IA-RUNTIME-READ-PLACEMENT', run: body(placed), locator: spec },
      {
        name: 'door-read-unadmitted',
        expected: 'IA-RUNTIME-READ-UNADMITTED',
        run: request(door),
        locator: `${spec}-absent`,
      },
      {
        name: 'door-read-fragment',
        expected: 'IA-RUNTIME-READ-FRAGMENT',
        run: request(door),
        locator: `${spec}#REQ-ABSENT`,
      },
      { name: 'door-read-unreachable', expected: 'IA-RUNTIME-READ-UNREACHABLE', run: request(door), locator: spec },
      { name: 'door-read-placement', expected: 'IA-RUNTIME-READ-PLACEMENT', run: request(placedDoor), locator: spec },
    ];
    try {
      return fixtures.map(({ name, expected, run, locator }): FixtureResult => {
        const result = run(locator),
          observedCodes: readonly string[] = result.ok ? [] : [result.code];
        const findings: Finding[] = observedCodes.includes(expected)
          ? []
          : [
              {
                code: 'IA-COMP-FIXTURE-MISMATCH',
                severity: 'error',
                path: name.startsWith('door-') ? 'packages/runtime/src/door.ts' : 'packages/runtime/src/locator.ts',
                line: 1,
                message: `${name}: expected ${expected}, received ${result.ok ? 'success' : result.code}`,
              },
            ];
        return { assessment: assess('COMP-FIXTURES', `runtime/${name}`, findings), observedCodes };
      });
    } finally {
      authored.close();
      placed.close();
      door.close();
      placedDoor.close();
    }
  } finally {
    const created = relative(tmpdir(), workspace);
    if (isAbsolute(created) || !/^ia-read-fixture-[\w-]+$/.test(created)) throw new Error('Unsafe cleanup');
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Delivery views over a copy of the conformance corpus, which authors no @plan, read once as it is and once with two
 * plans added, the first with two tasks that require each other, by `deliveryView` and again by the Door's `next`
 * operation (MACHINE_PROTOCOL version 2); codes come only from execution.
 */
export function runNextFixtures(root: string): readonly FixtureResult[] {
  const workspace = mkdtempSync(resolve(tmpdir(), 'ia-next-fixture-')),
    path = '.ia/src/next-fixture.ia';
  const record = (word: string, name: string, work: string, relationships = ''): string =>
    `\n@${word} ${name}\n  meaning\n    says "The ${name} fixture."\n  work\n    title "${name}"\n    status open\n${work}${relationships}`;
  try {
    cpSync(resolve(root, 'examples/conformance/native'), resolve(workspace, '.ia/src'), { recursive: true });
    const unplanned = open(workspace, { cache: false }),
      unplannedDoor = new Door(workspace, { cache: false });
    writeFileSync(
      resolve(workspace, path),
      [
        '#! ia 1.0',
        record('plan', 'loop', ''),
        record('plan', 'other', ''),
        record('milestone', 'ring', '    plan @plan loop\n    exit "Never reached."\n'),
        record('task', 'first', '    milestone @milestone ring\n', '  relationships\n    requires @task second\n'),
        record('task', 'second', '    milestone @milestone ring\n', '  relationships\n    requires @task first\n'),
      ].join('\n'),
    );
    const planned = open(workspace, { cache: false }),
      plannedDoor = new Door(workspace, { cache: false });
    const view =
      (handle: typeof planned) =>
      (seat: string | undefined): DeliveryResult =>
        deliveryView(handle, handle.resolveScope().token, seat);
    const request =
      (gate: Door) =>
      (seat: string | undefined): DoorResponse =>
        gate.request({ operation: 'next', params: seat === undefined ? {} : { seat } });
    const law = 'governance-system/governance/law/sample-rule',
      loop = 'work-system/definition/plan/loop';
    const fixtures = [
      { name: 'next-no-plan', expected: 'IA-RUNTIME-NEXT-NO-PLAN', run: view(unplanned), seat: undefined },
      { name: 'next-ambiguous', expected: 'IA-RUNTIME-NEXT-AMBIGUOUS', run: view(planned), seat: undefined },
      { name: 'next-seat', expected: 'IA-RUNTIME-NEXT-SEAT', run: view(planned), seat: law },
      { name: 'next-cycle', expected: 'IA-RUNTIME-NEXT-CYCLE', run: view(planned), seat: loop },
      { name: 'door-next-no-plan', expected: 'IA-RUNTIME-NEXT-NO-PLAN', run: request(unplannedDoor), seat: undefined },
      {
        name: 'door-next-ambiguous',
        expected: 'IA-RUNTIME-NEXT-AMBIGUOUS',
        run: request(plannedDoor),
        seat: undefined,
      },
      { name: 'door-next-seat', expected: 'IA-RUNTIME-NEXT-SEAT', run: request(plannedDoor), seat: law },
      { name: 'door-next-cycle', expected: 'IA-RUNTIME-NEXT-CYCLE', run: request(plannedDoor), seat: loop },
    ];
    try {
      return fixtures.map(({ name, expected, run, seat }): FixtureResult => {
        const result = run(seat),
          observedCodes: readonly string[] = result.ok ? [] : [result.code];
        const findings: Finding[] = observedCodes.includes(expected)
          ? []
          : [
              {
                code: 'IA-COMP-FIXTURE-MISMATCH',
                severity: 'error',
                path: name.startsWith('door-') ? 'packages/runtime/src/door.ts' : 'packages/runtime/src/next.ts',
                line: 1,
                message: `${name}: expected ${expected}, received ${result.ok ? 'success' : result.code}`,
              },
            ];
        return { assessment: assess('COMP-FIXTURES', `runtime/${name}`, findings), observedCodes };
      });
    } finally {
      unplanned.close();
      planned.close();
      unplannedDoor.close();
      plannedDoor.close();
    }
  } finally {
    const created = relative(tmpdir(), workspace);
    if (isAbsolute(created) || !/^ia-next-fixture-[\w-]+$/.test(created)) throw new Error('Unsafe cleanup');
    rmSync(workspace, { recursive: true, force: true });
  }
}
