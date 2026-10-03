import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { Door, MACHINE_PROTOCOL } from '@inventarch/runtime';
import { installSignals, readLine, runCli } from '../src/main.js';

const root = resolve(import.meta.dirname, '../../..'),
  fixture = resolve(root, 'packages/compliance/fixtures/loop');
const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
function run(args: readonly string[], input?: string) {
  return runBounded(process.execPath, [resolve(root, 'apps/cli/dist/main.js'), ...args], {
    cwd: root,
    ...(input === undefined ? {} : { input }),
    timeoutMs: SUBPROCESS,
  });
}
it('delivers an exact native cell from the built executable without source or cache writes', async () => {
  const path = resolve(fixture, '.ia/src/systems/governance-system/records/sample-procedure.ia'),
    before = readFileSync(path);
  const got = await run([
    'context',
    '--root',
    fixture,
    '--params',
    JSON.stringify({
      text: '',
      coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' },
      budget: { tokens: 100000, records: 1000 },
    }),
  ]);
  expect(got.status).toBe(0);
  expect(got.stderr).toBe('');
  const response = JSON.parse(got.stdout);
  expect(response.ok).toBe(true);
  expect(response.result.included[0]).toMatchObject({
    step: 1,
    address: 'governance-system/definition/procedure/sample-procedure#orient/Decision',
  });
  expect(readFileSync(path)).toEqual(before);
  expect(existsSync(resolve(fixture, '.ia/.iadb'))).toBe(false);
});
it('accepts stdin parameters and preserves semantic refusal exit codes', async () => {
  const got = await run(
    ['select', '--root', fixture, '--params', '-'],
    JSON.stringify({
      text: '',
      coordinate: { phase: 'act', primitive: 'Decision' },
      candidates: ['a', 'b'].map((n) => `governance-system/definition/procedure/choice-${n}`),
    }),
  );
  expect(got.status).toBe(1);
  expect(JSON.parse(got.stdout)).toMatchObject({ ok: false, escalation: 'deny-wins-tie' });
});
it('reads a stdin payload larger than a pipe buffer instead of mislabelling it as malformed', async () => {
  // main.ts:33 calls stdin() inside the try around JSON.parse, so a failed read is reported as invalid JSON
  // rather than as a read failure. On POSIX that is exactly what a non-blocking fd 0 produces: constructing
  // process.stdin marks the pipe non-blocking and the readFileSync(0) above then throws EAGAIN as soon as the
  // payload outgrows the pipe buffer. host() must therefore not construct that stream, and this case is the
  // guard: it is indifferent on win32, where the read blocks either way, and load-bearing on Linux.
  const params = JSON.stringify({
    text: ' '.repeat(200000),
    coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' },
    budget: { tokens: 100000, records: 1000 },
  });
  expect(Buffer.byteLength(params)).toBeGreaterThan(65536);
  const got = await run(['context', '--root', fixture, '--params', '-'], params);
  expect(got.status).toBe(0);
  expect(JSON.parse(got.stdout).ok).toBe(true);
});
it('reports the intentional foreign-record admission failure with exit1', async () => {
  const got = await run(['report', '--root', fixture]);
  expect(got.status).toBe(1);
  const result = JSON.parse(got.stdout);
  expect(result.ok).toBe(true);
  expect(result.result.findings.some((f: { code: string }) => f.code === 'IA-COMP-DISCRIMINATOR-FOREIGN')).toBe(true);
});
it('prints usage without opening a corpus and rejects malformed options or JSON', async () => {
  expect((await run(['--help'])).stdout).toContain('Usage: ia');
  // §1.2 step 1 supersedes main.ts:11's usage-exit for a bare `ia`: no arguments now prints consumer help at
  // exit 0. The five remaining cases are genuine legacy syntax errors and keep exit 2 with IA-CLI-USAGE.
  const bare = await run([]);
  expect(bare.status).toBe(0);
  expect(bare.stdout).toContain('Usage: ia');
  for (const args of [
    ['context', '--root'],
    ['context', '--bogus', 'x'],
    ['scope', '--root', fixture, '--root', fixture],
    ['context', '--params', '{'],
  ]) {
    const got = await run(args);
    expect(got.status).toBe(2);
    expect(JSON.parse(got.stdout).code).toBe('IA-CLI-USAGE');
  }
  const shape = await run(['context', '--root', fixture, '--params', '[]']);
  expect(shape.status).toBe(2);
  expect(JSON.parse(shape.stdout).code).toBe('IA-RUNTIME-REQUEST-INVALID');
});
it('preserves unavailable-root errors instead of fabricating an empty workspace', async () => {
  const got = await run(['records', '--root', resolve(fixture, 'absent')]);
  expect(got.status).toBe(1);
  expect(JSON.parse(got.stdout).code).toBe('IA-DB-ROOT-INVALID');
});

