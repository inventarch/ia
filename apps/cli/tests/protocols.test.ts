import { packageManagerCommand } from '../../../tools/entry/package-manager.mjs';
/**
 * Built-entrypoint qualification for the consumer, machine query and distribution protocols.
 * docs/specs/consumer-cli-contract/README.md §3 “Exit classes and protocol boundaries”, §4 “Refusals”,
 * §5 “JSON” and §6 “Terminal rendering” describe the maintained public contract.
 *
 * These cases pin the properties a consumer change can break silently: colour or a banner leaking onto a machine
 * route, a prompt appearing where no question can be answered, and `ia-distribution` acquiring consumer exit classes.
 * The environment requests colour in every way the renderer understands; machine routes must still emit none.
 *
 * Installed binaries establish JSON stdout, terminal capability handling, closed-stream handling and cancellation
 * as process bytes. tests/render.test.ts owns renderer layout; tools/docs/cli-examples.ts owns captured examples.
 * These cases do not assert columns, symbol placement or spacing.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withScope } from '@tools/testing/resources.js';
import { runBounded, spawnOwned } from '@tools/testing/subprocess.js';
import { LEGACY_OPERATIONS } from '../src/commands.js';
import { DEPRECATION } from '../src/compile.js';
import { quote } from '../src/render.js';
import { cleanup, delivery, scratch, workspace } from './workspace-fixture.js';

const repository = resolve(import.meta.dirname, '../../..');
let MAIN: string, DISTRIBUTION: string, installedRoot: string;
const FIXTURE = resolve(repository, 'packages/compliance/fixtures/loop');
beforeAll(async () => {
  const launchers = [
    process.env['npm_execpath'],
    ...[dirname(process.execPath), ...(process.env['PATH'] ?? '').split(delimiter)].flatMap((directory) =>
      [
        'node_modules/pnpm/bin/pnpm.cjs',
        'node_modules/pnpm/bin/pnpm.mjs',
        'node_modules/pnpm/pnpm',
        'node_modules/corepack/dist/pnpm.js',
        'pnpm.exe',
      ].map((path) => resolve(directory, path)),
    ),
  ];
  const pnpm = launchers.find((path): path is string => path !== undefined && existsSync(path));
  if (pnpm === undefined) throw new Error('Run the installed protocol suite through pnpm');
  const temporary = scratch('installed'),
    archives = resolve(temporary, 'archives');
  installedRoot = resolve(temporary, 'consumer with spaces');
  mkdirSync(archives);
  mkdirSync(installedRoot);
  const packages = new Map<
    string,
    {
      folder: string;
      manifest: {
        name: string;
        version: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
    }
  >();
  for (const group of ['packages', 'apps', '.ia/src/systems']) {
    const directory = resolve(repository, group);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const folder = resolve(directory, entry.name),
        path = resolve(folder, 'package.json');
      if (entry.isDirectory() && existsSync(path)) {
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        packages.set(manifest.name, { folder, manifest });
      }
    }
  }
  const selected = new Set<string>();
  const select = (name: string): void => {
    if (selected.has(name)) return;
    const pkg = packages.get(name);
    if (pkg === undefined) throw new Error(`Missing package ${name}`);
    selected.add(name);
    for (const dependency of Object.keys({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.optionalDependencies,
      ...pkg.manifest.peerDependencies,
    }))
      if (dependency.startsWith('@inventarch/')) select(dependency);
  };
  select('@inventarch/cli');
  select('@inventarch/distribution');
  const dependencies: Record<string, string> = {};
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  const packageManager = async (args: string[], cwd: string): Promise<void> => {
    const invocation = packageManagerCommand(pnpm, args);
    const got = await runBounded(invocation.command, invocation.args, { cwd, env, timeoutMs: 120_000 });
    if (got.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed in ${cwd}\n${got.stdout}${got.stderr}`);
  };
  for (const name of selected) {
    const { folder, manifest } = packages.get(name)!;
    await packageManager(['pack', '--pack-destination', archives], folder);
    dependencies[name] =
      'file:' +
      resolve(archives, `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`).replaceAll('\\', '/');
  }
  writeFileSync(
    resolve(installedRoot, 'package.json'),
    JSON.stringify({ name: 'installed-cli-protocols', private: true, type: 'module', dependencies }),
  );
  writeFileSync(
    resolve(installedRoot, 'pnpm-workspace.yaml'),
    JSON.stringify({ packages: ['.'], overrides: dependencies }, null, 2),
  );
  // --prefer-offline, not --offline: a frozen-lockfile workspace install fills the store but never the metadata
  // cache, so a fresh runner has no offline metadata to resolve the archives' third-party dependencies from.
  await packageManager(['install', '--prefer-offline', '--ignore-scripts'], installedRoot);
  MAIN = realpathSync(resolve(installedRoot, 'node_modules/@inventarch/cli/dist/main.js'));
  DISTRIBUTION = realpathSync(resolve(installedRoot, 'node_modules/@inventarch/distribution/dist/cli.js'));
  for (const binary of [MAIN, DISTRIBUTION]) {
    const path = relative(installedRoot, binary);
    expect(path.startsWith('..') || isAbsolute(path)).toBe(false);
  }
  const manifest = JSON.parse(
    readFileSync(resolve(installedRoot, 'node_modules/@inventarch/cli/package.json'), 'utf8'),
  );
  expect(manifest.bin.ia).toBe('./dist/main.js');
  expect(existsSync(resolve(installedRoot, 'node_modules/.bin', process.platform === 'win32' ? 'ia.cmd' : 'ia'))).toBe(
    true,
  );
  expect(existsSync(resolve(installedRoot, 'node_modules/@inventarch/cli/assets/vocabulary.json'))).toBe(true);
  // Workspace initialization §3 “Bundled language”: the generated, gitignored base pin travels in the packed `assets` directory like the catalogue.
  expect(existsSync(resolve(installedRoot, 'node_modules/@inventarch/cli/assets/base.json'))).toBe(true);
}, 120_000);
/** Every escape introducer, not only CSI: a banner or spinner could open with ESC, CSI, OSC or ST. */
const ESCAPE = /[\u001b\u009b\u009c\u009d]/;
/**
 * NO_COLOR unset and every colour request the renderer resolves (“Terminal rendering”) turned on. A machine route must emit no
 * colour regardless, so this environment is the one that makes a leak observable rather than hiding it.
 */
