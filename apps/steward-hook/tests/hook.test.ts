import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '@inventarch/runtime';
import { runBounded } from '@tools/testing/subprocess.js';
import { evaluateHook } from '../src/main.js';

// A case may launch several built hooks and admit a disk-backed native fixture.
vi.setConfig({ testTimeout: 30_000 });

const SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000;
const root = resolve(import.meta.dirname, '../../..'),
  fixture = resolve(root, 'packages/compliance/fixtures/loop'),
  launcher = resolve(root, 'apps/steward-hook/tests/fixtures/steward-write.mjs');
const temporary: string[] = [];
function temp(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'ia-hook-tests-'));
  temporary.push(path);
  return path;
}
function event(path: string, extra: Record<string, unknown> = {}) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path }, ...extra };
}
async function run(input: unknown, base = fixture, entry = launcher, timeoutMs = SUBPROCESS) {
  const result = await runBounded(process.execPath, [entry, '--root', base], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    timeoutMs,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as {
    hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
  };
}
async function code(input: unknown, base = fixture): Promise<string | undefined> {
  return (await run(input, base)).hookSpecificOutput?.permissionDecisionReason.split(':')[0];
}
afterEach(() => {
  for (const path of temporary.splice(0)) {
    const rel = relative(tmpdir(), path);
    if (isAbsolute(rel) || !rel.startsWith('ia-hook-tests-') || rel.includes('..')) throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
it('allows the actual native steward and refuses other or fabricated actors without writing', async () => {
  const path = resolve(fixture, '.ia/src/systems/governance-system/records/sample-procedure.ia'),
    before = readFileSync(path);
  expect(await run(event(path, { agent_type: 'governance-steward', agent_id: 'fixture-subagent' }))).toEqual({});
  expect(await code(event(path, { agent_type: 'agent-steward' }))).toBe('IA-HOOK-NOT-STEWARD');
  expect(
    await code(
      event(path, {
        permission_mode: 'bypassPermissions',
        tool_input: { file_path: path, actor: 'operator', agent_type: 'governance-steward' },
      }),
    ),
  ).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
  expect(readFileSync(path)).toEqual(before);
  expect(existsSync(resolve(fixture, '.ia/.iadb'))).toBe(false);
});
it('protects every managed projection even from the owner and passes unrelated files', async () => {
  for (const path of [
    'CLAUDE.md',
    '.claude/agents/governance-steward.md',
    '.agents/skills/ia-authoring/SKILL.md',
    '.claude/skills/ia-authoring/SKILL.md',
  ])
    expect(await code(event(resolve(fixture, path), { agent_type: 'governance-steward' }))).toBe(
      'IA-HOOK-PROJECTION-MANAGED',
    );
  expect(await run(event(resolve(fixture, 'docs/ordinary.md')))).toEqual({});
});
it('completes the section12 agent-system hook row with the expected owner in the refusal', async () => {
  const path = resolve(fixture, '.ia/src/systems/agent-system/records/x.ia');
  const refused = await run(event(path, { agent_type: 'governance-steward' }));
  expect(refused.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(refused.hookSpecificOutput?.permissionDecisionReason).toContain('agent-steward');
  expect(await run(event(path, { agent_type: 'agent-steward' }))).toEqual({});
});
it('validates malformed events, unknown stewards, relative input and MultiEdit compatibility', async () => {
  expect(await code('{')).toBe('IA-HOOK-INPUT-INVALID');
  expect(await code({})).toBe('IA-HOOK-INPUT-INVALID');
  expect(await code(event(resolve(fixture, '.ia/src/systems/absent/file.ia')))).toBe('IA-HOOK-STEWARD-UNAVAILABLE');
  expect(await code(event('relative.ia', { cwd: resolve(fixture, '..') }))).toBe('IA-HOOK-PATH-UNSAFE');
  const path = '.ia/src/systems/governance-system/records/new.ia';
  expect(
    await run(
      event(path, {
        cwd: fixture,
        agent_type: 'governance-steward',
        tool_name: 'MultiEdit',
        tool_input: { file_path: path, edits: [] },
      }),
    ),
  ).toEqual({});
  expect(await code(event(resolve(fixture, path), { tool_name: 'MultiEdit' }))).toBe('IA-HOOK-INPUT-INVALID');
});
it('refuses lexical and physical aliases into protected paths, including missing descendants', async () => {
  const base = temp(),
    outside = temp();
  mkdirSync(resolve(base, '.ia/src/systems/alias'), { recursive: true });
  symlinkSync(outside, resolve(base, '.ia/src/systems/alias/linked'), 'junction');
  symlinkSync(resolve(base, '.ia/src/systems'), resolve(base, 'public-alias'), 'junction');
  expect(await code(event(resolve(base, '.ia/src/systems/alias/linked/new.ia')), base)).toBe('IA-HOOK-PATH-UNSAFE');
  expect(await code(event(resolve(base, 'public-alias/alias/new.ia')), base)).toBe('IA-HOOK-PATH-UNSAFE');
  expect(await code(event(resolve(base, '.ia/src/systems')), base)).toBe('IA-HOOK-PATH-UNSAFE');
});
it('normalizes dot segments, and case wherever the volume folds it, before ownership matching', async () => {
  let path = resolve(fixture, '.ia/src/systems/governance-system/records/../records/new.ia');
  // APFS and NTFS open the upper-case spelling as the same path (#315); elsewhere it would be another, absent path.
  if (existsSync(path.toUpperCase())) path = path.toUpperCase();
  expect(await run(event(path, { agent_type: 'governance-steward' }))).toEqual({});
});
it('runs a hook registered with another spelling of the root, and still protects what that root protects (#315)', async () => {
  // A root typed in another case used to register and then refuse every edit as an aliased root on macOS. Where the volume
  // keeps the spellings apart, that root is simply absent.
  const ordinary = resolve(fixture, 'docs/ordinary.md'),
    owned = '.ia/src/systems/governance-system/records/new.ia';
  // Another case, and on APFS another Unicode case: `\u017f` for the last `s` (#323).
  for (const spelled of [fixture.toUpperCase(), fixture.replace(/s([^s]*)$/, '\u017f$1')]) {
    if (!existsSync(spelled)) {
      expect(await code(event(ordinary), spelled)).toBe('IA-HOOK-PATH-UNSAFE');
      continue;
    }
    expect(await run(event(ordinary), spelled)).toEqual({});
    expect(await run(event(resolve(spelled, 'docs/ordinary.md')), spelled)).toEqual({});
    for (const path of [resolve(fixture, owned), resolve(spelled, owned)]) {
      expect(await code(event(path, { agent_type: 'agent-steward' }), spelled)).toBe('IA-HOOK-NOT-STEWARD');
      expect(await run(event(path, { agent_type: 'governance-steward' }), spelled)).toEqual({});
    }
    expect(await code(event(resolve(spelled, 'CLAUDE.md')), spelled)).toBe('IA-HOOK-PROJECTION-MANAGED');
  }
});
it('places a path spelled through the loopback admin share by identity, and protects it as that root does (Windows)', async () => {
  // `realpathSync.native` keeps a `\\localhost\C$\…` spelling, so no string comparison puts it under a drive-letter root, or a
  // drive-letter path under a root registered in that form; the root is found among the path's ancestors by device and inode.
  // Where the admin share is unavailable (it needs the Server service), there is no such spelling to test.
  const share = (path: string) => `\\\\localhost\\${path[0]}$${path.slice(2)}`;
  if (process.platform !== 'win32' || !existsSync(share(fixture))) return;
  const owned = resolve(fixture, '.ia/src/systems/agent-system/records/x.ia'),
    same = (path: string) => path;
  for (const [base, spell] of [
    [fixture, share],
    [share(fixture), same],
    [share(fixture), share],
  ] as const) {
    expect(await code(event(spell(owned), { agent_type: 'governance-steward' }), base)).toBe('IA-HOOK-NOT-STEWARD');
    expect(await run(event(spell(owned), { agent_type: 'agent-steward' }), base)).toEqual({});
    expect(await code(event(spell(resolve(fixture, '.ia/distributions.lock.json'))), base)).toBe(
      'IA-HOOK-PROJECTION-MANAGED',
    );
    expect(await code(event(spell(resolve(fixture, 'CLAUDE.md'))), base)).toBe('IA-HOOK-PROJECTION-MANAGED');
    expect(await run(event(spell(resolve(fixture, 'docs/ordinary.md'))), base)).toEqual({});
  }
  // A junction below the root is still an alias when the path reaches it through the share.
  const aliased = temp(),
    outside = temp();
  mkdirSync(resolve(aliased, '.ia/src/systems/alias'), { recursive: true });
  symlinkSync(outside, resolve(aliased, '.ia/src/systems/alias/linked'), 'junction');
  expect(await code(event(share(resolve(aliased, '.ia/src/systems/alias/linked/new.ia'))), aliased)).toBe(
    'IA-HOOK-PATH-UNSAFE',
  );
  expect(await run(event(share(resolve(outside, 'new.ia'))), aliased)).toEqual({});
});
it('protects a managed folder that does not exist yet when the path spells it in another case (#315)', async () => {
  // The protected prefix is matched on the physical path, whose missing tail keeps the typed case; folding it as the platform's
  // volumes fold names keeps `.CLAUDE/SKILLS/…` managed where that is `.claude/skills/…`, and on a case-sensitive APFS volume
  // too. Where names do not fold, it is another, unmanaged path.
  const base = temp(),
    folds = process.platform === 'win32' || process.platform === 'darwin';
  expect(await code(event(resolve(base, '.CLAUDE/SKILLS/new/SKILL.md')), base)).toBe(
    folds ? 'IA-HOOK-PROJECTION-MANAGED' : undefined,
  );
  expect(await code(event(resolve(base, '.claude/skills/new/SKILL.md')), base)).toBe('IA-HOOK-PROJECTION-MANAGED');
  // APFS also folds full Unicode case: `\u017f` spells `s` there, and `\u00df` spells `ss` (#323).
  const full = process.platform === 'darwin';
  for (const path of ['.claude/\u017fkills/new/SKILL.md', '.ia/di\u017ftributions/active.json'])
    expect(await code(event(resolve(base, path)), base)).toBe(full ? 'IA-HOOK-PROJECTION-MANAGED' : undefined);
  expect(existsSync(resolve(base, '.claude'))).toBe(false);
});
it('resolves a relative path where the kernel does: `..` from a linked cwd follows the link on POSIX, and not on Windows (#323)', async () => {
  const base = temp(),
    outside = temp(),
    type = process.platform === 'win32' ? 'junction' : 'dir',
    posix = process.platform !== 'win32';
  cpSync(fixture, base, { recursive: true });
  mkdirSync(resolve(base, 'sub/deep'), { recursive: true });
  symlinkSync(resolve(base, 'sub'), resolve(outside, 'link'), type);
  symlinkSync(resolve(base, 'sub/deep'), resolve(base, 'hop'), type);
  // From outside/link (base/sub), `..` is base on POSIX; Windows removes it first, which leaves outside, beyond the root.
  let cwd = resolve(outside, 'link');
  expect(await code({ ...event('../.ia/distributions.lock.json'), cwd }, base)).toBe(
    posix ? 'IA-HOOK-PROJECTION-MANAGED' : undefined,
  );
  expect(
    await code(
      { ...event('../.ia/src/systems/governance-system/records/new.ia', { agent_type: 'agent-steward' }), cwd },
      base,
    ),
  ).toBe(posix ? 'IA-HOOK-NOT-STEWARD' : undefined);
  // From base/hop (base/sub/deep), `..` is base/sub on POSIX, and base on Windows, whose lock is the managed one.
  cwd = resolve(base, 'hop');
  expect(await code({ ...event('../.ia/distributions.lock.json'), cwd }, base)).toBe(
    posix ? undefined : 'IA-HOOK-PROJECTION-MANAGED',
  );
});
it('fails closed when the exact installed launcher cannot load the built host', async () => {
  const base = temp(),
    entry = resolve(base, '.claude/hooks/steward-write.mjs');
  mkdirSync(resolve(entry, '..'), { recursive: true });
  cpSync(launcher, entry);
  expect(
    (await run(event(resolve(base, 'ordinary.md')), base, entry)).hookSpecificOutput?.permissionDecisionReason,
  ).toContain('IA-HOOK-INPUT-INVALID');
});
it('binds exact namespaced actors to a current native identity without prefix guessing', async () => {
  const base = temp();
  cpSync(fixture, base, { recursive: true });
  const db = openDatabase(base, { cache: false }),
    revision = db.revision,
    identity = db.records().find((r) => r.discriminator === 'agent' && r.name === 'governance-steward')!.identity;
  db.close();
  const map = resolve(base, 'actors.json'),
    value = { format: 'ia.steward-actors.v1', revision, actors: [{ host: 'fixture-plugin:owner', identity }] };
  writeFileSync(map, JSON.stringify(value));
  const invoke = async (actor: string) => {
    const result = await runBounded(
      process.execPath,
      [resolve(root, 'apps/steward-hook/dist/main.js'), '--root', base, '--actors', map],
      {
        input: JSON.stringify(
          event(resolve(base, '.ia/src/systems/governance-system/records/new.ia'), { agent_type: actor }),
        ),
        timeoutMs: SUBPROCESS,
      },
    );
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect(await invoke('fixture-plugin:owner')).toEqual({});
  for (const actor of ['other-plugin:owner', 'owner', 'governance-steward', 'fixture-plugin:governance-steward'])
    expect((await invoke(actor)).hookSpecificOutput.permissionDecisionReason).toContain('IA-HOOK-IDENTITY-UNAVAILABLE');
  writeFileSync(map, JSON.stringify({ ...value, actors: [...value.actors, ...value.actors] }));
  expect((await invoke('fixture-plugin:owner')).hookSpecificOutput.permissionDecisionReason).toContain(
    'IA-HOOK-STEWARD-UNAVAILABLE',
  );
  writeFileSync(map, JSON.stringify({ ...value, revision: '0'.repeat(64) }));
  expect((await invoke('fixture-plugin:owner')).hookSpecificOutput.permissionDecisionReason).toContain('stale');
  // A `link/..` spelling is refused off win32: the kernel walks it through the link, to another map than the spelling names
  // (#323). Windows removes the `..` before it follows the junction, so there the spelling names the (stale) map it reads.
  mkdirSync(resolve(base, 'elsewhere/sub'), { recursive: true });
  writeFileSync(resolve(base, 'elsewhere/actors.json'), JSON.stringify(value));
  symlinkSync(resolve(base, 'elsewhere/sub'), resolve(base, 'hop'), process.platform === 'win32' ? 'junction' : 'dir');
  const dotted = await runBounded(
    process.execPath,
    [
      resolve(root, 'apps/steward-hook/dist/main.js'),
      '--root',
      base,
      '--actors',
      `${resolve(base, 'hop')}${sep}..${sep}actors.json`,
    ],
    {
      input: JSON.stringify(
        event(resolve(base, '.ia/src/systems/governance-system/records/new.ia'), {
          agent_type: 'fixture-plugin:owner',
        }),
      ),
      timeoutMs: SUBPROCESS,
    },
  );
  expect(dotted.status).toBe(0);
  expect(JSON.parse(dotted.stdout).hookSpecificOutput.permissionDecisionReason).toContain(
    process.platform === 'win32' ? 'stale' : 'Actor map must be an absolute unaliased file',
  );
  // Another spelling of the same names is the same map: another case where the volume folds it, and forward slashes on Windows.
  writeFileSync(map, JSON.stringify(value));
  const spelled = async (actors: string) =>
    JSON.parse(
      (
        await runBounded(
          process.execPath,
          [resolve(root, 'apps/steward-hook/dist/main.js'), '--root', base, '--actors', actors],
          {
            input: JSON.stringify(
              event(resolve(base, '.ia/src/systems/governance-system/records/new.ia'), {
                agent_type: 'fixture-plugin:owner',
              }),
            ),
            timeoutMs: SUBPROCESS,
          },
        )
      ).stdout,
    );
  if (existsSync(map.toUpperCase())) expect(await spelled(map.toUpperCase())).toEqual({});
  if (process.platform === 'win32') expect(await spelled(map.replaceAll('\\', '/'))).toEqual({});
});
it('refuses direct writes to native installation state and both hosts generated surfaces', async () => {
  for (const path of [
    '.ia/distributions.lock.json',
    '.ia/distributions/active.json',
    '.ia/distributions/store/payload',
    '.codex/config.toml',
    '.codex/agents/owner.toml',
    '.agents/skills/command/SKILL.md',
    '.claude/skills/command/SKILL.md',
  ])
    expect(await code(event(resolve(fixture, path), { agent_type: 'governance-steward' }))).toBe(
      'IA-HOOK-PROJECTION-MANAGED',
    );
  expect(await code(' '.repeat(1024 * 1024 + 1))).toBe('IA-HOOK-INPUT-INVALID');
});
it.each(['.claude/rules/ia-workspace.md', 'AGENTS.md'])(
  'denies direct edits to the managed projection %s',
  async (path) => {
    expect(await code(event(resolve(fixture, path), { agent_type: 'governance-steward' }))).toBe(
      'IA-HOOK-PROJECTION-MANAGED',
    );
  },
);

it('the built launcher refuses edits to its fixed registered source controls without applying an event', async () => {
  const base = temp();
  mkdirSync(resolve(base, '.claude/hooks'), { recursive: true });
  const registered = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/steward-write.mjs`, '--root', `\${CLAUDE_PROJECT_DIR}`],
            },
          ],
        },
      ],
    },
  });
  writeFileSync(resolve(base, '.claude/settings.json'), registered);
  writeFileSync(
    resolve(base, '.claude/hooks/steward-write.mjs'),
    '// Ownership fixture; actual built launcher is invoked by run().\n',
  );
  for (const path of ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/steward-write.mjs'])
    expect(await code(event(resolve(base, path)), base), path).toBe('IA-HOOK-PROJECTION-MANAGED');
  expect(readFileSync(resolve(base, '.claude/settings.json'), 'utf8')).toBe(registered);
});

// #540: Bash, PowerShell and NotebookEdit reach the guard. Most cases run in process (`evaluateHook`) on a copy of the
// fixture; the built-launcher cases give the new refusal codes their process observation and hold the hook's 10 s timeout.
const R = '.ia/src/systems/governance-system/records/authoring-ia.ia',
  NO_IDENTITY = 'Host identity required; expected governance-steward';
const PATCH = `diff --git a/${R} b/${R}\n--- a/${R}\n+++ b/${R}\n@@ -1 +1 @@\n-x\n+y\n`;
function copy(): { base: string; outside: string } {
  const base = temp(),
    outside = temp();
  cpSync(fixture, base, { recursive: true });
  writeFileSync(resolve(base, 'fix.patch'), PATCH);
  return { base, outside };
}
/** Single quotes keep a Windows path's backslashes in both shells. */
const quoted = (path: string): string => `'${path}'`;
function shell(base: string, command: unknown, extra: Record<string, unknown> = {}, tool = 'Bash') {
  return { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: base, ...extra };
}
const reason = (output: { hookSpecificOutput?: { permissionDecisionReason: string } }): string | undefined =>
  output.hookSpecificOutput?.permissionDecisionReason;
/** The registered hook's own timeout (guardGroup, 10 s) is the ceiling for a built-launcher shell case. */
const launch = (base: string, command: string, extra: Record<string, unknown> = {}, tool = 'Bash') =>
  run(shell(base, command, extra, tool), base, launcher, 10_000);
type Row = readonly [string, (base: string, outside: string) => string];
it.each<Row>([
  ['>', () => `echo x > ${R}`],
  ['>>', () => `echo x >> ${R}`],
  ['tee', () => `echo x | tee ${R}`],
  ['cp', (_base, outside) => `cp ${quoted(resolve(outside, 'x.ia'))} ${R}`],
  ['mv', (_base, outside) => `mv ${R} ${quoted(resolve(outside, 'y.ia'))}`],
  ['rm', () => `rm ${R}`],
  ['sed -i', () => `sed -i 's/a/b/' ${R}`],
  ['node -e fs.writeFileSync', () => `node -e "require('fs').writeFileSync('${R}', 'x')"`],
  ['git checkout --', () => `git checkout -- ${R}`],
  ['git apply', () => 'git apply fix.patch'],
  ['cd, then a path relative to it', () => 'cd .ia/src/systems/governance-system && echo x > records/authoring-ia.ia'],
  ['an absolute path', (base) => `echo x > ${quoted(resolve(base, R))}`],
])('G1: denies a non-steward Bash write to a steward-owned record through %s (#540)', (_label, command) => {
  const { base, outside } = copy();
  expect(reason(evaluateHook(base, shell(base, command(base, outside))))).toBe(
    `IA-HOOK-SHELL-WRITE: Bash command writes ${R}: ${NO_IDENTITY}`,
  );
  expect(reason(evaluateHook(base, shell(base, command(base, outside), { agent_type: 'agent-steward' })))).toBe(
    `IA-HOOK-SHELL-WRITE: Bash command writes ${R}: Only governance-steward may author governance-system`,
  );
});
it.each(['.ia/distributions.lock.json', 'CLAUDE.md'])(
  'G1: denies a Bash write to %s, which ia host owns, even from a steward (#540)',
  (path) => {
    const { base } = copy();
    for (const extra of [{}, { agent_type: 'governance-steward' }])
      expect(reason(evaluateHook(base, shell(base, `echo x > ${path}`, extra)))).toBe(
        `IA-HOOK-SHELL-WRITE: Bash command writes ${path}: Use the owning command for generated state`,
      );
  },
);
it.each<Row>([
  ['Set-Content', () => `Set-Content -Path ${R} -Value x`],
  ['Add-Content with backslashes', () => `Add-Content ${R.replaceAll('/', '\\')} x`],
  ['Out-File', () => `'x' | Out-File -FilePath ${R}`],
  ['>', () => `'x' > ${R}`],
  ['Copy-Item', (_base, outside) => `Copy-Item ${quoted(resolve(outside, 'x.ia'))} ${R}`],
  ['Move-Item', () => `Move-Item ${R} ./moved.ia`],
  ['Remove-Item', () => `Remove-Item ${R}`],
])('G2: denies a non-steward PowerShell write to a steward-owned record through %s (#540)', (_label, command) => {
  const { base, outside } = copy();
  expect(reason(evaluateHook(base, shell(base, command(base, outside), {}, 'PowerShell')))).toBe(
    `IA-HOOK-SHELL-WRITE: PowerShell command writes ${R}: ${NO_IDENTITY}`,
  );
});
it('G3: judges NotebookEdit by its notebook_path as the file tools are judged (#540)', () => {
  const { base } = copy(),
    owned = '.ia/src/systems/governance-system/records/n.ipynb';
  const notebook = (path: string, extra: Record<string, unknown> = {}) =>
    evaluateHook(base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: resolve(base, path), new_source: 'x' },
      ...extra,
    });
  expect(reason(notebook(owned))).toBe(`IA-HOOK-IDENTITY-UNAVAILABLE: ${NO_IDENTITY}`);
  expect(reason(notebook(owned, { agent_type: 'agent-steward' }))).toBe(
    'IA-HOOK-NOT-STEWARD: Only governance-steward may author governance-system',
  );
  expect(notebook(owned, { agent_type: 'governance-steward' })).toEqual({});
  expect(reason(notebook('.ia/distributions/n.ipynb'))?.split(':')[0]).toBe('IA-HOOK-PROJECTION-MANAGED');
  expect(notebook('docs/n.ipynb')).toEqual({});
});
it("G4: lets a steward write its own records through either shell and nobody else's (#540)", () => {
  const { base } = copy(),
    as = (command: string, tool = 'Bash') =>
      evaluateHook(base, shell(base, command, { agent_type: 'governance-steward' }, tool));
  expect(as('echo x > .ia/src/systems/governance-system/records/new.ia')).toEqual({});
  expect(as(`sed -i 's/a/b/' ${R}`)).toEqual({});
  expect(as('Set-Content .ia/src/systems/governance-system/records/new.ia x', 'PowerShell')).toEqual({});
  const other = 'Only agent-steward may author agent-system';
  expect(reason(as('echo x > .ia/src/systems/agent-system/records/x.ia'))).toBe(
    `IA-HOOK-SHELL-WRITE: Bash command writes .ia/src/systems/agent-system/records/x.ia: ${other}`,
  );
  expect(reason(as(`cp ${R} .ia/src/systems/agent-system/records/a.ia`))).toBe(
    `IA-HOOK-SHELL-WRITE: Bash command writes .ia/src/systems/agent-system/records/a.ia: ${other}`,
  );
  expect(reason(as('Remove-Item .ia/src/systems/agent-system/records/x.ia', 'PowerShell'))).toBe(
    `IA-HOOK-SHELL-WRITE: PowerShell command writes .ia/src/systems/agent-system/records/x.ia: ${other}`,
  );
});
it.each<Row>([
  ['Bash', () => 'git status'],
  ['Bash', () => 'npm run build'],
  ['Bash', () => 'node --test'],
  ['Bash', () => 'pnpm test'],
  ['Bash', () => 'ls -la .ia/src/systems'],
  ['Bash', () => `cat ${R}`],
  ['Bash', () => `grep -n steward ${R}`],
  ['Bash', () => `head -5 ${R}`],
  ['Bash', () => `git diff -- ${R}`],
  ['Bash', () => 'git log --oneline -- .ia/src/systems'],
  ['Bash', () => "find .ia/src/systems -name '*.ia'"],
  ['Bash', (_base, outside) => `cat ${R} > ${quoted(resolve(outside, 'copy.ia'))}`],
  ['Bash', () => 'grep -rl steward .ia/src/systems | xargs cat'],
  ['Bash', () => "git add -A && git commit -m 'Regenerate CLAUDE.md'"],
  ['PowerShell', () => `Get-Content ${R}`],
  ['PowerShell', () => `Select-String -Path ${R} -Pattern steward`],
  ['PowerShell', () => 'git status'],
])('G5: lets a non-steward %s command run, case %#: an ordinary command or a read (#540)', (tool, command) => {
  const { base, outside } = copy();
  expect(evaluateHook(base, shell(base, command(base, outside), {}, tool))).toEqual({});
});
it.each([
  ['no command', {}],
  ['a number', { command: 42 }],
  ['blank text', { command: '   ' }],
  ['a NUL', { command: 'echo a\u0000b' }],
])('G7: refuses a Bash event with %s as malformed (#540)', (_label, input) => {
  const { base } = copy();
  expect(
    reason(evaluateHook(base, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input, cwd: base })),
  ).toBe('IA-HOOK-INPUT-INVALID: Expected a Bash or PowerShell command string');
});
it('G7: refuses a shell event without an absolute cwd (#540)', () => {
  const { base } = copy();
  for (const cwd of [undefined, 'relative', 42])
    expect(
      reason(
        evaluateHook(base, {
          hook_event_name: 'PreToolUse',
          tool_name: 'PowerShell',
          tool_input: { command: 'git status' },
          ...(cwd === undefined ? {} : { cwd }),
        }),
      ),
    ).toBe('IA-HOOK-INPUT-INVALID: Shell input requires an absolute cwd');
});
it.each([
  ['Bash', 'an unterminated quote', `echo "x > ${R}`, 'has an unterminated quote'],
  ['Bash', 'an unterminated command substitution', `echo $(cat ${R}`, 'has an unterminated command substitution'],
  ['Bash', 'an unterminated here-document', 'cat <<EOF\nno end', 'has an unterminated here-document'],
  ['PowerShell', 'an unterminated quote', `'x > ${R}`, 'has an unterminated quote'],
])('G7: fails closed on %s command text with %s (#540)', (tool, _label, command, detail) => {
  const { base } = copy();
  expect(reason(evaluateHook(base, shell(base, command, {}, tool)))).toBe(
    `IA-HOOK-SHELL-UNRESOLVED: ${tool} command ${detail}`,
  );
});
it('G7: analyzes nesting up to 32 levels and fails closed past it (#540)', () => {
  const { base } = copy(),
    nest = (depth: number) => `echo ${'$('.repeat(depth)}true${')'.repeat(depth)}`;
  expect(evaluateHook(base, shell(base, nest(32)))).toEqual({});
  expect(reason(evaluateHook(base, shell(base, nest(33))))).toBe(
    'IA-HOOK-SHELL-UNRESOLVED: Bash command nests deeper than 32 levels',
  );
});
it('G7: the built launcher decides worst-case shell input inside the hook timeout, at and past each bound (#540)', async () => {
  const { base, outside } = copy();
  const words = (count: number) => 'echo' + ' a'.repeat(count - 1);
  expect(await launch(base, words(65_536))).toEqual({});
  expect(reason(await launch(base, words(65_537)))).toBe(
    'IA-HOOK-SHELL-UNRESOLVED: Bash command has more than 65536 words',
  );
  const paths = (count: number) =>
    'rm' + Array.from({ length: count }, (_, at) => ' ' + quoted(resolve(outside, `f${at}`))).join('');
  expect(await launch(base, paths(4_096))).toEqual({});
  expect(reason(await launch(base, paths(4_097)))).toBe(
    'IA-HOOK-SHELL-UNRESOLVED: Bash command names more than 4096 paths',
  );
  expect(await launch(base, `echo "${'a'.repeat(900 * 1024)}"`)).toEqual({});
  expect(await launch(base, `Write-Output '${'a'.repeat(900 * 1024)}'`, {}, 'PowerShell')).toEqual({});
});
it('G1/G2: the built launcher denies a non-steward shell write with its own code and lets git status run (#540)', async () => {
  const { base } = copy();
  expect(reason(await launch(base, `echo x > ${R}`))).toBe(
    `IA-HOOK-SHELL-WRITE: Bash command writes ${R}: ${NO_IDENTITY}`,
  );
  expect(reason(await launch(base, `Remove-Item ${R}`, {}, 'PowerShell'))).toBe(
    `IA-HOOK-SHELL-WRITE: PowerShell command writes ${R}: ${NO_IDENTITY}`,
  );
  expect(reason(await launch(base, `echo "x > ${R}`))).toBe(
    'IA-HOOK-SHELL-UNRESOLVED: Bash command has an unterminated quote',
  );
  expect(await launch(base, 'git status')).toEqual({});
});
it('R2: keeps its fixed source registration and both settings layers protected under the widened matcher (#540)', async () => {
  const base = temp();
  mkdirSync(resolve(base, '.claude/hooks'), { recursive: true });
  const registered = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
          hooks: [
            {
              type: 'command',
              command: 'node',
              args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/steward-write.mjs`, '--root', `\${CLAUDE_PROJECT_DIR}`],
            },
          ],
        },
      ],
    },
  });
  writeFileSync(resolve(base, '.claude/settings.json'), registered);
  writeFileSync(
    resolve(base, '.claude/hooks/steward-write.mjs'),
    '// Ownership fixture; actual built launcher is invoked by run().\n',
  );
  for (const path of ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/steward-write.mjs'])
    expect(await code(event(resolve(base, path)), base), path).toBe('IA-HOOK-PROJECTION-MANAGED');
});
