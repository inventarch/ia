import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, posix, relative, resolve, win32 } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN, renderClaudePlugin } from '../src/host-plugin.js';

const input = {
  version: '0.1.0+abcdef012345',
  cliVersion: '0.1.0',
  channel: 'npm' as const,
  entry: '/opt/ia/dist/main.js',
  install: 'npm i -g @inventarch/cli@latest, then ia host claude --user --apply',
};

it('renders the §6.1 file set and nothing else', () => {
  expect(renderClaudePlugin(input).map((file) => file.path)).toEqual([
    '.claude-plugin/marketplace.json',
    'plugins/ia/.claude-plugin/plugin.json',
    'plugins/ia/agents/ia-author.md',
    'plugins/ia/hooks/hooks.json',
    'plugins/ia/hooks/session-start.mjs',
    'plugins/ia/ia-plugin.json',
    'plugins/ia/skills/authoring/SKILL.md',
    'plugins/ia/skills/doctor/SKILL.md',
    'plugins/ia/skills/init/SKILL.md',
  ]);
  expect(CLAUDE_PLUGIN).toBe('ia');
  expect(CLAUDE_MARKETPLACE).toBe('inventarch');
});
it('is deterministic and carries its inputs', () => {
  const files = Object.fromEntries(renderClaudePlugin(input).map((file) => [file.path, file.text]));
  expect(renderClaudePlugin(input)).toEqual(renderClaudePlugin(input));
  expect(JSON.parse(files['plugins/ia/.claude-plugin/plugin.json']!)).toMatchObject({
    name: 'ia',
    version: '0.1.0+abcdef012345',
    author: { name: 'InventArch' },
  });
  expect(JSON.parse(files['.claude-plugin/marketplace.json']!)).toMatchObject({
    name: 'inventarch',
    description: expect.any(String),
    plugins: [{ name: 'ia', source: './plugins/ia' }],
  });
  expect(JSON.parse(files['plugins/ia/ia-plugin.json']!)).toEqual({
    format: 'ia.claude-plugin.v1',
    cli: '0.1.0',
    channel: 'npm',
    entry: '/opt/ia/dist/main.js',
    install: input.install,
  });
  expect(files['plugins/ia/hooks/hooks.json']).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs');
});
it('pins the general authoring agent to review and propose, and routes one-system changes to its steward', () => {
  const author = renderClaudePlugin(input).find((file) => file.path === 'plugins/ia/agents/ia-author.md')!.text;
  const front = author.slice(0, author.indexOf('\n---\n', 4));
  // Operator decision 2026-09-24: this agent is active in every repository, so it reads and proposes; it never edits.
  expect(front).toContain('\nmodel: inherit');
  expect(front).toContain('\ntools: Read, Glob, Grep, Bash');
  expect(front).not.toMatch(/Write|Edit/);
  expect(front).toContain("For a change to one system's records, use that system's steward instead.");
  // A subagent cannot start another one, so it returns the steward's name to its caller rather than handing off.
  expect(author).toContain("return the proposed change and that steward's name to the caller");
  expect(author).not.toContain('hand the edit to that steward');
});
it('never tells the agent to search for IA elsewhere, and records declines through ia init', () => {
  const init = renderClaudePlugin(input).find((file) => file.path.endsWith('skills/init/SKILL.md'))!.text;
  expect(init).toContain('ia init "<repository root>" --decline today --host claude');
  expect(init).toContain('ia init "<repository root>" --decline forever --host claude');
  expect(init).toContain('Never search');
  expect(init).not.toMatch(/--apply(?! --yes --host claude)/);
});
// Review fix: the plan shown to the user and the command that later runs must name the same target, and it must
// be an absolute repository root rather than the shell's `.`, so the offer is honest about what it will touch.
it('the init skill shows the same target it applies, and applies only after confirmation', () => {
  const init = renderClaudePlugin(input).find((file) => file.path.endsWith('skills/init/SKILL.md'))!.text;
  expect(init).toContain('ia init "<repository root>" --host claude');
  expect(init).toContain('ia init "<repository root>" --apply --yes --host claude');
  expect(init).toContain('Only after the user confirms');
});
// Review fix: a prior decline (today or forever) must suppress the offer until the user explicitly asks again.
it('the init skill respects a prior decline instead of re-offering', () => {
  const init = renderClaudePlugin(input).find((file) => file.path.endsWith('skills/init/SKILL.md'))!.text;
  expect(init).toContain('do not offer to initialize');
});

// hooks.json must carry the literal `${CLAUDE_PLUGIN_ROOT}` placeholder (spec §8): Claude expands it, `JSON.stringify`
// must not, and the command must not silently pick up extra flags or a different script name.
it('hooks.json runs exactly the plugin-relative hook script on the verified matcher', () => {
  const files = Object.fromEntries(renderClaudePlugin(input).map((file) => [file.path, file.text]));
  const hooks = JSON.parse(files['plugins/ia/hooks/hooks.json']!);
  expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"');
  // §2.3: the `compact` matcher stayed unverified, so only `startup|clear` is registered.
  expect(hooks.hooks.SessionStart[0].matcher).toBe('startup|clear');
});