it('unwinds a pending stdin read on the first signal and forces exit only on the second', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const controller = new AbortController(),
      input = new PassThrough(),
      exit = vi.fn();
    const before = process.listenerCount(signal),
      dispose = installSignals(controller, exit);
    try {
      const pending = readLine(controller.signal, input);
      const rejected = expect(pending).rejects.toThrow('Interrupted.');
      process.emit(signal);
      await rejected;
      expect(exit).not.toHaveBeenCalled();
      expect(input.isPaused()).toBe(true);
      for (const event of ['data', 'end', 'error']) expect(input.listenerCount(event)).toBe(0);
      process.emit(signal);
      expect(exit).toHaveBeenCalledExactlyOnceWith(130);
    } finally {
      dispose();
      input.destroy();
    }
    expect(process.listenerCount(signal)).toBe(before);
  }
});

const ID = 'governance-system/definition/procedure/sample-procedure';
const ACT = { phase: 'act', primitive: 'Decision', category: 'process' },
  ORIENT = { phase: 'orient', primitive: 'Decision', category: 'process' };
/** Each binding refusal, triggered on top of parameters that otherwise succeed on the loop fixture. */
const bound = (base: Record<string, unknown>): Record<string, Record<string, unknown>> => ({
  'IA-RUNTIME-REQUEST-INVALID': { ...base, unlisted: 1 },
  'IA-DB-SCOPE-UNAVAILABLE': { ...base, within: 'forged' },
  'IA-DB-SCOPE-MISMATCH': { ...base, revision: 'old' },
  'IA-GRAPH-COORDINATE-VALUE-UNKNOWN': { ...base, phase: 'unlisted' },
});
/** context and select, where phase is a coordinate axis rather than a binding. */
const requested = (
  base: Record<string, unknown> & { coordinate: { phase: string } },
): Record<string, Record<string, unknown>> => ({
  'IA-RUNTIME-REQUEST-INVALID': { ...base, unlisted: 1 },
  'IA-DB-SCOPE-UNAVAILABLE': { ...base, within: 'forged' },
  'IA-DB-SCOPE-MISMATCH': { ...base, revision: 'old' },
  'coordinate-incomplete': { ...base, coordinate: { phase: base.coordinate.phase } },
  'IA-GRAPH-COORDINATE-VALUE-UNKNOWN': { ...base, coordinate: { ...base.coordinate, phase: 'unlisted' } },
});
/** Parameters that produce each documented refusal on the loop fixture; spec-0012 ERR-03 makes this set the proof. */
const TRIGGERS: Readonly<Record<string, Readonly<Record<string, Record<string, unknown>>>>> = {
  scope: bound({}),
  context: {
    ...requested({ text: '', coordinate: ORIENT }),
    'IA-GRAPH-VERB-UNKNOWN': { text: '', coordinate: ORIENT, follow: ['unlisted'] },
    'IA-RUNTIME-BUDGET-INVALID': { text: '', coordinate: ORIENT, budget: { tokens: -1, records: 1 } },
    'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW': { text: '', coordinate: ORIENT, budget: { tokens: 1, records: 1 } },
  },
  select: {
    ...requested({ text: '', coordinate: ACT, candidates: [ID] }),
    'no-candidate': { text: '', coordinate: ACT, candidates: [] },
    'deny-wins-tie': {
      text: '',
      coordinate: { phase: 'act', primitive: 'Decision' },
      candidates: ['a', 'b'].map((name) => `governance-system/definition/procedure/choice-${name}`),
    },
  },
  get: { ...bound({ identity: ID }), 'IA-DB-OUT-OF-SCOPE': { identity: 'outside' } },
  records: bound({}),
  resolve: bound({ reference: { kind: 'ref', discriminator: 'playbook', name: 'sample-procedure' } }),
  search: bound({ text: 'fixture' }),
  traverse: {
    ...bound({ start: [ID] }),
    'IA-GRAPH-VERB-UNKNOWN': { start: [ID], follow: ['unlisted'] },
    'IA-GRAPH-TRAVERSAL-INVALID': { start: [ID], depth: 9 },
  },
  report: { 'IA-RUNTIME-REQUEST-INVALID': { unlisted: 1 } },
};
// spec-0012 DRF-02: every example returns ok: true, every required parameter is required, and the refusal list is proven both ways.
it('holds the machine protocol table to the loop fixture', () => {
  const door = new Door(fixture, { cache: false, allowReport: true });
  try {
    for (const operation of MACHINE_PROTOCOL.operations) {
      expect(
        door.request({ operation: operation.name, params: operation.example }).ok,
        `${operation.name} example`,
      ).toBe(true);
      for (const name of (operation.params as { required?: readonly string[] }).required ?? []) {
        const without = Object.fromEntries(Object.entries(operation.example).filter(([key]) => key !== name));
        expect(
          door.request({ operation: operation.name, params: without }).ok,
          `${operation.name} without ${name}`,
        ).toBe(false);
      }
      const triggers = TRIGGERS[operation.name] ?? {};
      const observed = Object.values(triggers).map((params) => {
        const response = door.request({ operation: operation.name, params });
        return response.ok ? 'accepted' : response.code;
      });
      expect(observed, operation.name).toEqual(Object.keys(triggers));
      expect(operation.refusals.map((refusal) => refusal.code).sort(), operation.name).toEqual(
        Object.keys(triggers).sort(),
      );
    }
    // A read's root and phase assert the scope's own values and never narrow it; only scope narrows (packages/db D07, D08).
    for (const name of ['get', 'records', 'resolve', 'search', 'traverse']) {
      const example = MACHINE_PROTOCOL.operations.find((operation) => operation.name === name)!.example;
      for (const binding of [{ phase: 'orient' }, { root: 'floor' }])
        expect(
          door.request({ operation: name, params: { ...example, ...binding } }),
          `${name} ${JSON.stringify(binding)}`,
        ).toMatchObject({ ok: false, code: 'IA-DB-SCOPE-MISMATCH' });
      expect(
        door.request({ operation: name, params: { ...example, phase: null, root: '' } }).ok,
        `${name} asserting the initial scope`,
      ).toBe(true);
    }
    for (const binding of [{ phase: 'orient' }, { root: 'floor' }])
      expect(door.request({ operation: 'scope', params: binding }).ok, JSON.stringify(binding)).toBe(true);
  } finally {
    door.close();
  }
  expect(existsSync(resolve(fixture, '.ia/.iadb'))).toBe(false);
});
// spec-0012 CLI-01..03: help answers plainly, at exit 0, in any option position, and never opens the workspace.
it('answers operation help on the machine route without opening a workspace', async () => {
  const colourful = { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' };
  const help = (args: readonly string[]) =>
    runBounded(process.execPath, [resolve(root, 'apps/cli/dist/main.js'), ...args], {
      cwd: root,
      env: colourful,
      input: '',
      timeoutMs: SUBPROCESS,
    });
  for (const operation of MACHINE_PROTOCOL.operations) {
    const got = await help([operation.name, '--help']);
    expect(got.status, operation.name).toBe(0);
    expect(got.stderr, operation.name).toBe('');
    expect(got.stdout, operation.name).not.toMatch(/[\u001b\u009b]/);
    expect(got.stdout).toContain(`ia ${operation.name}`);
    expect(got.stdout).toContain(JSON.stringify(operation.example));
    for (const refusal of operation.refusals)
      expect(got.stdout, `${operation.name} ${refusal.code}`).toContain(refusal.code);
    // CLI-02: 80 columns; only the example command, one unbreakable token, may run past them.
    for (const line of got.stdout.split('\n'))
      if (!line.includes(`--params '`)) expect(line.length, `${operation.name}: ${line}`).toBeLessThanOrEqual(80);
  }
  const reference = (await help(['traverse', '--help'])).stdout;
  for (const args of [
    ['traverse', '-h'],
    ['traverse', '--root', resolve(fixture, 'absent'), '--help'],
    ['traverse', '--bogus', 'x', '-h'],
  ])
    expect((await help(args)).stdout, args.join(' ')).toBe(reference);
  // In a value position it is a value, as it always was.
  const value = await run(['context', '--params', '--help']);
  expect(value.status).toBe(2);
  expect(JSON.parse(value.stdout).code).toBe('IA-CLI-USAGE');
});
// spec-0012 CLI-05: the operation's description as one JSON line, the object the MCP schema also comes from.
it('prints one operation description as one JSON line for --schema', async () => {
  for (const operation of MACHINE_PROTOCOL.operations) {
    const got = await run([operation.name, '--schema']);
    expect(got.status, operation.name).toBe(0);
    expect(got.stderr).toBe('');
    expect(got.stdout.endsWith('\n') && !got.stdout.slice(0, -1).includes('\n')).toBe(true);
    expect(JSON.parse(got.stdout)).toEqual({ version: MACHINE_PROTOCOL.version, ...operation });
  }
  expect((await run(['context', '--params', '--schema'])).status).toBe(2);
});
// spec-0012 CLI-01: help is decided before `--params -` would read stdin, so a stdin that throws is never touched.
it('answers operation help without reading stdin', () => {
  let reads = 0;
  const unread = (): string => {
    reads++;
    throw new Error('stdin was read');
  };
  const help = runCli(['get', '--params', '-', '--help'], unread);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain('ia get');
  expect(reads).toBe(0);
  // Positive control: without the help token the route reads stdin once, and the throw surfaces as a usage refusal.
  expect(runCli(['get', '--params', '-'], unread)).toMatchObject({ exitCode: 2 });
  expect(reads).toBe(1);
});
// spec-0012 CLI-05: when help and schema tokens are both given, the first one in an option position decides.
it('lets the first help or schema token decide', () => {
  expect(JSON.parse(runCli(['get', '--schema', 'x', '--help']).stdout)).toMatchObject({
    version: MACHINE_PROTOCOL.version,
    name: 'get',
  });
  expect(runCli(['get', '--help', 'x', '--schema']).stdout).toContain('ia get  Read one admitted record');
});
