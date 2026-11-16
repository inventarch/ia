/**
 * The human and the machine entrypoint agree on semantics because one service stands behind both. Every case here
 * runs the two built binaries over the same workspace and compares the facts the shared service produced —
 * revisions, findings, digests, identities, counters, refusal codes.
 *
 * What is deliberately not compared, and what would be wrong to compare: spacing, column positions, status
 * symbols, colour, wrapping and wording. tests/render.test.ts owns presentation and pins its reference blocks byte
 * for byte; a column assertion in this file would be in the wrong file. Exit classes and streams are compared as the
 * deliberate divergence they are rather than asserted equal: §3 requires the three protocols to stay observably
 * different, and none is normalized to another.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cleanup, DESCRIPTOR, FIXTURE, packable, repository, scratch, workspace } from './workspace-fixture.js';
import { runBounded } from '@tools/testing/subprocess.js';

const MAIN = resolve(repository, 'apps/cli/dist/main.js');
const DISTRIBUTION = resolve(repository, 'apps/distribution/dist/cli.js');
const DESCRIPTOR_PATH = '.ia/work/descriptor.json';
const ID = DESCRIPTOR.id;
afterAll(cleanup, 120_000);

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
  readonly code: string;
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
  // The consumer adds a report outcome the native verdict does not carry; it is a read of the same report.
  expect(refusedConsumer['reportOutcome']).toBe('fail');
  expect(Object.hasOwn(refusedMachine, 'reportOutcome')).toBe(false);
});

it('reports the declarations that declare nothing through both entrypoints, from the one validation service', async () => {
  // The native corpus with a `composition.sources` entry whose placement is misspelled and a mandate selection with a
  // `./` segment: each declares nothing, and each is a warning that admission does not count (db D02a, D02b).
  const root = resolve(scratch('equivalence-inert'), 'workspace'),
    workspaceRecord = resolve(root, '.ia/src/systems/workspace-system/records/foundation-workspace.ia'),
    mandate = resolve(root, '.ia/src/systems/agent-system/records/sample-mandate.ia');
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), { recursive: true });
  const edit = (path: string, from: string, to: string): void => {
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(from);
    writeFileSync(path, text.replace(from, to));
  };
  edit(workspaceRecord, '  relationships\n', '    sources [".ia/src @authorded"]\n  relationships\n');
  edit(mandate, 'covers ["docs/**"]', 'covers ["./docs/**"]');
  const consumer = result(await ia(['validate', '--root', root, '--json']), 'stdout', 0, 'consumer validate');
  const machine = result(await native(['validate', '--root', root]), 'stdout', 0, 'native validate');
  const findings = machine['findings'] as readonly Finding[];
  expect(findings.filter((finding) => finding.code === 'IA-COMP-FIELD-VALUE')).toHaveLength(2);
  expect(consumer['findings']).toEqual(findings);
  expect(consumer['counts']).toMatchObject({
    errors: 0,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
  });
  expect(consumer['status']).toBe(machine['status']);
});

it('ia-distribution validate agrees on every law, and a pending law exits 0 in both', async () => {
  const root = resolve(scratch('equivalence-laws'), 'workspace'),
    env = { ...process.env, IA_HOME: resolve(scratch('equivalence-laws-home'), '.ia') };
  expect((await spawned(MAIN, ['init', root, '--apply', '--yes', '--json'], env)).status).toBe(0);
  const law = (name: string, enforcedBy?: string) =>
    `@law ${name}
  meaning
    says "Law ${name}."
    answers "What does law ${name} require?"
  governance
    severity blocking
${
  enforcedBy === undefined
    ? ''
    : `  relationships
    enforced-by @check ${enforcedBy}
`
}`;
  const check = `@check schema-gate
  meaning
    says "Gate."
    answers "What does the gate evaluate?"
  check
    runs COMP-SCHEMA
    scope "*"
`;
  writeFileSync(
    resolve(root, '.ia/src/laws.ia'),
    `#! ia 1.0

${law('lonely-law')}
${law('gated-law', 'schema-gate')}
${check}`,
  );
  const consumer = result(await spawned(MAIN, ['validate', '--root', root, '--json'], env), 'stdout', 0, 'ia validate'),
    machine = result(await spawned(DISTRIBUTION, ['validate', '--root', root], env), 'stdout', 0, 'native validate');
  const laws = machine['laws'] as readonly { identity: string; state: string }[];
  expect(laws.map((law) => [law.identity.split('/').at(-1), law.state])).toEqual([
    ['gated-law', 'enforced'],
    ['lonely-law', 'pending'],
  ]);
  expect(consumer['laws']).toEqual(laws);
  expect(consumer['counts']).toMatchObject({ lawsPending: 1, lawsSuspended: 0 });
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
  // fingerprint, the archive name and the decoded manifest. The consumer renames the flag; the packer is one packer.
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
  // Registry spec §6.1: a preview writes no installation state, and acquisition fills the content-addressed cache
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
    // §4: the consumer never rewrites a service's code, so the two carry the same string...
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

/**
 * Every entry under `roots` and each root itself, with each directory's modification time and each file's size,
 * modification time and digest: a write anywhere changes it, and so does creating a root that was absent (an IA home
 * created empty, or a file created and removed again, still shows).
 */