const colourful = (): NodeJS.ProcessEnv => ({ ...plain(), FORCE_COLOR: '1', TERM: 'xterm-256color' });
/** Neither asking for colour nor forbidding it, so terminal detection applies: a pipe is not a terminal. */
const plain = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  for (const name of ['NO_COLOR', 'FORCE_COLOR', 'IA_ASCII', 'IA_DEBUG']) delete env[name];
  return env;
};
const spawned = (binary: string, args: readonly string[], env = colourful()) =>
  // stdin is an empty closed pipe and neither stream is a terminal, so no question could be asked or answered.
  runBounded(process.execPath, [binary, ...args], { cwd: installedRoot, env, input: '', timeoutMs: 30_000 });
const legacy = (args: readonly string[]) => spawned(MAIN, args);
const distribution = (args: readonly string[]) => spawned(DISTRIBUTION, args);

/**
 * One JSON value and nothing else. The round trip is the strongest available form of "no decoration": a banner,
 * a trailing note, an indent or an SGR sequence anywhere in the stream breaks the byte equality even when the
 * value still parses.
 */
function oneJsonLine(stdout: string, label: string): unknown {
  expect(stdout, label).not.toMatch(ESCAPE);
  expect(stdout.endsWith('\n'), label).toBe(true);
  expect(stdout.slice(0, -1), label).not.toContain('\n');
  const value: unknown = JSON.parse(stdout);
  expect(JSON.stringify(value) + '\n', label).toBe(stdout);
  return value;
}

