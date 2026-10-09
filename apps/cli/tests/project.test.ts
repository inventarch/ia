/**
 * `ia project` acceptance (milestone position-packet task ia-project-verb; position-and-projection §5, design items 11
 * and 12; plan amendments B1, B5, B8, B11 and B12): the plan writes nothing, `--apply` writes the packet and its
 * receipt through the writer `ia host` uses, `ia doctor` reads the receipt, a registered 1.x workspace upgrades, and
 * every refusal names one next command, its `ia project`, `ia validate` and `ia init` commands with the root as given
 * and its `ia-distribution` recoveries, and the `ia validate` an unopenable workspace names, with the resolved root.
 * Shared setup lives in host-fixture.ts; every case owns a fresh workspace and IA home.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PACKET_MARKER } from '@inventarch/runtime';
import { afterAll, expect, it, vi } from 'vitest';
import { dispatch } from '../src/consumer.js';
import { GUARD_RETIRED } from '../src/host.js';
import { quote } from '../src/render.js';
import {
  deadPid,
  doctor,
  element,
  GUARD_STATE,
  guardGroups,
  host,
  HOST_LOCK,
  initialized,
  LEGACY_FILES,
  legacyRegistration,
  lockNext,
  put,
  read,
  RECEIPT,
  row,
  STEWARD,
} from './host-fixture.js';
import { cleanup, makeHost, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup);

const project = (root: string, env: Record<string, string>, ...extra: string[]) =>
  run(['project', ...extra, '--root', root, '--json'], { env });
const human = (root: string, env: Record<string, string>, ...extra: string[]) =>
  run(['project', ...extra, '--root', root], { env });
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
/** Every file under `root` with the SHA-256 of its bytes, so a plan that wrote anything at all shows up. */
const tree = (root: string): Record<string, string> =>
  Object.fromEntries(
    (readdirSync(root, { recursive: true }) as string[])
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => statSync(resolve(root, path)).isFile())
      .sort()
      .map((path) => [path, sha(readFileSync(resolve(root, path)))]),
  );
const RULES = '.claude/rules/ia-workspace.md',
  SKILL = '.claude/skills/ia-authoring/SKILL.md';
/** The rooted command a next action names, as `quote` spells the root. */
const rooted = (command: string, root: string): string => `${command} --root ${quote(root)}`;

it('plans the claude projection and writes nothing: the entry count, the packet digest, the file plan and the guard', async () => {
  const { root, env } = await initialized();
  const before = tree(root);
  const planned = await project(root, env, 'claude');
  expect(planned.exitCode, planned.stdout).toBe(0);
  const envelope = JSON.parse(planned.stdout);
  expect(envelope).toEqual({
    version: 1,
    command: 'project',
    root: realpathSync(root),
    host: 'claude',
    apply: false,
    plan: {
      // Plan amendment B1 on a fresh init with the CLI's seven catalog rows: 26 + N, N = 11.
      entries: 37,
      packetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      files: [
        { path: RULES, action: 'create' },
        { path: SKILL, action: 'create' },
      ],
      guard: 'none',
      conflict: null,
    },
  });
  const text = await human(root, env, 'claude');
  expect(text.exitCode).toBe(0);
  const shown = flat(text.stdout);
  expect(shown).toContain('This is a preview. Nothing has been written.');
  expect(shown).toContain(`37 entries, digest ${envelope.plan.packetDigest.slice(0, 12)}`);
  expect(shown).toContain(`${RULES} create`);
  expect(shown).toContain('no steward guard to retire');
  // A long command breaks with a backslash continuation (§6.4); joined, it is the apply of this plan.
  expect(shown.replaceAll(' \\ ', ' ')).toContain(`Apply with "${rooted('ia project claude', root)} --apply --yes".`);
  // Neither the workspace nor the IA home was written: no projection, no receipt, no payload.
  expect(tree(root)).toEqual(before);
  expect(readdirSync(env.IA_HOST_HOME)).toEqual([]);
  // `ia host`'s projection element is this same plan (task ia-project-verb item 3).
  expect(element(JSON.parse((await host(root, env, 'claude')).stdout), 'projection').files).toEqual(
    envelope.plan.files,
  );
});

