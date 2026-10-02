/**
 * M4.5's second obligation: the human and the machine entrypoint agree on semantics because M4.2 put one service
 * behind both. Every case here runs the two built binaries over the same workspace and compares the facts the
 * shared service produced — revisions, findings, digests, identities, counters, refusal codes.
 *
 * What is deliberately not compared, and what would be wrong to compare: spacing, column positions, status
 * symbols, colour, wrapping and wording. tests/render.test.ts owns presentation and tools/docs/cli-examples.ts
 * pins §7 byte for byte; a column assertion in this file would be in the wrong file. Exit classes and streams are
 * compared as the deliberate divergence they are rather than asserted equal: §1.4, §3 and §4.4 require the three
 * protocols to stay observably different, and decisions.md:65 forbids normalizing them.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cleanup, DESCRIPTOR, FIXTURE, packable, repository, scratch, workspace } from './workspace-fixture.js';
import { runBounded } from '@tools/testing/subprocess.js';

const MAIN = resolve(repository, 'apps/cli/dist/main.js');
const DISTRIBUTION = resolve(repository, 'apps/distribution/dist/cli.js');
const DESCRIPTOR_PATH = '.ia/work/descriptor.json';
const ID = DESCRIPTOR.id;
afterAll(cleanup);

const spawned = (binary: string, args: readonly string[], env?: NodeJS.ProcessEnv) =>
  runBounded(process.execPath, [binary, ...args], {
    cwd: repository,
    input: '',
    timeoutMs: 120_000,
    ...(env === undefined ? {} : { env }),
  });
const ia = (args: readonly string[]) => spawned(MAIN, args);
const native = (args: readonly string[]) => spawned(DISTRIBUTION, args);
/** The value the entrypoint produced, with the stream and exit class it was required to use. */
function result(
  got: Awaited<ReturnType<typeof ia>>,
  stream: 'stdout' | 'stderr',
  exitCode: number,
  label: string,
): Record<string, unknown> {
  expect(got.status, label).toBe(exitCode);
  expect(got[stream === 'stdout' ? 'stderr' : 'stdout'], label).toBe('');
  return JSON.parse(got[stream]) as Record<string, unknown>;
}

interface Finding {
  readonly severity: string;
}
it('reports one admission through ia validate --json and ia-distribution validate', async () => {
  const admitted = workspace();
  const consumer = result(await ia(['validate', '--root', admitted, '--json']), 'stdout', 0, 'consumer validate');
  const machine = result(await native(['validate', '--root', admitted]), 'stdout', 0, 'native validate');
  expect(consumer['revision']).toBe(machine['revision']);
  expect(consumer['status']).toBe(machine['status']);
  expect(consumer['findings']).toEqual(machine['findings']);
  const findings = machine['findings'] as readonly Finding[];
  expect(consumer['counts']).toMatchObject({
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
  });
  // The record count reaches the consumer through `inspect`, over the same session the native verb opened.
  const overview = result(await ia(['inspect', '--root', admitted, '--json']), 'stdout', 0, 'consumer inspect');
  expect(overview['revision']).toBe(machine['revision']);
  expect((overview['overview'] as { records: number }).records).toBe(machine['records']);

  // The refused workspace: the same verdict, the same error, and the two protocols' own exit meanings kept.
  const refusedConsumer = result(await ia(['validate', '--root', FIXTURE, '--json']), 'stdout', 1, 'consumer refused');
  const refusedMachine = result(await native(['validate', '--root', FIXTURE]), 'stdout', 1, 'native refused');
  expect(refusedConsumer['status']).toBe('refused');
  expect(refusedConsumer['findings']).toEqual(refusedMachine['findings']);
  expect(refusedConsumer['revision']).toBe(refusedMachine['revision']);
  // §2.5: the consumer adds a report outcome the native verdict does not carry; it is a read of the same report.
  expect(refusedConsumer['reportOutcome']).toBe('fail');
  expect(Object.hasOwn(refusedMachine, 'reportOutcome')).toBe(false);
});