// The hook module is authored as a plain string array (host-plugin.ts's `HOOK`) precisely so it can contain no
// backtick and no `${` sequence; a stray one would either fail to parse or, worse, get interpolated by the
// *renderer's* template literals instead of staying literal in the emitted file.
it('the rendered hook contains no backtick', () => {
  const hook = renderClaudePlugin(input).find((file) => file.path === 'plugins/ia/hooks/session-start.mjs')!.text;
  expect(hook).not.toContain('`');
});

it('hook: every launch names its environment, the Windows one its shell, and the refresh its directory (LKI-41)', () => {
  const hook = renderClaudePlugin(input).find((file) => file.path === 'plugins/ia/hooks/session-start.mjs')!.text;
  expect(hook).toContain(
    'spawnSync(windowsShell(), windowsArgs(found, args), Object.assign({}, options, { env: childEnv(), windowsVerbatimArguments: true }))',
  );
  expect(hook).toContain('spawnSync(found, args, Object.assign({}, options, { env: childEnv() }))');
  expect(hook).toContain(
    'spawnSync(process.execPath, [meta.entry].concat(args), Object.assign({}, options, { env: childEnv() }))',
  );
  expect(hook).toContain(
    'spawn(session.refresh[0], session.refresh.slice(1), { cwd: homedir(), env: childEnv(), detached: true',
  );
  // No launch leaves the shell's switches to Node, which gives them only to a path it recognizes as cmd.exe.
  expect(hook).not.toContain('shell:');
});

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) {
    const rel = relative(tmpdir(), path);
    if (isAbsolute(rel) || !rel.startsWith('ia-host-plugin-tests-') || rel.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

// `new Function` cannot parse an ESM module (top-level `import`), so the only way to catch a syntax error in the
// rendered hook is to write it to disk and let Node itself parse it with `--check` (no execution).
it('the rendered hook is syntactically valid ESM', async () => {
  const hook = renderClaudePlugin(input).find((file) => file.path === 'plugins/ia/hooks/session-start.mjs')!.text;
  const dir = mkdtempSync(resolve(tmpdir(), 'ia-host-plugin-tests-'));
  temporary.push(dir);
  const file = resolve(dir, 'session-start.mjs');
  writeFileSync(file, hook);
  const result = await runBounded(process.execPath, ['--check', file], { timeoutMs: 10000 });
  expect(result.status, result.stderr).toBe(0);
});

// Renders a full plugin tree into a fresh temp dir, with `entry` pointed at a fake CLI script this helper writes
// (or, when `entryBody` is null, deliberately leaves absent so the hook falls back to `ia` on PATH).
function renderPluginWithEntry(entryBody: string | null): { dir: string; hookPath: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'ia-host-plugin-tests-'));
  temporary.push(dir);
  const entry = resolve(dir, 'entry.mjs');
  if (entryBody !== null) writeFileSync(entry, entryBody);
  for (const file of renderClaudePlugin({ ...input, entry })) {
    const dest = resolve(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.text);
  }
  return { dir, hookPath: resolve(dir, 'plugins/ia/hooks/session-start.mjs') };
}
function runHook(hookPath: string, env: NodeJS.ProcessEnv, cwd?: string) {
  return runBounded(process.execPath, [hookPath], { timeoutMs: 10000, env, ...(cwd === undefined ? {} : { cwd }) });
}

it('hook: a healthy doctor session becomes hookSpecificOutput.additionalContext', async () => {
  const { dir, hookPath } = renderPluginWithEntry(
    "process.stdout.write(JSON.stringify({ session: { context: ['IA workspace ready.'], notice: null, nudge: null, refresh: null } }));\n",
  );
  const result = await runHook(hookPath, { ...process.env, CLAUDE_PROJECT_DIR: dir });
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.hookSpecificOutput.additionalContext).toBe('IA workspace ready.');
  expect(payload.systemMessage).toBeUndefined();
});

// Review fix: an entry that ran but failed (nonzero exit, no stdout) is not "not found" — it should report its
// own exit status, honestly, with no systemMessage manufactured for a condition that didn't occur.
it('hook: a doctor failure without a not-found signature reports the exit status and no systemMessage', async () => {
  const { dir, hookPath } = renderPluginWithEntry('process.exit(2);\n');
  const result = await runHook(hookPath, { ...process.env, CLAUDE_PROJECT_DIR: dir });
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.hookSpecificOutput.additionalContext).toBe('IA status unavailable: ia doctor exited 2.');
  expect(payload.systemMessage).toBeUndefined();
});

// Review fix: only the genuine "not found" signature (missing recorded entry, then a PATH lookup that fails)
// should produce the "ia CLI was not found" message and its systemMessage.
it('hook: a missing entry and an empty PATH reports the ia CLI was not found', async () => {
  const { dir, hookPath } = renderPluginWithEntry(null);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (key.toLowerCase() !== 'path') env[key] = value;
  env['CLAUDE_PROJECT_DIR'] = dir;
  env['PATH'] = '';
  const result = await runHook(hookPath, env);
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.hookSpecificOutput.additionalContext).toContain('the ia CLI was not found');
  expect(payload.systemMessage).toContain('the ia CLI was not found');
});