function tree(...roots: string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  const describe = (path: string): string => {
    const stat = statSync(path);
    return stat.isDirectory()
      ? `directory ${stat.mtimeMs}`
      : `${stat.size} ${stat.mtimeMs} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  };
  for (const top of roots) {
    entries[top] = existsSync(top) ? describe(top) : 'absent';
    if (existsSync(top))
      for (const entry of readdirSync(top, { recursive: true, encoding: 'utf8' }))
        entries[resolve(top, entry)] = describe(resolve(top, entry));
  }
  return entries;
}
/** Two authored execution bindings: one names the installed captured read, one an implementation no host ships. */
const BINDINGS = `#! ia 1.0

@execution-binding read-captured-source-binding
  meaning
    says "Select the installed first-party captured-source read adapter."
    answers "Which installed implementation serves captured reads here?"
  binding
    kind operation
    implementation captured-source-read-v1

@execution-binding missing-binding
  meaning
    says "Select an implementation no host ships."
    answers "What does an implementation that is not installed bind to?"
  binding
    kind operation
    implementation missing-read-v1
`;
interface BindingRow {
  readonly identity: string;
  readonly status: string;
  readonly reason: string;
}
it('reports one Bindings section through ia validate --json and ia-distribution validate, and neither writes', async () => {
  const root = resolve(scratch('equivalence-bindings'), 'workspace'),
    home = resolve(scratch('equivalence-bindings-home'), '.ia'),
    env = { ...process.env, IA_HOME: home };
  expect((await spawned(MAIN, ['init', root, '--apply', '--yes', '--json'], env)).status).toBe(0);
  writeFileSync(resolve(root, '.ia/src/bindings.ia'), BINDINGS);
  // Each validation trusts a join only through its own installation's payload. ia's is the one its
  // bundled pin names in IA_HOME; ia-distribution's is the payload it runs from, as the payload's launcher runs it.
  // Before any payload is materialized, the repository's own ia-distribution reports the same unjoined workspace.
  let machineBinary = DISTRIBUTION;
  const both = async (exitCode: number, label: string) => {
    const before = tree(root, home);
    const consumer = result(
      await spawned(MAIN, ['validate', '--root', root, '--json'], env),
      'stdout',
      exitCode,
      label,
    );
    const machine = result(await spawned(machineBinary, ['validate', '--root', root], env), 'stdout', exitCode, label);
    // Computing and reporting bindings writes nothing anywhere: not in the workspace, not in the IA home.
    expect(tree(root, home), label).toEqual(before);
    expect(consumer['bindings'], label).toEqual(machine['bindings']);
    const bindings = machine['bindings'] as { catalog: Record<string, unknown>; results: BindingRow[] };
    return {
      catalog: bindings.catalog,
      status: Object.fromEntries(bindings.results.map((row) => [row.identity.split('/').at(-1), row.status])),
    };
  };
  // No host has joined a catalog yet (as for an ia project-only workspace): nothing is bound, and nothing passes.
  expect(await both(0, 'unjoined')).toEqual({
    catalog: { status: 'unavailable', reason: expect.stringContaining('no host has joined') },
    status: { 'missing-binding': 'unavailable', 'read-captured-source-binding': 'unavailable' },
  });
  expect((await spawned(MAIN, ['host', 'claude', '--root', root, '--apply', '--yes', '--json'], env)).status).toBe(0);
  const state = resolve(root, '.ia/distributions/hosts/claude-workspace.json'),
    registration = JSON.parse(readFileSync(state, 'utf8')) as { cache: string; release: string };
  machineBinary = resolve(registration.cache, 'runtime/node_modules/@inventarch/distribution/dist/cli.js');
  // The host's payload ships the read handler, so its binding is bound; the missing implementation stays unavailable.
  const joined = await both(0, 'joined');
  expect(joined).toEqual({
    catalog: expect.objectContaining({ status: 'joined', consumer: 'claude' }),
    status: { 'missing-binding': 'unavailable', 'read-captured-source-binding': 'bound' },
  });
  // Shipped handler bytes altered after the build: the joined catalog fails verification, and every operation binding
  // is revoked, which fails both runs.
  const handler = resolve(
    home,
    'hosts',
    String(joined.catalog['release']),
    'runtime/node_modules/@inventarch/agent-composition-system/dist/installed-read.js',
  );
  const original = readFileSync(handler);
  writeFileSync(handler, Buffer.concat([original, Buffer.from('\n// altered\n')]));
  try {
    expect(await both(1, 'altered')).toEqual({
      catalog: expect.objectContaining({
        status: 'damaged',
        reason: expect.stringContaining('IA-DIST-INTEGRITY-MISMATCH'),
      }),
      status: { 'missing-binding': 'revoked', 'read-captured-source-binding': 'revoked' },
    });
  } finally {
    writeFileSync(handler, original);
  }
  // A registration naming a copy of the payload inside the workspace, at the genuine release: neither validation
  // trusts or opens it, so nothing binds.
  const copy = resolve(root, '.ia/work/payload');
  cpSync(registration.cache, copy, { recursive: true });
  const genuine = readFileSync(state);
  writeFileSync(state, JSON.stringify({ ...JSON.parse(genuine.toString('utf8')), cache: copy }));
  try {
    expect(await both(0, 'in-workspace payload')).toEqual({
      catalog: {
        status: 'unavailable',
        reason: expect.stringContaining("host claude's registration names a payload other than"),
      },
      status: { 'missing-binding': 'unavailable', 'read-captured-source-binding': 'unavailable' },
    });
  } finally {
    writeFileSync(state, genuine);
  }
});

/** Two local checks over built-in evaluators: one over the whole-workspace token, which passes, and one prose-scoped. */
const CHECKS = `#! ia 1.0

@check demo-schema-check
  meaning
    says "Validate every admitted record against its schema."
    answers "Does every record have the structure its schema requires?"
  check
    runs COMP-SCHEMA
    scope "*"
  governance
    severity blocking

@check prose-check
  meaning
    says "Select records by prose, which selects nothing."
    answers "Is a prose scope ever a pass?"
  check
    runs COMP-SCHEMA
    scope "every admitted record"
  governance
    severity blocking
`;
it('reports one Checks result through both validation binaries, which record the same evidence', async () => {
  const root = resolve(scratch('equivalence-checks'), 'workspace'),
    home = resolve(scratch('equivalence-checks-home'), '.ia'),
    env = { ...process.env, IA_HOME: home };
  expect((await spawned(MAIN, ['init', root, '--apply', '--yes', '--json'], env)).status).toBe(0);
  writeFileSync(resolve(root, '.ia/src/checks.ia'), CHECKS);
  expect((await spawned(MAIN, ['host', 'claude', '--root', root, '--apply', '--yes', '--json'], env)).status).toBe(0);
  const registration = JSON.parse(
      readFileSync(resolve(root, '.ia/distributions/hosts/claude-workspace.json'), 'utf8'),
    ) as { cache: string },
    machineBinary = resolve(registration.cache, 'runtime/node_modules/@inventarch/distribution/dist/cli.js');
  const consumer = async () =>
      result(await spawned(MAIN, ['validate', '--root', root, '--json'], env), 'stdout', 0, 'ia validate'),
    machine = async () =>
      result(await spawned(machineBinary, ['validate', '--root', root], env), 'stdout', 0, 'ia-distribution validate');
  const evidence = resolve(root, '.ia/work/evidence');
  // Either binary first: the first records the evidence, the second finds exactly those bytes and rewrites nothing.
  for (const [first, second] of [
    [consumer, machine],
    [machine, consumer],
  ] as const) {
    rmSync(evidence, { recursive: true, force: true });
    const a = await first(),
      bytes = readdirSync(evidence).map((name) => readFileSync(resolve(evidence, name), 'utf8')),
      b = await second();
    expect(b['checks']).toEqual(a['checks']);
    expect(b['bindings']).toEqual(a['bindings']);
    expect(a['evidence']).toMatchObject({ written: true, pruned: [] });
    expect(b['evidence']).toEqual({ ...(a['evidence'] as object), written: false });
    expect(readdirSync(evidence).map((name) => readFileSync(resolve(evidence, name), 'utf8'))).toEqual(bytes);
    const results = (a['checks'] as { results: { name: string; outcome: string }[] }).results;
    expect(results.map((row) => [row.name, row.outcome])).toEqual([
      ['demo-schema-check', 'pass'],
      ['prose-check', 'not-evaluated'],
    ]);
    expect((a['evidence'] as { observations: { verdict: string }[] }).observations.map((row) => row.verdict)).toEqual([
      'success',
    ]);
  }
});

/** A check naming a catalog evaluator, which only the validate request admits. */
const TYPING = `#! ia 1.0

@check typing-check
  meaning
    says "Run an evaluator the host catalog would list."
    answers "Which evaluator checks typing?"
  check
    runs acme-strict-typing
    scope "package"
  governance
    severity blocking
`;
it('fails ia-distribution validate, as ia validate, for a check a damaged catalog revokes alone', async () => {
  const root = resolve(scratch('equivalence-revoked'), 'workspace'),
    home = resolve(scratch('equivalence-revoked-home'), '.ia'),
    env = { ...process.env, IA_HOME: home };
  expect((await spawned(MAIN, ['init', root, '--apply', '--yes', '--json'], env)).status).toBe(0);
  expect((await spawned(MAIN, ['host', 'claude', '--root', root, '--apply', '--yes', '--json'], env)).status).toBe(0);
  const registration = JSON.parse(
      readFileSync(resolve(root, '.ia/distributions/hosts/claude-workspace.json'), 'utf8'),
    ) as { cache: string },
    machineBinary = resolve(registration.cache, 'runtime/node_modules/@inventarch/distribution/dist/cli.js');
  // Added after the host applies: ia host admits strictly, and refuses a check naming an evaluator that is not built in.
  writeFileSync(resolve(root, '.ia/src/typing.ia'), TYPING);
  const handler = resolve(
      registration.cache,
      'runtime/node_modules/@inventarch/agent-composition-system/dist/installed-read.js',
    ),
    original = readFileSync(handler);
  writeFileSync(handler, Buffer.concat([original, Buffer.from('\n// altered\n')]));
  try {
    const consumer = result(
        await spawned(MAIN, ['validate', '--root', root, '--json'], env),
        'stdout',
        1,
        'ia validate',
      ),
      machine = result(await spawned(machineBinary, ['validate', '--root', root], env), 'stdout', 1, 'ia-distribution');
    // No execution binding and no admission error: the revoked check alone fails both runs.
    expect(machine['bindings']).toEqual({ catalog: null, results: [] });
    expect(machine['status']).toBe('admitted');
    expect((machine['checks'] as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ name: 'typing-check', status: 'revoked' }),
    ]);
    expect(consumer['checks']).toEqual(machine['checks']);
  } finally {
    writeFileSync(handler, original);
  }
});