it('keeps the nine machine routes one undecorated JSON line under C03 exit classes', async () => {
  const classes = new Set<number>();
  for (const operation of LEGACY_OPERATIONS) {
    const got = await legacy([operation, '--root', FIXTURE, '--params', '{}']);
    expect(got.status, operation).not.toBeNull();
    // “Exit classes and protocol boundaries”: this route puts refusals on stdout, so an empty stderr is the whole of the stream contract.
    expect(got.stderr, operation).toBe('');
    const value = oneJsonLine(got.stdout, operation) as { ok: boolean; code?: string; result?: { outcome?: string } };
    expect([0, 1, 2], operation).toContain(got.status);
    // apps/cli/SPEC.md:7, stated as the rule rather than as a table of today's parameter requirements.
    const failedReport = operation === 'report' && value.ok && value.result?.outcome === 'fail';
    const expected = value.ok ? (failedReport ? 1 : 0) : value.code === 'IA-RUNTIME-REQUEST-INVALID' ? 2 : 1;
    expect(got.status, `${operation} ${String(value.code)}`).toBe(expected);
    classes.add(got.status!);
  }
  // All three classes are reached by the nine routes as invoked, so none of the branches above is unexercised.
  expect([...classes].sort()).toEqual([0, 1, 2]);
  // §3: the consumer classes never reach this route, and the one prompt surface (`--apply`) is not even a token
  // it parses — it is an unknown option, refused as C03 syntax with no question asked.
  const applied = await legacy(['scope', '--root', FIXTURE, '--apply']);
  expect(applied.status).toBe(2);
  expect(applied.stderr).toBe('');
  expect(oneJsonLine(applied.stdout, '--apply')).toMatchObject({ ok: false, code: 'IA-CLI-USAGE' });
  for (const args of [
    ['report', '--root', FIXTURE],
    ['records', '--root', resolve(FIXTURE, 'absent')],
  ]) {
    const got = await legacy(args);
    expect(got.status, args.join(' ')).toBe(1);
    expect(got.stderr, args.join(' ')).toBe('');
    oneJsonLine(got.stdout, args.join(' '));
  }
});

it('keeps ia-distribution on stdout at 0, stderr at 1, and out of exit class 2 entirely', async () => {
  // The distribution protocol: success is one JSON line on stdout with nothing on stderr.
  for (const args of [
    ['doctor', '--root', FIXTURE],
    ['list', '--root', FIXTURE],
    ['gc', '--root', FIXTURE],
  ]) {
    const got = await distribution(args);
    expect(got.status, args.join(' ')).toBe(0);
    expect(got.stderr, args.join(' ')).toBe('');
    expect(oneJsonLine(got.stdout, args.join(' '))).toHaveProperty('status');
  }
  // Exit 1 has two shapes and they are not interchangeable. A refused verdict is a result: it stays on stdout.
  const verdict = await distribution(['validate', '--root', FIXTURE]);
  expect(verdict.status).toBe(1);
  expect(verdict.stderr).toBe('');
  expect(oneJsonLine(verdict.stdout, 'validate')).toMatchObject({ status: 'refused' });
  // A raised refusal is the other: `{status, code, message}` on stderr with stdout left empty (cli.ts:11-12).
  const refusals: readonly (readonly string[])[] = [
    [],
    ['nonsense'],
    ['validate'],
    ['validate', '--root', 'relative'],
    ['validate', '--root', FIXTURE, '--bogus', 'x'],
    ['validate', '--root', FIXTURE, '--root', FIXTURE],
    ['pack'],
    ['inspect', '--root', FIXTURE, '--archive', 'absent.ia.tgz'],
    ['plan', 'remove', '--root', FIXTURE, '--id', 'fixture/absent'],
    ['plan', 'host', '--root', FIXTURE, '--host', 'emacs', '--cache', FIXTURE],
    ['apply', '--root', FIXTURE, '--plan', '.ia/work/absent.json'],
    ['restore', '--root', FIXTURE, '--offline'],
    ['format', '--root', FIXTURE, '--path', 'x', '--input', 'y'],
  ];
  for (const args of refusals) {
    const label = args.join(' ') || '(no arguments)';
    const got = await distribution(args);
    expect(got.status, label).toBe(1);
    expect(got.stdout, label).toBe('');
    const refusal = oneJsonLine(got.stderr, label) as { status: string; code: string; message: string };
    expect(refusal.status, label).toBe('refused');
    expect(refusal.code, label).toMatch(/^IA-(?:DIST|DB|RESOURCE|PROJECTION)-[A-Z-]+$/);
    expect(typeof refusal.message, label).toBe('string');
  }
  // The absence property. Every usage shape above is a class-2 condition on the consumer binary and none of them
  // is one here: `cli.ts` sets only `result.exitCode` and `runNative` returns only 0, so 2 is unreachable.
  const help = await distribution(['--help']);
  expect(help.status).toBe(0);
  expect(help.stderr).toBe('');
  expect(help.stdout).not.toMatch(ESCAPE);
  expect(help.stdout).toContain('ia-distribution');
  for (const args of [['--help'], ...refusals, ['doctor', '--root', FIXTURE], ['validate', '--root', FIXTURE]])
    expect([0, 1], args.join(' ') || '(no arguments)').toContain((await distribution(args)).status);
});