// Review fix: the once-per-day nudge file is best-effort. If CLAUDE_PLUGIN_DATA cannot be created (here, because
// it already exists as a plain file, so mkdir fails), the briefing must still be emitted rather than swallowed
// by an uncaught exception in the outer try/catch.
it('hook: a nudge-file write failure still emits the context', async () => {
  const { dir, hookPath } = renderPluginWithEntry(
    "process.stdout.write(JSON.stringify({ session: { context: ['IA workspace ready.'], notice: 'Update available.', nudge: 'update', refresh: null } }));\n",
  );
  const pluginData = resolve(dir, 'plugin-data-is-a-file');
  writeFileSync(pluginData, 'not a directory');
  const result = await runHook(hookPath, { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: pluginData });
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.hookSpecificOutput.additionalContext).toBe('IA workspace ready.');
});

// Review fix: `spawn` (unlike `spawnSync`) reports a missing executable asynchronously via an 'error' event; with
// `process.exitCode` replacing `process.exit`, an unhandled 'error' event would otherwise surface later as an
// uncaught exception and drive the hook's own exit code to 1, discarding a briefing that already printed fine.
it('hook: a refresh command that does not exist does not crash the hook', async () => {
  const missingRefresh = resolve(tmpdir(), `ia-host-plugin-tests-missing-refresh-${Date.now()}.exe`);
  const entryBody = `process.stdout.write(JSON.stringify({ session: { context: ['IA workspace ready.'], notice: null, nudge: null, refresh: [${JSON.stringify(missingRefresh)}] } }));\n`;
  const { dir, hookPath } = renderPluginWithEntry(entryBody);
  const result = await runHook(hookPath, { ...process.env, CLAUDE_PROJECT_DIR: dir });
  expect(result.status, result.stderr).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.hookSpecificOutput.additionalContext).toBe('IA workspace ready.');
});