it('applies the packet and its receipt, which doctor reads with no drift until an authored record changes', async () => {
  const { root, env } = await initialized();
  const applied = await project(root, env, 'claude', '--apply', '--yes');
  expect(applied.exitCode, applied.stdout).toBe(0);
  const envelope = JSON.parse(applied.stdout);
  expect(envelope).toMatchObject({ command: 'project', host: 'claude', apply: true, plan: { entries: 37 } });
  // `applied` is the receipt written beside the projection state (B12), and its digests are the bytes on disk.
  const receipt = JSON.parse(read(root, RECEIPT));
  expect(envelope.applied).toEqual(receipt);
  expect(receipt).toMatchObject({
    format: 'ia.packet-receipt.v1',
    host: 'claude',
    entries: 37,
    packetDigest: envelope.plan.packetDigest,
    removed: [],
    foreign: [],
    guard: 'none',
  });
  expect(receipt.files).toEqual(
    [RULES, SKILL].map((path) => ({ path, sha256: sha(readFileSync(resolve(root, path))) })),
  );
  expect(read(root, RULES).split('\n')[0]).toBe(PACKET_MARKER);
  // The projection alone: no MCP entry, no settings, no agent file, and no host payload materialized.
  for (const path of ['.mcp.json', '.claude/settings.local.json', '.claude/agents', GUARD_STATE])
    expect(existsSync(resolve(root, path)), path).toBe(false);
  expect(readdirSync(env.IA_HOST_HOME)).toEqual([]);

  // Exit evidence: doctor shows a receipt-backed projection row with no drift, though no host is registered.
  const clean = await doctor(root, env);
  expect(clean.exitCode).toBe(0);
  expect(row(clean.checks, 'host')).toMatchObject({ status: 'info' });
  expect(row(clean.checks, 'host-claude')).toBeUndefined();
  expect(clean.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([
    {
      id: 'projection-claude',
      title: 'Projection claude',
      status: 'ok',
      detail: `No drift: the 2 files ${RECEIPT} lists are as written, and the records render the packet it names (${receipt.packetDigest.slice(0, 12)})`,
      remedy: null,
    },
  ]);
  // A plan now finds nothing to change, and so does `ia host`'s projection element, which reads the same state.
  expect(JSON.parse((await project(root, env, 'claude')).stdout).plan.files).toEqual([
    { path: RULES, action: 'unchanged' },
    { path: SKILL, action: 'unchanged' },
  ]);
  expect(element(JSON.parse((await host(root, env, 'claude')).stdout), 'projection')).toMatchObject({
    action: 'unchanged',
  });

  // Exit evidence: an edit to an authored record renders another packet, which doctor reports as outdated.
  const source = '.ia/src/workspace.ia';
  put(root, source, read(root, source).replace('any vendor.', 'any vendor, edited.'));
  const outdated = await doctor(root, env);
  expect(outdated.exitCode).toBe(0);
  expect(outdated.checks.filter((check) => check.id.startsWith('projection-claude'))).toEqual([
    expect.objectContaining({
      id: 'projection-claude-packet',
      status: 'warn',
      detail: expect.stringContaining('outdated: the current records render packet '),
      // No registration: the remedy is the projection's own apply, rooted as doctor was.
      remedy: `ia project claude --root ${quote(root)} --apply`,
    }),
  ]);
  // The remedy, run as named, clears it.
  expect((await project(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(row((await doctor(root, env)).checks, 'projection-claude')).toMatchObject({ status: 'ok' });

  // The human report is the receipt: its path, the files with their digests, and doctor next.
  const again = await human(root, env, 'claude', '--apply', '--yes');
  expect(again.exitCode).toBe(0);
  const shown = flat(again.stdout);
  expect(shown).toContain('Projected 37 entries for claude: written; not observed being read.');
  expect(shown).toContain(RECEIPT);
  expect(shown).toContain(`${RULES} sha256 ${sha(readFileSync(resolve(root, RULES))).slice(0, 12)}`);
  expect(shown).toContain(`Run "${rooted('ia doctor', root)}" for the observed projection state.`);
});

/**
 * The upgrade fixture of task replace-renderers (host-fixture.ts `legacyRegistration`): a workspace a 1.x `ia host claude
 * --apply` registered, the steward guard's group and ownership state, and a projection state listing demo-steward.md
 * with that marked file.
 */
it('upgrades a registered 1.x workspace: retires the guard, deletes the steward file and lists it in the receipt', async () => {
  const { root, env } = await initialized();
  legacyRegistration(root, env);
  put(root, '.claude/agents/x.md', 'my own agent\n');
  const before = tree(root);
  const planned = JSON.parse((await project(root, env, 'claude')).stdout);
  expect(planned.plan).toMatchObject({
    guard: 'retire',
    conflict: null,
    files: [
      { path: STEWARD, action: 'remove' },
      { path: '.claude/agents/x.md', action: 'foreign' },
      { path: RULES, action: 'update' },
      { path: SKILL, action: 'update' },
    ],
  });
  const preview = flat((await human(root, env, 'claude')).stdout);
  expect(preview).toContain('first retires the steward guard registered in .claude/settings.local.json');
  expect(preview).toContain(`${STEWARD} remove`);
  expect(tree(root)).toEqual(before);

  const applied = await human(root, env, 'claude', '--apply', '--yes');
  expect(applied.exitCode, applied.stderr).toBe(0);
  const shown = flat(applied.stdout);
  expect(shown).toContain(GUARD_RETIRED);
  expect(shown).toContain(`${STEWARD} sha256 ${sha(LEGACY_FILES[STEWARD]!).slice(0, 12)}`);
  expect(shown).toContain('Foreign, left in place');
  // The guard group and its state file are gone, the owned steward file is deleted, the unmarked one is left.
  expect(guardGroups(root)).toBe(0);
  expect(existsSync(resolve(root, GUARD_STATE))).toBe(false);
  expect(existsSync(resolve(root, STEWARD))).toBe(false);
  expect(read(root, '.claude/agents/x.md')).toBe('my own agent\n');
  expect(JSON.parse(read(root, RECEIPT))).toMatchObject({
    guard: 'retired',
    removed: [{ path: STEWARD, sha256: sha(LEGACY_FILES[STEWARD]!) }],
    foreign: ['.claude/agents/x.md'],
  });
  for (const path of [RULES, SKILL]) expect(read(root, path).split('\n'), path).toContain(PACKET_MARKER);
  // Converged: nothing is left to retire or delete.
  const again = JSON.parse((await project(root, env, 'claude', '--apply', '--yes')).stdout);
  expect(again.plan.guard).toBe('none');
  expect(again.applied).toMatchObject({ guard: 'none', removed: [], foreign: ['.claude/agents/x.md'] });
  // Doctor lists what the upgrade removed and left, and finds no drift.
  expect(
    (await doctor(root, env)).checks
      .filter((check) => check.id.startsWith('projection-claude'))
      .map((check) => check.status),
  ).toEqual(['ok', 'info']);
});

it('renders AGENTS.md and no agent file for codex, and refuses an unmarked AGENTS.md, leaving it untouched', async () => {
  const { root, env } = await initialized();
  const mine = '# My agents\n\nHand-written.\n';
  put(root, 'AGENTS.md', mine);
  const before = tree(root);
  // The plan is a successful report that names the file in the way, and plans nothing else.
  const planned = await project(root, env, 'codex');
  expect(planned.exitCode).toBe(0);
  const next = `Move or delete AGENTS.md, then run "${rooted('ia project codex', root)}".`;
  // With a conflict the apply refuses, so the plan lists no file and no guard step.
  expect(JSON.parse(planned.stdout).plan).toMatchObject({
    files: [],
    guard: null,
    conflict: { code: 'IA-DIST-LOCAL-MODIFICATION', path: 'AGENTS.md' },
  });
  const preview = flat((await human(root, env, 'codex')).stdout);
  expect(preview).toContain('IA-DIST-LOCAL-MODIFICATION Refusing unmanaged file at a managed path: AGENTS.md');
  expect(preview).toContain(next);
  expect(preview).not.toContain('Apply with');
  // The apply refuses before anything is written, naming the plan to run once the file is moved.
  const refused = await project(root, env, 'codex', '--apply', '--yes');
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    code: 'IA-DIST-LOCAL-MODIFICATION',
    where: { path: 'AGENTS.md' },
    next,
  });
  // In a terminal it refuses before the question: nothing is asked, whatever the answer would have been.
  const prompts: string[] = [];
  const asked = await run(['project', 'codex', '--apply', '--root', root], {
    env,
    interactive: true,
    answers: ['y'],
    prompts,
  });
  expect(asked.exitCode).toBe(3);
  expect(prompts).toEqual([]);
  expect(read(root, 'AGENTS.md')).toBe(mine);
  expect(tree(root)).toEqual(before);

  // Followed literally: with the file moved, the plan is clean and the apply writes the codex files only.
  put(root, 'AGENTS.local.md', mine);
  rmSync(resolve(root, 'AGENTS.md'));
  expect(JSON.parse((await project(root, env, 'codex')).stdout).plan.conflict).toBeNull();
  const applied = JSON.parse((await project(root, env, 'codex', '--apply', '--yes')).stdout);
  expect(applied.applied.files.map((file: { path: string }) => file.path)).toEqual([
    'AGENTS.md',
    '.agents/skills/ia-authoring/SKILL.md',
  ]);
  expect(read(root, 'AGENTS.md').split('\n')[0]).toBe(PACKET_MARKER);
  expect(read(root, 'AGENTS.md')).toContain('# IA position packet: demo');
  // No per-system agent and no Claude file of any kind.
  expect(existsSync(resolve(root, '.claude'))).toBe(false);
  expect(JSON.parse(read(root, '.ia/distributions/hosts/codex-receipt.json'))).toMatchObject({
    host: 'codex',
    guard: 'none',
    removed: [],
    foreign: [],
  });
});

it('refuses an unknown host, an uninitialized root and an unmarked claude file, each naming one next command', async () => {
  const { root, env } = await initialized();
  // An unknown host is usage, refused before anything is read, naming the claude plan with --root as given.
  const unknown = await project(root, env, 'emacs');
  expect(unknown.exitCode).toBe(2);
  expect(JSON.parse(unknown.stdout)).toMatchObject({
    code: 'IA-CLI-USAGE',
    next: `Run "${rooted('ia project claude', root)}" to plan the Claude projection, or name codex in its place.`,
  });
  // Cursor has no packet adapter either.
  expect((await project(root, env, 'cursor')).exitCode).toBe(2);
  // Without --root the next command carries none.
  const bare = await run(['project', 'emacs', '--json'], { env, cwd: root });
  expect(JSON.parse(bare.stdout).next).toBe(
    'Run "ia project claude" to plan the Claude projection, or name codex in its place.',
  );

  // A root with sources but no release descriptor is not initialized: the init of that directory, as it was given.
  const empty = resolve(scratch('project-empty'), 'bare');
  mkdirSync(resolve(empty, '.ia/src'), { recursive: true });
  const uninitialized = await project(empty, env, 'claude');
  expect(uninitialized.exitCode).toBe(3);
  expect(JSON.parse(uninitialized.stdout)).toMatchObject({
    code: 'IA-CLI-CONFLICT',
    where: { path: realpathSync(empty) },
    next: `Run "ia init ${quote(empty)}" first.`,
  });
  const relative = await run(['project', 'claude', '--root', 'bare', '--json'], { env, cwd: dirname(empty) });
  expect(JSON.parse(relative.stdout)).toMatchObject({ code: 'IA-CLI-CONFLICT', next: 'Run "ia init bare" first.' });
  // No workspace anywhere above the cwd: the init that previews one.
  const nowhere = await run(['project', 'claude', '--json'], { env, cwd: scratch('project-nowhere') });
  expect(nowhere.exitCode).toBe(3);
  expect(JSON.parse(nowhere.stdout).next).toBe('Run "ia init" to see what a new workspace here would contain.');

  // An unmarked file at a path the claude adapter writes: refused at that path, the plan named, the file untouched.
  put(root, RULES, 'user\n');
  const refused = await project(root, env, 'claude', '--apply', '--yes');
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DIST-LOCAL-MODIFICATION',
    where: { path: RULES },
    next: `Move or delete ${RULES}, then run "${rooted('ia project claude', root)}".`,
  });
  expect(read(root, RULES)).toBe('user\n');
  expect(existsSync(resolve(root, RECEIPT))).toBe(false);
});