it('keeps consumer --json one parseable value with no colour, no prompt and no narration when installed', async () => {
  const root = workspace(),
    delivered = delivery(),
    empty = scratch('protocol'),
    home = resolve(scratch('protocol-home'), '.ia');
  const invocations: readonly (readonly string[])[] = [
    ['vocabulary', '--json'],
    ['vocabulary', 'check', '--schema', '--json'],
    ['init', '--json'],
    ['validate', '--root', root, '--json'],
    ['inspect', '--root', root, '--json'],
    ['format', '--root', root, '--json'],
    ['capture', '--root', root, '--json'],
    ['read', 'agent-system/binding/agent/agent-steward', '--root', root, '--json'],
    ['next', '--root', delivered, '--json'],
    ['next', '--root', root, '--json'],
    ['position', '--root', root, '--json'],
    ['position', '--shape', 'governance', '--phase', 'act', '--word', 'law', '--root', delivered, '--json'],
    ['position', '--depth', '3', '--root', root, '--json'],
    ['project', 'claude', '--root', root, '--json'],
    ['doctor', '--root', root, '--json'],
    ['install', 'fixture/foundation', '--root', root, '--offline', '--json'],
  ];
  for (const argv of invocations) {
    const label = argv.join(' ');
    // A scratch IA home keeps doctor's host plugin distribution rows off the real ~/.ia.
    const got = await runBounded(process.execPath, [MAIN, ...argv], {
      cwd: empty,
      env: { ...colourful(), IA_HOME: home },
      input: '',
      timeoutMs: 60_000,
    });
    expect(got.status, label).not.toBeNull();
    oneJsonLine(got.stdout, label);
    // “JSON” and “Terminal rendering”: in `--json` mode stderr may carry progress and notes, and no verb in this release emits
    // either but the deprecated `ia compile` (below), so the observable is that nothing narrates onto either stream —
    // including a prompt, which cannot be answered here because stdin is an empty closed pipe and neither stream is a
    // terminal.
    expect(got.stderr, label).toBe('');
    expect([0, 1, 2, 3, 4, 130], label).toContain(got.status);
  }
  // Decision compile-verb-fate: `ia compile`, the deprecated alias of `ia capture` since 2.0, writes the capture's one
  // value on stdout and its one note on stderr.
  const installed = (argv: readonly string[]) =>
    runBounded(process.execPath, [MAIN, ...argv, '--root', root, '--json'], {
      cwd: empty,
      env: colourful(),
      input: '',
      timeoutMs: 60_000,
    });
  const compiled = await installed(['compile']);
  expect(compiled.status).toBe(0);
  const aliased = oneJsonLine(compiled.stdout, 'compile') as object;
  const captured = await installed(['capture']);
  expect(Object.keys(aliased)).toEqual(Object.keys(oneJsonLine(captured.stdout, 'capture') as object));
  expect(existsSync(resolve(root, '.ia/work/snapshot/current.json'))).toBe(true);
  expect(existsSync(resolve(root, '.ia/work/compiled.json'))).toBe(false);
  expect(compiled.stderr).toBe(DEPRECATION);
  // Workspace initialization §3 “Bundled language”: the bundled base ships in the packed @inventarch/cli's `assets`, so the installed binary initializes offline.
  const initialized = await runBounded(process.execPath, [MAIN, 'init', 'fresh', '--apply', '--yes', '--json'], {
    cwd: empty,
    env: colourful(),
    input: '',
    timeoutMs: 60_000,
  });
  expect(initialized.status, initialized.stdout).toBe(0);
  expect(initialized.stderr).toBe('');
  expect((oneJsonLine(initialized.stdout, 'init --apply') as { applied: { status: string } }).applied.status).toBe(
    'initialized',
  );
  expect(existsSync(resolve(empty, 'fresh/.ia/release.json'))).toBe(true);
  // §5: the result is stdout and the narration is stderr, so a captured human run holds only the result.
  const human = await runBounded(process.execPath, [MAIN, 'validate', '--root', root], {
    cwd: empty,
    env: plain(),
    input: '',
    timeoutMs: 60_000,
  });
  expect(human.status).toBe(0);
  expect(human.stderr).toBe('');
  expect(human.stdout).not.toMatch(ESCAPE);
  expect(human.stdout).toContain('Admitted. 158 records, 0 errors, 5 warnings.');
});