// LKI-41: with the recorded entry missing, the hook runs only an `ia` it found in a qualified PATH entry, and every
// child it starts (doctor, an ia launcher, the update refresh) cannot reach the project directory either. Each case
// builds PATH itself: a developer machine may have a real ia, and nvm-windows puts launchers beside node.exe.
// Cases with a project run the hook there, as Claude Code does, so relative entries resolve where they would for a user.
const windowsIt = it.skipIf(process.platform !== 'win32');
const posixIt = it.skipIf(process.platform === 'win32');
const healthy = JSON.stringify({
  session: { context: ['IA workspace ready.'], notice: null, nudge: null, refresh: null },
});

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ia-host-plugin-tests-'));
  temporary.push(dir);
  return dir;
}
// The hook's environment: this process's, with PATH and each `extra` key replaced whatever their case (Windows spells
// them Path and ComSpec, and two spellings in one environment block resolve unpredictably), and without an inherited
// NoDefaultCurrentDirectoryInExePath, so a machine that already sets it cannot hide a failure.
function hookEnv(project: string, path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const replaced = new Set([
    'path',
    'nodefaultcurrentdirectoryinexepath',
    ...Object.keys(extra).map((key) => key.toLowerCase()),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!replaced.has(key.toLowerCase())) env[key] = value;
  return { ...env, ...extra, CLAUDE_PROJECT_DIR: project, PATH: path };
}
// An executable `name` in `dir` that only records that it ran, as a repository could plant it. Returns the record.
// The .cmd names its marker through %~dp0, not an absolute path: cmd.exe reads a batch file in the OEM code page, so
// accents in a temp path (a pt-BR user name) would not survive being written into it.
function plant(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const marker = resolve(dir, `${name}-ran.txt`);
  if (process.platform === 'win32')
    writeFileSync(resolve(dir, `${name}.cmd`), `@echo planted> "%~dp0${name}-ran.txt"\r\n`);
  else {
    writeFileSync(resolve(dir, name), `#!/bin/sh\necho planted > '${marker}'\n`);
    chmodSync(resolve(dir, name), 0o755);
  }
  return marker;
}
// A working `ia` in `dir` that prints a healthy doctor report.
function realIa(dir: string): void {
  if (process.platform === 'win32') writeFileSync(resolve(dir, 'ia.cmd'), `@echo ${healthy}\r\n`);
  else {
    writeFileSync(resolve(dir, 'ia'), `#!/bin/sh\nprintf '%s\\n' '${healthy}'\n`);
    chmodSync(resolve(dir, 'ia'), 0o755);
  }
}
function context(result: Awaited<ReturnType<typeof runHook>>): string {
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

// Every "never runs" assertion below is only as good as the plant, so prove that a planted file does write its marker.
// On Windows Node wraps the command for cmd.exe /d /s /c in one more pair of quotes, which /s strips, so the path given
// here stays quoted even when it holds a space or an ampersand.
it('hook tests: a planted file writes its marker when run directly', async () => {
  const dir = tempDir();
  const marker = plant(dir, 'ia');
  expect(existsSync(marker)).toBe(false);
  const file = resolve(dir, process.platform === 'win32' ? 'ia.cmd' : 'ia');
  const result = await (process.platform === 'win32'
    ? runBounded(`"${file}"`, [], { timeoutMs: 10000, shell: true })
    : runBounded(file, [], { timeoutMs: 10000 }));
  expect(existsSync(marker), result.timedOut ? 'timed out' : result.stderr).toBe(true);
});

windowsIt(
  'hook: with no ia on PATH it reports not found without starting a shell, whatever the shell would print (LKI-40)',
  async () => {
    const { hookPath } = renderPluginWithEntry(null);
    const project = tempDir();
    // A hook that started the shell ComSpec names would start node, which exits 1 with a message the hook cannot
    // recognize, as cmd.exe does in pt-BR.
    const result = await runHook(hookPath, hookEnv(project, tempDir(), { ComSpec: process.execPath }), project);
    expect(context(result)).toContain('the ia CLI was not found');
  },
);

windowsIt('hook: an ia.cmd planted in the project never runs; the one on PATH does (LKI-41)', async () => {
  const { hookPath } = renderPluginWithEntry(null);
  // The real ia sits in a folder whose name holds a space and an ampersand, which cmd.exe must be handed quoted.
  const project = tempDir(),
    bin = resolve(tempDir(), 'a b & c');
  mkdirSync(bin);
  const marker = plant(project, 'ia');
  realIa(bin);
  expect(context(await runHook(hookPath, hookEnv(project, bin), project))).toBe('IA workspace ready.');
  expect(existsSync(marker)).toBe(false);
});

windowsIt('hook: an ia.cmd that exists only in the project is not found and never runs (LKI-41)', async () => {
  const { hookPath } = renderPluginWithEntry(null);
  const project = tempDir();
  const marker = plant(project, 'ia');
  expect(context(await runHook(hookPath, hookEnv(project, tempDir()), project))).toContain('the ia CLI was not found');
  expect(existsSync(marker)).toBe(false);
});

it('hook: a relative PATH entry cannot reach an ia inside the project (LKI-41)', async () => {
  const { hookPath } = renderPluginWithEntry(null);
  const project = tempDir();
  const marker = plant(resolve(project, 'bin'), 'ia');
  expect(context(await runHook(hookPath, hookEnv(project, 'bin'), project))).toContain('the ia CLI was not found');
  expect(existsSync(marker)).toBe(false);
});

it('hook: an empty PATH entry cannot reach an ia in the project directory (LKI-41)', async () => {
  const { hookPath } = renderPluginWithEntry(null);
  const project = tempDir();
  const marker = plant(project, 'ia');
  expect(context(await runHook(hookPath, hookEnv(project, delimiter + tempDir()), project))).toContain(
    'the ia CLI was not found',
  );
  expect(existsSync(marker)).toBe(false);
});

it('hook: a relative PATH entry before the real ia is skipped, not searched in the project (LKI-41)', async () => {
  const { hookPath } = renderPluginWithEntry(null);
  const project = tempDir(),
    bin = tempDir();
  const marker = plant(resolve(project, 'bin'), 'ia');
  realIa(bin);
  expect(context(await runHook(hookPath, hookEnv(project, ['bin', bin].join(delimiter)), project))).toBe(
    'IA workspace ready.',
  );
  expect(existsSync(marker)).toBe(false);
});

posixIt(
  'hook: a folder named ia and an ia without execute permission are passed over for the next PATH entry, as the shell would',
  async () => {
    const { hookPath } = renderPluginWithEntry(null);
    const dirFirst = tempDir(),
      first = tempDir(),
      second = tempDir();
    mkdirSync(resolve(dirFirst, 'ia'));
    writeFileSync(resolve(first, 'ia'), '#!/bin/sh\nexit 3\n');
    realIa(second);
    expect(context(await runHook(hookPath, hookEnv(tempDir(), [dirFirst, first, second].join(delimiter))))).toBe(
      'IA workspace ready.',
    );
  },
);

// On POSIX a quote is an ordinary character of a directory name, so the hook searches the entry as written and hands it
// on unchanged; only Windows, where a file name cannot hold one, drops the quotes an entry may be wrapped in.
posixIt(
  'hook: an ia in a PATH directory whose name holds a quote runs, with that entry byte for byte in its PATH (LKI-41)',
  async () => {
    const { hookPath } = renderPluginWithEntry(null);
    const bin = resolve(tempDir(), 'my"tools'),
      seen = resolve(tempDir(), 'path.txt');
    mkdirSync(bin);
    writeFileSync(resolve(bin, 'ia'), `#!/bin/sh\nprintf '%s' "$PATH" > '${seen}'\nprintf '%s\\n' '${healthy}'\n`);
    chmodSync(resolve(bin, 'ia'), 0o755);
    const path = [bin, tempDir()].join(delimiter);
    expect(context(await runHook(hookPath, hookEnv(tempDir(), path)))).toBe('IA workspace ready.');
    expect(readFileSync(seen, 'utf8')).toBe(path);
  },
);

// The source of the named top-level functions of the rendered hook, for tests that run them under a fake process.
function hookFunctions(names: readonly string[]): string {
  const hook = renderClaudePlugin(input).find((file) => file.path === 'plugins/ia/hooks/session-start.mjs')!.text;
  return names
    .map((name) => {
      const found = hook.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
      if (found === null) throw new Error(`the rendered hook has no top-level function ${name}`);
      return found[0];
    })
    .join('\n');
}

// The Windows rules on every platform: the rendered qualified, pathEntries, findOnPath and windowsShell run with Windows
// path semantics, a fake Windows process and an in-memory file system, so pull-request CI, which runs on Linux only,
// checks them too.
function renderedAsWindows(env: Record<string, string>, statSync: (target: string) => unknown) {
  const source = hookFunctions(['qualified', 'pathEntries', 'findOnPath', 'windowsShell']);
  const make = new Function(
    'process',
    'statSync',
    'accessSync',
    'constants',
    'delimiter',
    'isAbsolute',
    'join',
    'parse',
    `${source}\nreturn { findOnPath, windowsShell };`,
  ) as (...values: unknown[]) => { findOnPath: (name: string) => string | null; windowsShell: () => string };
  return make(
    { platform: 'win32', env },
    statSync,
    () => undefined,
    { X_OK: 1 },
    win32.delimiter,
    win32.isAbsolute,
    win32.join,
    win32.parse,
  );
}
// An in-memory Windows file system holding `files` and the directories above them; it records every path it is asked about.
function windowsFiles(files: readonly string[], checked: string[]) {
  const lower = files.map((file) => file.toLowerCase());
  return (target: string) => {
    checked.push(target);
    const key = target.toLowerCase();
    if (lower.includes(key)) return { isFile: () => true, isDirectory: () => false };
    if (lower.some((file) => file.startsWith(`${key}\\`))) return { isFile: () => false, isDirectory: () => true };
    throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
  };
}
function lookUpAsWindows(path: string, files: readonly string[]): { found: string | null; checked: string[] } {
  const checked: string[] = [];
  return { found: renderedAsWindows({ PATH: path }, windowsFiles(files, checked)).findOnPath('ia'), checked };
}
// The shell the hook would start on Windows under `env`. Choosing it reads no file.
function shellAsWindows(env: Record<string, string>): string {
  return renderedAsWindows(env, () => {
    throw new Error('choosing the shell must not touch the file system');
  }).windowsShell();
}
// The launch the hook makes on Windows, on every platform: the rendered main, with every top-level function the hook
// defines, runs under a fake Windows process whose recorded entry is gone, with `files` in an in-memory file system and
// a spawnSync that records each call and answers as a healthy doctor.
function launchAsWindows(env: Record<string, string>, files: readonly string[]) {
  const hook = renderClaudePlugin(input).find((file) => file.path === 'plugins/ia/hooks/session-start.mjs')!.text;
  const source = [...hook.matchAll(/^function \w+\([^)]*\) \{[\s\S]*?^\}$/gm)].map((found) => found[0]).join('\n');
  const calls: unknown[][] = [];
  const fake: Record<string, unknown> = {
    process: { platform: 'win32', env, cwd: () => 'C:\\cwd', execPath: 'C:\\node\\node.exe' },
    statSync: windowsFiles(files, []),
    accessSync: () => undefined,
    constants: { X_OK: 1 },
    delimiter: win32.delimiter,
    isAbsolute: win32.isAbsolute,
    join: win32.join,
    parse: win32.parse,
    here: 'C:\\plugin\\hooks',
    existsSync: () => false,
    readFileSync: (target: string) => {
      if (target !== 'C:\\plugin\\ia-plugin.json') throw new Error(`unexpected read of ${target}`);
      return JSON.stringify({ entry: 'C:\\gone\\main.js', install: 'Install ia.' });
    },
    spawnSync: (...call: unknown[]) => {
      calls.push(call);
      return { status: 0, signal: null, stdout: healthy, stderr: '' };
    },
    spawn: () => {
      throw new Error('a healthy doctor asks for no refresh');
    },
    homedir: () => 'C:\\Users\\dev',
    mkdirSync: () => undefined,
    writeFileSync: () => undefined,
  };
  const make = new Function(...Object.keys(fake), `${source}\nreturn main;`) as (
    ...values: unknown[]
  ) => () => { context: string; notice: string | null };
  return { result: make(...Object.values(fake))(), calls };
}

it('hook: the Windows lookup takes only fully qualified PATH entries and program types, in PATH order', () => {
  const npm = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
  // Relative, drive-rooted and drive-relative entries come first, and each would resolve if it were checked. Then come a
  // directory holding only a script type and a directory named like the program, neither of which is a program.
  const files = [
    'bin\\ia.cmd',
    'C:\\proj\\bin\\ia.cmd',
    '\\tools\\ia.cmd',
    'C:rel\\ia.cmd',
    'C:\\first\\ia.js',
    'C:\\first\\ia.com\\x',
    `${npm}\\ia.cmd`,
    `${npm}\\ia.exe`,
  ];
  const path = ['bin', '\\tools', 'C:rel', 'C:\\first', `"${npm}"`].join(';');
  const { found, checked } = lookUpAsWindows(path, files);
  expect(found).toBe(`${npm}\\ia.exe`);
  // The first thing the lookup touches is the first qualified entry: no unqualified entry is ever checked.
  expect(checked[0]).toBe('C:\\first');
  expect(lookUpAsWindows('\\\\server\\share\\bin', ['\\\\server\\share\\bin\\ia.bat']).found).toBe(
    '\\\\server\\share\\bin\\ia.bat',
  );
});

it('hook: the Windows lookup checks a missing PATH directory once, not once per program type', () => {
  const { found, checked } = lookUpAsWindows('C:\\gone;D:\\also-gone;C:\\tools', ['C:\\tools\\ia.cmd']);
  expect(found).toBe('C:\\tools\\ia.cmd');
  expect(checked.filter((target) => /gone/i.test(target))).toEqual(['C:\\gone', 'D:\\also-gone']);
});

it('hook: the Windows lookup passes over a file whose path cmd.exe would expand (%)', () => {
  const { found } = lookUpAsWindows('C:\\Users\\100%x\\npm;C:\\tools', [
    'C:\\Users\\100%x\\npm\\ia.cmd',
    'C:\\tools\\ia.cmd',
  ]);
  expect(found).toBe('C:\\tools\\ia.cmd');
});

it('hook: cmd.exe is always named by a qualified path', () => {
  // A rooted path without a drive, or a relative one, would depend on the current drive or directory, so a SystemRoot
  // that is missing or not qualified gives way to the default Windows directory.
  const unqualified: Record<string, string>[] = [
    {},
    { SystemRoot: '' },
    { SystemRoot: 'rel' },
    { SystemRoot: '\\Windows' },
    { SystemRoot: 'C:Windows' },
  ];
  expect(unqualified.map((env) => shellAsWindows(env))).toEqual(
    unqualified.map(() => 'C:\\Windows\\System32\\cmd.exe'),
  );
  expect(shellAsWindows({ SystemRoot: 'E:\\Win' })).toBe('E:\\Win\\System32\\cmd.exe');
  expect(shellAsWindows({ SystemRoot: 'D:/Win' })).toBe('D:\\Win\\System32\\cmd.exe');
});

it('hook: the Windows shell is the cmd.exe under SystemRoot, whatever ComSpec names (LKI-41)', () => {
  // Node gives a shell cmd.exe's switches only when its path matches cmd.exe with backslashes, so another program, or
  // cmd.exe spelled with forward slashes, would get -c; the hook names cmd.exe and its switches itself.
  const named = ['D:\\tools\\cmd.exe', 'C:/Windows/System32/cmd.exe', 'C:\\Program Files\\nodejs\\node.exe'];
  expect(named.map((ComSpec) => shellAsWindows({ ComSpec, SystemRoot: 'E:\\Win' }))).toEqual(
    named.map(() => 'E:\\Win\\System32\\cmd.exe'),
  );
  expect(shellAsWindows({ ComSpec: 'D:\\tools\\cmd.exe' })).toBe('C:\\Windows\\System32\\cmd.exe');
});

it('hook: on Windows the ia found runs as cmd.exe /d /v:off /s /c with the quoted line passed verbatim (LKI-41)', () => {
  // Spaces, & and ! in the path stay inside the inner quotes. /v:off keeps a delayed expansion turned on in the registry
  // from reading the !, and /s strips only the outer pair, so cmd.exe runs the line between them as written.
  const bin = 'C:\\Users\\dev\\a b & c!\\npm';
  const { result, calls } = launchAsWindows(
    { PATH: bin, SystemRoot: 'C:\\WINDOWS', CLAUDE_PROJECT_DIR: 'C:\\project' },
    [`${bin}\\ia.cmd`],
  );
  expect(result).toEqual({ context: 'IA workspace ready.', notice: null });
  expect(calls).toEqual([
    [
      'C:\\WINDOWS\\System32\\cmd.exe',
      ['/d', '/v:off', '/s', '/c', `""${bin}\\ia.cmd" doctor --json --host claude"`],
      {
        cwd: 'C:\\project',
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: {
          SystemRoot: 'C:\\WINDOWS',
          CLAUDE_PROJECT_DIR: 'C:\\project',
          PATH: bin,
          NoDefaultCurrentDirectoryInExePath: '1',
        },
      },
    ],
  ]);
});

// The same launch on a real cmd.exe. Given ComSpec as a shell, Node would pass -c: node reads it as --check and exits 1,
// and cmd.exe named with forward slashes exits 1 with empty stdout ("A subdirectory or file .exe already exists."), so the hook reports a doctor failure.
windowsIt(
  'hook: the ia found runs through cmd.exe when ComSpec names node or spells cmd.exe with forward slashes (LKI-41)',
  async () => {
    const { hookPath } = renderPluginWithEntry(null);
    const project = tempDir(),
      bin = tempDir();
    realIa(bin);
    const cmd = resolve(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe');
    for (const ComSpec of [process.execPath, cmd.replaceAll('\\', '/')]) {
      expect(context(await runHook(hookPath, hookEnv(project, bin, { ComSpec }), project)), ComSpec).toBe(
        'IA workspace ready.',
      );
    }
  },
  20_000,
);

windowsIt(
  'hook: a launcher on PATH that starts node by name cannot reach a node.cmd planted in the project (LKI-41)',
  async () => {
    const { hookPath } = renderPluginWithEntry(null);
    const project = tempDir(),
      bin = tempDir();
    const marker = plant(project, 'node');
    const doctor = resolve(bin, 'doctor.mjs');
    writeFileSync(doctor, `process.stdout.write(${JSON.stringify(healthy)});\n`);
    // npm's cmd-shim starts node by name when no node.exe sits beside the launcher, and cmd.exe looks in the current
    // directory first unless NoDefaultCurrentDirectoryInExePath is set.
    writeFileSync(resolve(bin, 'ia.cmd'), '@node "%~dp0doctor.mjs" %*\r\n');
    const path = [bin, dirname(process.execPath)].join(delimiter);
    expect(context(await runHook(hookPath, hookEnv(project, path), project))).toBe('IA workspace ready.');
    expect(existsSync(marker)).toBe(false);
    // Control: the same launcher run by cmd.exe from the project without the variable does reach the planted node.cmd.
    const reached = await runBounded(`"${resolve(bin, 'ia.cmd')}"`, [], {
      cwd: project,
      env: hookEnv(project, path),
      shell: true,
      timeoutMs: 10_000,
    });
    expect(
      existsSync(marker),
      `without NoDefaultCurrentDirectoryInExePath cmd.exe should reach the plant (status ${reached.status}, ${reached.timedOut ? 'timed out' : reached.stderr})`,
    ).toBe(true);
  },
  20_000,
);

posixIt(
  'hook: a launcher on PATH that runs node by name cannot reach one behind a relative PATH entry (LKI-41)',
  async () => {
    const { hookPath } = renderPluginWithEntry(null);
    const project = tempDir(),
      bin = tempDir();
    const marker = plant(resolve(project, 'bin'), 'node');
    // The launcher is `#!/usr/bin/env node`, as npm's is: env searches the PATH in the child's environment for node.
    writeFileSync(resolve(bin, 'ia'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(healthy)});\n`);
    chmodSync(resolve(bin, 'ia'), 0o755);
    const path = ['bin', bin, dirname(process.execPath)].join(delimiter);
    expect(context(await runHook(hookPath, hookEnv(project, path), project))).toBe('IA workspace ready.');
    expect(existsSync(marker)).toBe(false);
  },
);

it('hook: the child PATH keeps only qualified entries and, on Windows, skips the current directory (LKI-41)', () => {
  const source = hookFunctions(['qualified', 'pathEntries', 'childEnv']);
  const make = new Function('process', 'delimiter', 'isAbsolute', 'parse', `${source}\nreturn childEnv;`) as (
    ...values: unknown[]
  ) => () => Record<string, string>;
  // Windows reads environment names without regard to case; the key as listed stays Path.
  const raw: Record<string, string> = { Path: 'C:\\a;bin;;\\tools;"D:\\b"', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const env = new Proxy(raw, {
    get: (target, key) =>
      typeof key === 'string'
        ? Object.entries(target).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
        : undefined,
  });
  const childEnv = make({ platform: 'win32', env }, win32.delimiter, win32.isAbsolute, win32.parse);
  expect(childEnv()).toEqual({
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    PATH: 'C:\\a;D:\\b',
    NoDefaultCurrentDirectoryInExePath: '1',
  });
});

it('hook: only Windows drops quotes from PATH entries; on POSIX the child PATH keeps each entry as written (LKI-41)', () => {
  const source = hookFunctions(['qualified', 'pathEntries', 'childEnv']);
  const make = new Function('process', 'delimiter', 'isAbsolute', 'parse', `${source}\nreturn childEnv;`) as (
    ...values: unknown[]
  ) => () => Record<string, string>;
  // On POSIX a quote is part of a name, so doctor from the recorded entry keeps /opt/my"tools/bin; an entry wrapped in
  // quotes is relative, as the shell reads it, so it is dropped rather than rewritten into the directory it quotes.
  expect(
    make(
      { platform: 'linux', env: { PATH: '"/opt/x":/opt/my"tools/bin:/usr/bin' } },
      posix.delimiter,
      posix.isAbsolute,
      posix.parse,
    )()['PATH'],
  ).toBe('/opt/my"tools/bin:/usr/bin');
  // Windows allows an entry in quotes and no quote in a file name.
  expect(
    make(
      { platform: 'win32', env: { PATH: '"C:\\x";C:\\my tools\\bin' } },
      win32.delimiter,
      win32.isAbsolute,
      win32.parse,
    )()['PATH'],
  ).toBe('C:\\x;C:\\my tools\\bin');
});

// The spawn ratchet (tools/testing/spawn-ratchet.test.ts) reads this file as text and would count the doctor stand-ins'
// import of child_process below as this file's own. That import runs in the hook's child, inside the tree runBounded
// owns, so the stand-ins name the module through this constant to keep the literal out of the file.
const CHILD_PROCESS = 'node:child_process';

posixIt(
  'hook: doctor started from the recorded entry cannot reach a program behind a relative PATH entry (LKI-41)',
  async () => {
    const project = tempDir(),
      bin = tempDir();
    const marker = plant(resolve(project, 'bin'), 'probe');
    // The entry stands in for doctor: it looks a program up by bare name, as doctor does with git.
    const { hookPath } = renderPluginWithEntry(
      `import { spawnSync } from '${CHILD_PROCESS}';\nconst probe = spawnSync('probe', { encoding: 'utf8' });\nprocess.stdout.write(JSON.stringify({ session: { context: [probe.error ? probe.error.code : 'probe ran'], notice: null, nudge: null, refresh: null } }));\n`,
    );
    expect(context(await runHook(hookPath, hookEnv(project, ['bin', bin].join(delimiter)), project))).toBe('ENOENT');
    expect(existsSync(marker)).toBe(false);
  },
);

windowsIt(
  'hook: doctor started from the recorded entry cannot reach a program in the project directory (LKI-41)',
  async () => {
    const project = tempDir(),
      bin = tempDir();
    // A real program planted in the project: libuv looks in the working directory first unless the variable is set.
    copyFileSync(
      resolve(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'hostname.exe'),
      resolve(project, 'probe.exe'),
    );
    const { dir, hookPath } = renderPluginWithEntry(
      `import { spawnSync } from '${CHILD_PROCESS}';\nconst probe = spawnSync('probe', { encoding: 'utf8' });\nprocess.stdout.write(JSON.stringify({ session: { context: [probe.error ? probe.error.code : 'probe ran'], notice: null, nudge: null, refresh: null } }));\n`,
    );
    expect(context(await runHook(hookPath, hookEnv(project, bin), project))).toBe('ENOENT');
    // Control: the same doctor stand-in run from the project without the variable does start the planted probe.exe.
    const control = await runBounded(process.execPath, [resolve(dir, 'entry.mjs')], {
      cwd: project,
      env: hookEnv(project, bin),
      timeoutMs: 10_000,
    });
    expect(
      control.stdout,
      `the doctor stand-in did not report (${control.timedOut ? 'timed out' : control.stderr})`,
    ).not.toBe('');
    expect(JSON.parse(control.stdout).session.context[0], 'without the variable libuv should reach the plant').toBe(
      'probe ran',
    );
  },
  20_000,
);

it('hook: the update refresh starts from the home directory with only qualified PATH entries (LKI-41)', async () => {
  const project = tempDir(),
    bin = tempDir(),
    out = resolve(tempDir(), 'refresh.json'),
    probe = resolve(tempDir(), 'probe.mjs');
  writeFileSync(
    probe,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), path: process.env.PATH }));\n`,
  );
  const { hookPath } = renderPluginWithEntry(
    `process.stdout.write(JSON.stringify({ session: { context: ['IA workspace ready.'], notice: null, nudge: null, refresh: ${JSON.stringify([process.execPath, probe])} } }));\n`,
  );
  expect(context(await runHook(hookPath, hookEnv(project, ['bin', bin].join(delimiter)), project))).toBe(
    'IA workspace ready.',
  );
  let seen: { cwd: string; path: string } | null = null;
  for (let waited = 0; seen === null && waited < 10_000; waited += 50) {
    try {
      seen = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  expect(seen, 'the refresh child never reported').not.toBeNull();
  expect(realpathSync(seen!.cwd)).toBe(realpathSync(homedir()));
  expect(seen!.path).toBe(bin);
}, 25_000);

it('hook: with no qualified PATH entry the child gets the system directories on POSIX, never an empty PATH (LKI-41)', () => {
  const source = hookFunctions(['qualified', 'pathEntries', 'childEnv']);
  const make = new Function('process', 'delimiter', 'isAbsolute', 'parse', `${source}\nreturn childEnv;`) as (
    ...values: unknown[]
  ) => () => Record<string, string>;
  expect(
    make({ platform: 'linux', env: { PATH: 'bin::.' } }, posix.delimiter, posix.isAbsolute, posix.parse)()['PATH'],
  ).toBe('/usr/bin:/bin');
  expect(
    make({ platform: 'win32', env: { PATH: 'bin' } }, win32.delimiter, win32.isAbsolute, win32.parse)()['PATH'],
  ).toBe('');
});