it('produces one archive through ia pack --json and ia-distribution pack', async () => {
  const root = packable();
  // Both write outside the root, so neither run can perturb the source the other fingerprints.
  const consumer = result(
    await ia(['pack', '--root', root, '--descriptor', DESCRIPTOR_PATH, '--out', scratch('pack-consumer'), '--json']),
    'stdout',
    0,
    'consumer pack',
  );
  const machine = result(
    await native(['pack', '--source-root', root, '--descriptor', DESCRIPTOR_PATH, '--out', scratch('pack-native')]),
    'stdout',
    0,
    'native pack',
  );
  const { version, ...facts } = consumer;
  expect(version).toBe(1);
  // Every integrity value the two produced, compared whole: archive and manifest digests, the source
  // fingerprint, the archive name and the decoded manifest. §2.7 renames the flag; the packer is one packer.
  expect(facts).toEqual(machine);
  expect(facts['status']).toBe('packed');
  expect(facts['archive']).toMatch(/^[0-9a-f]{64}$/);
  expect(facts['path']).toBe(`${String(facts['archive'])}.ia.tgz`);
});

it('plans one installation through ia install --json and ia-distribution plan install', async () => {
  const source = packable();
  const out = scratch('archives');
  const packed = result(
    await native(['pack', '--source-root', source, '--descriptor', DESCRIPTOR_PATH, '--out', out]),
    'stdout',
    0,
    'seed pack',
  );
  const root = resolve(scratch('plan'), 'workspace');
  mkdirSync(resolve(root, '.ia/work/dist'), { recursive: true });
  copyFileSync(resolve(out, String(packed['path'])), resolve(root, '.ia/work/dist', String(packed['path'])));
  writeFileSync(
    resolve(root, '.ia/work/catalog.json'),
    JSON.stringify([{ path: `.ia/work/dist/${String(packed['path'])}`, withdrawn: false }]) + '\n',
  );
  writeFileSync(resolve(root, '.ia/work/requests.json'), JSON.stringify([{ id: ID, range: '^0.1.0' }]) + '\n');

  const machine = result(
    await native([
      'plan',
      'install',
      '--root',
      root,
      '--catalog',
      '.ia/work/catalog.json',
      '--requests',
      '.ia/work/requests.json',
    ]),
    'stdout',
    0,
    'native plan',
  );
  const consumer = result(
    await ia(['install', `${ID}@^0.1.0`, '--root', root, '--catalog', '.ia/work/catalog.json', '--json']),
    'stdout',
    0,
    'consumer plan',
  );
  expect(consumer['command']).toBe('install');
  // The whole planner output, digest included. The digest covers the plan's own root, so equality here also
  // proves both entrypoints resolved the same absolute root before calling the service.
  expect(consumer['plan']).toEqual(machine);
  expect(machine['digest']).toMatch(/^[0-9a-f]{64}$/);
  expect(consumer['applied']).toBeUndefined();
  // §2.8 rule 1: a preview writes no installation state, and acquisition fills the content-addressed cache
  // because resolution is by verified bytes. Both entrypoints do exactly that, and nothing more.
  expect(existsSync(resolve(root, '.ia/distributions.lock.json'))).toBe(false);
  expect(existsSync(resolve(root, '.ia/distributions/active.json'))).toBe(false);
  expect(readdirSync(resolve(root, '.ia/distributions/cache'))).toEqual([`${String(packed['archive'])}.ia.tgz`]);

  // Applying through the consumer leaves the installed state the native read reports, field for field.
  const applied = result(
    await ia([
      'install',
      `${ID}@^0.1.0`,
      '--root',
      root,
      '--catalog',
      '.ia/work/catalog.json',
      '--apply',
      '--yes',
      '--json',
    ]),
    'stdout',
    0,
    'consumer apply',
  );
  const state = result(await native(['doctor', '--root', root]), 'stdout', 0, 'native doctor');
  const pointer = state['pointer'] as { generation: string; counter: number };
  const installation = (
    result(await ia(['inspect', '--root', root, '--json']), 'stdout', 0, 'consumer inspect')['overview'] as {
      installation: Record<string, unknown>;
    }
  ).installation;
  const status = applied['applied'] as { status: string; generation: string; counter: number; host: string };
  expect(state['status']).toBe('installed');
  expect(installation).toMatchObject({ status: 'installed', generation: pointer.generation, counter: pointer.counter });
  expect(status).toMatchObject({ status: 'installed', generation: pointer.generation, counter: pointer.counter });
  // No `ia host` registration exists in this workspace, so observation reports none, never a guess.
  expect(installation['hosts']).toEqual([]);
  expect(state['host']).toBe('pending');
  expect(status.host).toBe('pending');
  // `list` and `doctor` share one body on the native side; the consumer's doctor rows carry the same generation.
  expect(result(await native(['list', '--root', root]), 'stdout', 0, 'native list')).toEqual(state);
  // A scratch IA home keeps doctor's host plugin distribution rows off the real ~/.ia.
  const doctorEnv = { ...process.env, IA_HOME: resolve(scratch('equivalence-doctor-home'), '.ia') };
  const checks = result(
    await spawned(MAIN, ['doctor', '--root', root, '--json'], doctorEnv),
    'stdout',
    0,
    'consumer doctor',
  )['checks'] as readonly { id: string; status: string; detail: string }[];
  const generation = checks.find((check) => check.id === 'generation')!;
  expect(generation.status).toBe('info');
  expect(generation.detail).toContain(pointer.generation.slice(0, 12));
  expect(generation.detail).toContain(`counter ${pointer.counter}`);
  expect(checks.find((check) => check.id === 'host')!.status).toBe('info');
  expect(checks.find((check) => check.id === 'pending')!.status).toBe('ok');
});

