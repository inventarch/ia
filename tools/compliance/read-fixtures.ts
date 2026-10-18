import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Location } from '../../packages/language/src/index.js';
import { open } from '../../packages/db/src/index.js';
import { Door, readBody } from '../../packages/runtime/src/index.js';
import type { DoorResponse } from '../../packages/runtime/src/index.js';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

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