it('resolves colour and symbols from the environment the installed process actually has', async () => {
  const run = (argv: readonly string[], env: NodeJS.ProcessEnv = plain()) =>
    runBounded(process.execPath, [MAIN, ...argv], { cwd: installedRoot, env, input: '', timeoutMs: 30_000 });
  const validate = ['validate', '--root', FIXTURE];
  // “Terminal rendering”: an explicit --color, or FORCE_COLOR, turns colour on even though stdout is a pipe; with
  // neither, a pipe is colourless. The positive halves are what make the suppressions below meaningful.
  expect((await run([...validate, '--color'])).stdout).toMatch(ESCAPE);
  expect((await run(validate, colourful())).stdout).toMatch(ESCAPE);
  expect((await run(validate)).stdout).not.toMatch(ESCAPE);
  // Rule 1: NO_COLOR outranks both, and an empty value counts as present.
  for (const value of ['1', ''])
    expect((await run([...validate, '--color'], { ...colourful(), NO_COLOR: value })).stdout, value).not.toMatch(
      ESCAPE,
    );
  // --no-color overrides FORCE_COLOR, and --json is colourless whatever the environment asked for.
  expect((await run([...validate, '--no-color'], colourful())).stdout).not.toMatch(ESCAPE);
  expect((await run([...validate, '--json', '--color'], colourful())).stdout).not.toMatch(ESCAPE);
  // “Terminal rendering”: --ascii and IA_ASCII select the ASCII set, independently of colour, the verdict and the exit class.
  const unicode = await run(validate),
    ascii = await run([...validate, '--ascii']),
    environment = await run(validate, { ...plain(), IA_ASCII: '1' });
  expect(ascii.stdout).toContain('[error]');
  expect(ascii.stdout).not.toContain('✖');
  expect(unicode.stdout).toContain('✖');
  expect(environment.stdout).toBe(ascii.stdout);
  expect([unicode.status, ascii.status, environment.status]).toEqual([1, 1, 1]);
});

