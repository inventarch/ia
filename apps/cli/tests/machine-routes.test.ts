/**
 * Goldens over the nine frozen machine routes, cut before a second protocol version adds operations beside them.
 *
 * `packages/runtime/src/machine-protocol.ts` is byte-identical to its `v1.1.0` tag here (`git diff v1.1.0 --
 * packages/runtime/src/machine-protocol.ts` is empty), so `rows.json` is the v1.1.0 operation table. `routes.txt`
 * and `help.txt` are the built binary's bytes on `packages/compliance/fixtures/loop` before any v2 row exists.
 *
 * A route's output is not literally reproducible, so the comparison masks exactly three values and compares every
 * other byte: a scope token (`randomUUID()`, one per invocation) becomes `<token>`; the workspace revision, checked
 * against the one the db computes for the fixture, becomes `<revision>`, so a language or fixture change does not
 * move every golden; and the protocol version printed by `--help` and `--schema` becomes `<version>`, so a version
 * bump alone moves no golden. `normalize` is that definition, in one place.
 *
 * Regenerate with `pnpm --filter @inventarch/cli test -- -u` after `pnpm build`, never by hand, and explain each
 * changed line: a frozen route that changes is a breaking change for every machine consumer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { open } from '@inventarch/db';
import { MACHINE_PROTOCOL } from '@inventarch/runtime';
import { runBounded } from '@tools/testing/subprocess.js';
import { LEGACY_OPERATIONS } from '../src/commands.js';

const repository = resolve(import.meta.dirname, '../../..');
const MAIN = resolve(repository, 'apps/cli/dist/main.js');
const FIXTURE = resolve(repository, 'packages/compliance/fixtures/loop');
const FROZEN = LEGACY_OPERATIONS.length;
let revision: string;
beforeAll(() => {
  const handle = open(FIXTURE, { cache: false });
  try {
    revision = handle.revision;
  } finally {
    handle.close();
  }
});

const TOKEN = /"token":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g;
/** The masks above; nothing else in a route's bytes may vary between runs, platforms or protocol versions. */
function normalize(text: string): string {
  const version = String(MACHINE_PROTOCOL.version);
  return text
    .replace(TOKEN, '"token":"<token>"')
    .replaceAll(revision, '<revision>')
    .replaceAll(`Machine protocol v${version}:`, 'Machine protocol v<version>:')
    .replace(new RegExp(`^\\{"version":${version},`), '{"version":"<version>",');
}
const quoted = (args: readonly string[]): string =>
  args.map((arg) => (/^[\w./<>-]+$/.test(arg) ? arg : `'${arg}'`)).join(' ');
async function ia(args: readonly string[], cwd = repository) {
  const got = await runBounded(process.execPath, [MAIN, ...args], { cwd, timeoutMs: 20_000 });
  // The route's stream contract: one line on stdout, nothing on stderr, whatever the outcome.
  expect(got.stderr, quoted(args)).toBe('');
  expect(got.stdout.endsWith('\n') && !got.stdout.slice(0, -1).includes('\n'), quoted(args)).toBe(true);
  return got;
}

it('keeps the nine v1.1.0 operation rows first in the protocol table', async () => {
  const rows = MACHINE_PROTOCOL.operations.slice(0, FROZEN);
  expect(rows.map((row) => row.name)).toEqual([...LEGACY_OPERATIONS]);
  await expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot('golden/machine-v1/rows.json');
});

it('prints each frozen operation schema as its v1.1.0 row, with only the protocol version free', async () => {
  const rows = JSON.parse(readFileSync(resolve(import.meta.dirname, 'golden/machine-v1/rows.json'), 'utf8')) as {
    readonly name: string;
  }[];
  expect(rows.map((row) => row.name)).toEqual([...LEGACY_OPERATIONS]);
  for (const row of rows) {
    const got = await ia([row.name, '--schema']);
    expect(got.status, row.name).toBe(0);
    expect(normalize(got.stdout), row.name).toBe(`${JSON.stringify({ version: '<version>', ...row })}\n`);
  }
});

it('prints each frozen operation help unchanged, with only the protocol version free', async () => {
  let text = '';
  for (const operation of LEGACY_OPERATIONS) {
    const got = await runBounded(process.execPath, [MAIN, operation, '--help'], { cwd: repository, timeoutMs: 20_000 });
    expect([got.status, got.stderr], operation).toEqual([0, '']);
    text += `==> ia ${operation} --help <==\n${normalize(got.stdout)}`;
  }
  await expect(text).toMatchFileSnapshot('golden/machine-v1/help.txt');
});

it('answers the nine frozen routes byte-for-byte, scope token and revision masked', async () => {
  const fixture = '<fixture>';
  const invocations: { readonly args: readonly string[]; readonly cwd: string }[] = [
    // The three scope forms: bare (root = working directory), --root, and --params.
    { args: ['scope'], cwd: FIXTURE },
    { args: ['scope', '--root', FIXTURE], cwd: repository },
    { args: ['scope', '--params', '{}'], cwd: FIXTURE },
    // A refusal past the request check: exit 1, still one line on stdout.
    { args: ['scope', '--root', FIXTURE, '--params', '{"within":"not-issued"}'], cwd: repository },
  ];
  for (const row of MACHINE_PROTOCOL.operations.slice(0, FROZEN))
    for (const params of new Set([JSON.stringify(row.example), '{}']))
      invocations.push({ args: [row.name, '--root', FIXTURE, '--params', params], cwd: repository });
  let text = '';
  for (const { args, cwd } of invocations) {
    const got = await ia(args, cwd);
    const shown = quoted(args.map((arg) => (arg === FIXTURE ? fixture : arg)));
    expect(got.stdout, shown).not.toContain(FIXTURE);
    // Every scope these forms issue still carries a token; the mask hides its value, never its presence.
    if (args[0] === 'scope' && got.status === 0) expect(got.stdout, shown).toMatch(new RegExp(TOKEN.source));
    text += `$ ia ${shown}\nexit ${String(got.status)}\n${normalize(got.stdout)}`;
  }
  // Every revision a route printed is the fixture's own; a different one is left unmasked and fails the golden.
  expect(text).not.toMatch(/"revision":"(?!<revision>)/);
  await expect(text).toMatchFileSnapshot('golden/machine-v1/routes.txt');
}, 120_000);