it('asks before applying in a terminal, and a declined answer writes nothing', async () => {
  const { root, env } = await initialized();
  const prompts: string[] = [];
  const declined = await run(['project', 'claude', '--apply', '--root', root], {
    env,
    interactive: true,
    answers: ['n'],
    prompts,
  });
  expect(declined.exitCode).toBe(0);
  expect(prompts.at(-1)).toBe('Apply this projection? [y/N] ');
  expect(flat(prompts[0]!)).toContain(`${RULES} create`);
  expect(flat(declined.stdout)).toContain('Nothing was applied.');
  expect(existsSync(resolve(root, RULES))).toBe(false);
  const accepted = await run(['project', 'claude', '--apply', '--root', root], {
    env,
    interactive: true,
    answers: ['y'],
  });
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  expect(existsSync(resolve(root, RECEIPT))).toBe(true);
});

it('plans again at apply: a file written while the question waits is refused at its path, naming the plan', async () => {
  const { root, env } = await initialized();
  const terminal = makeHost({ env, interactive: true });
  const result = await dispatch(
    ['project', 'claude', '--apply', '--root', root],
    {
      ...terminal,
      interaction: {
        ...terminal.interaction,
        // The plan was clean; the user's own file lands at a path the adapter writes before the answer arrives.
        read: async () => {
          put(root, RULES, 'mine\n');
          return 'y';
        },
      },
    },
    () => {
      throw new Error('Unexpected machine route');
    },
    [],
  );
  expect(result.exitCode).toBe(3);
  const shown = flat(result.stderr).replaceAll(' \\ ', ' ');
  expect(shown).toContain(`${RULES} IA-DIST-LOCAL-MODIFICATION`);
  expect(shown).toContain(`→ Move or delete ${RULES}, then run "${rooted('ia project claude', root)}".`);
  expect(read(root, RULES)).toBe('mine\n');
  for (const path of [RECEIPT, SKILL]) expect(existsSync(resolve(root, path)), path).toBe(false);
});