it('treats a closed stdout as the end of output rather than as a crash', async () => {
  const closed = (argv: readonly string[]): Promise<{ code: number | null; stderr: string }> =>
    withScope(
      (scope) =>
        new Promise((settle) => {
          const child = spawnOwned(scope, 'closed-stdout child', process.execPath, [MAIN, ...argv], {
            cwd: installedRoot,
            env: colourful(),
            timeoutMs: 20_000,
          });
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
          // Stdin was `ignore` (an immediately-EOF descriptor); an ended pipe presents the same to the child.
          child.stdin.end();
          // Destroying the read end before the process writes is what `| head -1` does once its own read is done.
          child.stdout.destroy();
          child.on('close', (code) => settle({ code, stderr }));
        }),
    );
  // §5: the consumer copies apps/mcp-door/src/main.ts:27-30,35 — the handler, the `destroyed` guard, and the
  // rule that EPIPE never becomes a stack trace. Both a consumer verb and a machine route go through it.
  for (const argv of [
    ['validate', '--root', FIXTURE, '--json'],
    ['inspect', '--root', FIXTURE],
    ['records', '--root', FIXTURE, '--params', '{}'],
  ]) {
    const { code, stderr } = await closed(argv);
    expect(stderr, argv.join(' ')).toBe('');
    expect(code, argv.join(' ')).not.toBeNull();
    expect([0, 1], argv.join(' ')).toContain(code);
  }
});

// Nothing here writes inside the repository: every writable root is a temporary copy, and the fixture's own
// guard refuses to remove a directory that is not directly under the system temp root.
afterAll(cleanup);

it('cancels installed acquisition on either signal after stream cleanup, with no installation writes', async () => {
  const preload = resolve(installedRoot, 'signal-transport.mjs');
  writeFileSync(
    preload,
    `
process.on('message', signal => process.emit(signal));
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
  pull() { process.send('reading'); },
  async cancel() {
    if (process.env.IA_TEST_SECOND === '1') { process.send('cleaning'); await new Promise(() => {}); }
    process.send('cleaned'); process.disconnect();
  }
}));
`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    for (const second of [false, true]) {
      const root = scratch('signal'),
        digest = 'a'.repeat(64);
      mkdirSync(resolve(root, '.ia/work'), { recursive: true });
      writeFileSync(
        resolve(root, '.ia/work/catalog.json'),
        JSON.stringify([{ url: `https://example.invalid/${digest}.ia.tgz`, digest, withdrawn: false }]),
      );
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string; messages: unknown[] }>(
        (settle, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              pathToFileURL(preload).href,
              MAIN,
              'install',
              'fixture/foundation',
              '--root',
              root,
              '--catalog',
              '.ia/work/catalog.json',
              '--apply',
              '--yes',
              '--json',
            ],
            {
              cwd: installedRoot,
              env: { ...plain(), IA_TEST_SECOND: second ? '1' : '0' },
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            },
          );
          let stdout = '',
            stderr = '',
            sent = false;
          const messages: unknown[] = [];
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('Signal subprocess timed out'));
          }, 20_000);
          const interrupt = (): void => {
            if (process.platform === 'win32') child.send(signal);
            else child.kill(signal);
          };
          child.stdout!.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr!.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on('message', (message) => {
            messages.push(message);
            if (message === 'reading' && !sent) {
              sent = true;
              interrupt();
            }
            if (message === 'cleaning') interrupt();
          });
          child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            settle({ code, stdout, stderr, messages });
          });
        },
      );
      expect(result.code).toBe(130);
      if (second) {
        expect(result.messages).toContain('cleaning');
        expect(result.messages).not.toContain('cleaned');
        expect(result.stdout).toBe('');
      } else {
        expect(result.messages).toContain('cleaned');
        // Design row 27: the interruption names the invocation to run again, as it was typed.
        const next = `Run "ia install fixture/foundation --root ${quote(root)} --catalog .ia/work/catalog.json --apply --yes --json" again.`;
        expect(oneJsonLine(result.stdout, signal)).toMatchObject({ code: 'IA-CLI-INTERRUPTED', exit: 130, next });
        expect(result.stderr).toBe(`Interrupted. ${next}\n`);
      }
      for (const path of [
        '.ia/distributions/cache',
        '.ia/distributions/install-lock.json',
        '.ia/distributions/active.json',
        '.ia/distributions/pending.json',
        '.ia/distributions.lock.json',
      ])
        expect(existsSync(resolve(root, path)), path).toBe(false);
      expect(readdirSync(resolve(root, '.ia/work'))).toEqual(['catalog.json']);
    }
}, 90_000);