it('refuses the same bad input with the same service code on both entrypoints', async () => {
  const empty = resolve(scratch('refusal'), 'workspace');
  mkdirSync(resolve(empty, '.ia/work'), { recursive: true });
  const out = scratch('refusal-out');
  const pairs: readonly {
    readonly consumer: readonly string[];
    readonly machine: readonly string[];
    readonly code: string;
  }[] = [
    {
      consumer: ['pack', '--root', empty, '--descriptor', '.ia/work/absent.json'],
      machine: ['pack', '--source-root', empty, '--descriptor', '.ia/work/absent.json', '--out', out],
      code: 'IA-DIST-INPUT-INVALID',
    },
    {
      consumer: ['remove', ID, '--root', empty],
      machine: ['plan', 'remove', '--root', empty, '--id', ID],
      code: 'IA-DIST-INPUT-INVALID',
    },
    {
      consumer: ['restore', '--root', empty, '--offline', '--apply', '--yes'],
      machine: ['restore', '--root', empty, '--offline'],
      code: 'IA-DIST-INPUT-INVALID',
    },
    {
      consumer: ['format', '--root', FIXTURE],
      machine: ['format', '--root', FIXTURE, '--path', 'x.ia', '--input', 'x.ia'],
      code: 'IA-DIST-CLOSURE-INCOMPLETE',
    },
  ];
  for (const pair of pairs) {
    const label = pair.consumer.join(' ');
    // §4.1: the consumer never rewrites a service's code, so the two carry the same string...
    const consumer = result(await ia([...pair.consumer, '--json']), 'stdout', 3, label);
    const machine = result(await native(pair.machine), 'stderr', 1, label);
    expect(consumer['code'], label).toBe(pair.code);
    expect(machine['code'], label).toBe(pair.code);
    // ...and the same message from the service, which the consumer renders but does not rewrite.
    expect(consumer['message'], label).toBe(machine['message']);
    // ...while the class and the stream stay each protocol's own: class 3 on stdout against 1 on stderr.
    expect(consumer, label).toMatchObject({ version: 1, ok: false, exit: 3 });
    expect(machine, label).toMatchObject({ status: 'refused' });
  }
  // One service refusal reached through the two binaries' *human* forms keeps the same divergence: the consumer
  // renders an error block onto stderr, the native binary puts its refusal object there, and neither writes.
  const human = await ia(['remove', ID, '--root', empty]);
  expect(human.status).toBe(3);
  expect(human.stdout).toBe('');
  expect(human.stderr).toContain('IA-DIST-INPUT-INVALID');
  expect(existsSync(resolve(empty, '.ia/distributions'))).toBe(false);
});
