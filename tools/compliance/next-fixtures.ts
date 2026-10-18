import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { open } from '../../packages/db/src/index.js';
import { Door, deliveryView } from '../../packages/runtime/src/index.js';
import type { DeliveryResult, DoorResponse } from '../../packages/runtime/src/index.js';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

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
