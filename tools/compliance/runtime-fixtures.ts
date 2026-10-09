import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { CompiledRecord, Location } from '../../packages/language/src/index.js';
import { open } from '../../packages/db/src/index.js';
import { Door, mandateAuthorityOf, mandateRefusal, readBody } from '../../packages/runtime/src/index.js';
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
  ];
  try {
    return fixtures.map(({ name, expected, input }): FixtureResult => {
      const result = door.request(input),
        observedCodes = result.ok ? [] : [result.code];
      const findings: Finding[] = observedCodes.includes(expected)
        ? []
        : [
            {
              code: 'IA-COMP-FIXTURE-MISMATCH',
              severity: 'error',
              path: base,
              line: 1,
              message: `${name}: expected ${expected}, received ${result.ok ? 'success' : result.code}`,
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
 * fixture never writes, read once as authored and once with its source at runtime placement; codes come only from
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
      placed = open(workspace, { cache: false, locations: { [path]: runtime } });
    const read = (file: string): Uint8Array => readFileSync(resolve(workspace, file));
    const fixtures = [
      { name: 'read-unadmitted', expected: 'IA-RUNTIME-READ-UNADMITTED', handle: authored, locator: `${spec}-absent` },
      { name: 'read-fragment', expected: 'IA-RUNTIME-READ-FRAGMENT', handle: authored, locator: `${spec}#REQ-ABSENT` },
      { name: 'read-unreachable', expected: 'IA-RUNTIME-READ-UNREACHABLE', handle: authored, locator: spec },
      { name: 'read-placement', expected: 'IA-RUNTIME-READ-PLACEMENT', handle: placed, locator: spec },
    ];
    try {
      return fixtures.map(({ name, expected, handle, locator }): FixtureResult => {
        const result = readBody(handle, locator, { read }),
          observedCodes: readonly string[] = result.ok ? [] : [result.code];
        const findings: Finding[] = observedCodes.includes(expected)
          ? []
          : [
              {
                code: 'IA-COMP-FIXTURE-MISMATCH',
                severity: 'error',
                path: 'packages/runtime/src/locator.ts',
                line: 1,
                message: `${name}: expected ${expected}, received ${result.ok ? 'success' : result.code}`,
              },
            ];
        return { assessment: assess('COMP-FIXTURES', `runtime/${name}`, findings), observedCodes };
      });
    } finally {
      authored.close();
      placed.close();
    }
  } finally {
    const created = relative(tmpdir(), workspace);
    if (isAbsolute(created) || !/^ia-read-fixture-[\w-]+$/.test(created)) throw new Error('Unsafe cleanup');
    rmSync(workspace, { recursive: true, force: true });
  }
}