it('refuses a pending host journal in the plan and the apply, and a held host lock at apply, naming each recovery', async () => {
  const { root, env } = await initialized();
  const journal = '.ia/distributions/hosts/pending.json';
  put(root, journal, '{}\n');
  // Given relative, the recovery still names the resolved root: ia-distribution takes only an absolute --root.
  for (const extra of [[], ['--apply', '--yes']]) {
    const refused = await run(['project', 'claude', ...extra, '--root', 'demo', '--json'], { env, cwd: dirname(root) });
    expect(refused.exitCode, extra.join(' ')).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      code: 'IA-DIST-RECOVERY-REQUIRED',
      where: { path: journal },
      next: `Run "ia-distribution recover-host --root ${quote(realpathSync(root))}", then rerun.`,
    });
  }
  expect(existsSync(resolve(root, RECEIPT))).toBe(false);
  rmSync(resolve(root, journal));

  // A held lock is no plan's concern; the apply refuses at the lock, naming the recovery that decides whether it is live.
  put(root, HOST_LOCK, JSON.stringify({ pid: deadPid() }) + '\n');
  expect((await project(root, env, 'claude')).exitCode).toBe(0);
  const busy = await project(root, env, 'claude', '--apply', '--yes');
  expect(busy.exitCode).toBe(3);
  expect(JSON.parse(busy.stdout)).toMatchObject({
    code: 'IA-DIST-INSTALL-BUSY',
    where: { path: HOST_LOCK },
    next: lockNext(realpathSync(root)),
  });
  for (const path of [RECEIPT, RULES, SKILL]) expect(existsSync(resolve(root, path)), path).toBe(false);
  // Followed literally: the recovery clears a dead holder's lock, and the apply converges.
  const { recoverHost } = await import('@inventarch/distribution/host');
  expect(recoverHost(realpathSync(root)).status).toBe('current');
  expect((await project(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  expect(existsSync(resolve(root, RECEIPT))).toBe(true);
});

it('names ia validate with the resolved root when the sources cannot be opened, as every workspace verb does', async () => {
  const { root, env } = await initialized();
  writeFileSync(resolve(root, '.ia/src/undecodable.ia'), Buffer.from([0x40, 0xff, 0xfe, 0x0a]));
  const before = tree(root);
  // Given relative, openSession's repair still names the root it resolved.
  const refused = await run(['project', 'claude', '--root', 'demo', '--json'], { env, cwd: dirname(root) });
  expect(refused.exitCode).toBe(3);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: 'IA-DB-SOURCE-UNAVAILABLE',
    next: `Repair the source named above, then run "ia validate --root ${quote(realpathSync(root))}".`,
  });
  expect(tree(root)).toEqual(before);
});

it('names ia project for a hand edit to a projection without a registration, and briefs the host as unregistered', async () => {
  const { root, env } = await initialized();
  expect((await project(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  put(root, RULES, read(root, RULES) + 'hand\n');
  const report = await run(['doctor', '--root', root, '--host', 'claude', '--json'], { env });
  expect(report.exitCode).toBe(1);
  const envelope = JSON.parse(report.stdout);
  expect(row(envelope.checks, `projection-claude:${RULES}`)).toMatchObject({
    status: 'fail',
    detail: `${RULES} changed since the projection apply wrote it; move or delete it, then run the remedy`,
    remedy: `ia project claude --root ${quote(root)} --apply`,
  });
  // No registration exists, so none is stale: §8.2's briefing says the host is not registered, as it did before.
  expect(envelope.session.notice).toBe(
    `IA: this workspace has no Claude host registration; run ia host claude --root ${quote(root)} --apply`,
  );
  expect(envelope.session.context.join(' ')).toContain('Host Claude: not registered.');
  expect(envelope.session.context.join(' ')).not.toContain('stale');
});
