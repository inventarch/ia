/**
 * #436 item 1, as revised for the review of #491. On macOS and Linux the plugin's hooks.json starts the session hook with
 * the Node recorded at render time, by absolute path and in shell form: `"<node>" "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"`.
 * Claude Code's hooks reference: a handler without `args` goes to `sh -c` on macOS and Linux, so sh runs the quoted file
 * and looks no `node` up. On Windows the handler stays the earlier `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"`:
 * the reference names Git Bash there, or PowerShell when Git Bash isn't installed, and PowerShell reads a line that opens
 * with a quoted string as an expression, not a command. Exec form (`args`) is not used, because a host without it would
 * not run the hook. The platform is injected, as the hook's Windows rules are in host-plugin.test.ts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { renderClaudePlugin } from '../src/host-plugin.js';

const input = {
  version: '0.1.0+abcdef012345',
  cliVersion: '0.1.0',
  channel: 'npm' as const,
  entry: '/opt/ia/dist/main.js',
  install: 'npm i -g @inventarch/cli@latest, then ia host claude --user --apply',
  node: process.execPath,
};
const PLACEHOLDER = '$' + '{CLAUDE_PLUGIN_ROOT}';
const NODE = '/opt/node/bin/node';
const hooksText = (node: string, platform: NodeJS.Platform): string =>
  renderClaudePlugin({ ...input, node }, platform).find((file) => file.path === 'plugins/ia/hooks/hooks.json')!.text;
const hooksOf = (node: string, platform: NodeJS.Platform) => JSON.parse(hooksText(node, platform));
// The message a refusal throws, or null when the rendering succeeds.
function thrown(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
const unqualified = (node: string) =>
  `renderClaudePlugin: node must be the fully qualified path of a Node executable, without "$` +
  `{"; got ${JSON.stringify(node)}`;
const unquotable = (node: string) =>
  `renderClaudePlugin: node must read the same inside double quotes in sh, so it holds no ", $, \`, %, !, control character, doubled backslash or final backslash; got ${JSON.stringify(node)}`;
// The hooks.json `a7e6adf7` rendered on every platform, byte for byte.
const BEFORE =
  '{\n  "hooks": {\n    "SessionStart": [\n      {\n        "matcher": "startup|clear",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "node \\"' +
  PLACEHOLDER +
  '/hooks/session-start.mjs\\"",\n            "timeout": 10\n          }\n        ]\n      }\n    ]\n  }\n}\n';

it.each(['darwin', 'linux'] as const)(
  'on %s hooks.json starts the hook in shell form with the recorded Node quoted, never a node looked up by name (#436)',
  (platform) => {
    expect(hooksOf(NODE, platform)).toStrictEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|clear',
            hooks: [{ type: 'command', command: `"${NODE}" "${PLACEHOLDER}/hooks/session-start.mjs"`, timeout: 10 }],
          },
        ],
      },
    });
  },
);

it('on Windows hooks.json keeps the earlier command byte for byte, and no Node refusal applies (#436)', () => {
  for (const node of [
    NODE,
    process.execPath,
    'C:\\Program Files\\nodejs\\node.exe',
    'node',
    '',
    `${PLACEHOLDER}/node`,
    '/opt/a"b/node',
    '/opt/a%b/node',
  ])
    expect(hooksText(node, 'win32'), node).toBe(BEFORE);
});

it('the renderer refuses a Node that is not absolute, or that the host would substitute into (#436)', () => {
  // A bare name, relative paths, an empty one, Windows paths (relative under sh) and placeholders, one of them inside an
  // absolute path: the ${ refusal comes before the character rule, so it keeps its own message.
  for (const node of [
    'node',
    'bin/node',
    './node',
    '',
    'C:\\nodejs\\node.exe',
    'C:node.exe',
    '\\node.exe',
    `${PLACEHOLDER}/node`,
    '/opt/$' + '{x}/node',
  ]) {
    expect(
      thrown(() => hooksOf(node, 'linux')),
      JSON.stringify(node),
    ).toBe(unqualified(node));
  }
});

// One row per rule, each with the paths that break it: sh reads ", $, ` and a backslash before another backslash or the
// closing quote inside double quotes; cmd.exe would expand % and !; a control character can end or hide the line.
const refused = [
  ['a double quote', ['/opt/a"b/node']],
  ['a dollar sign', ['/opt/a$b/node', '/opt/$/node']],
  ['a backtick', ['/opt/a`b/node']],
  ['a percent sign', ['/opt/a%b%/node']],
  ['an exclamation mark', ['/opt/a!b/node']],
  [
    'a control character',
    ['\n', '\r', '\t', '\u0000', '\u001f', '\u007f', '\u0080', '\u009f'].map((control) => `/opt/a${control}b/node`),
  ],
  ['a doubled backslash', ['/opt/a\\\\b/node']],
  ['a final backslash', ['/opt/node\\']],
] as const;
it.each(refused)(
  'the renderer refuses a Node path holding %s, which double quotes in sh do not keep as written (#436)',
  (_, nodes) => {
    for (const node of nodes)
      expect(
        thrown(() => hooksOf(node, 'linux')),
        JSON.stringify(node),
      ).toBe(unquotable(node));
  },
);

// The other side of each rule: U+0020 follows U+001F, ~ precedes U+007F and U+00A0 follows U+009F; a single backslash
// inside the path is literal; # and & neighbour $ and %; the rest are special to sh only outside quotes.
const ACCEPTED = "/opt/n o~\u00a0a\\b#&'()*;<>?[]^{}|=/node";
it('the renderer accepts the characters next to each refused one (#436)', () => {
  expect(hooksOf(ACCEPTED, 'linux').hooks.SessionStart[0].hooks[0].command).toBe(
    `"${ACCEPTED}" "${PLACEHOLDER}/hooks/session-start.mjs"`,
  );
});

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) {
    const rel = relative(tmpdir(), path);
    if (isAbsolute(rel) || !rel.startsWith('ia-host-plugin-node-tests-') || rel.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ia-host-plugin-node-tests-'));
  temporary.push(dir);
  return dir;
}
const healthy = JSON.stringify({
  session: { context: ['IA workspace ready.'], notice: null, nudge: null, refresh: null },
});
// The plugin as `ia host claude --user --apply` materializes it, recording `node`, with an entry that prints a healthy report.
function materialize(node: string): string {
  const dir = tempDir(),
    entry = resolve(dir, 'entry.mjs');
  writeFileSync(entry, `process.stdout.write(${JSON.stringify(healthy)});\n`);
  for (const file of renderClaudePlugin({ ...input, entry, node })) {
    mkdirSync(dirname(resolve(dir, file.path)), { recursive: true });
    writeFileSync(resolve(dir, file.path), file.text);
  }
  return resolve(dir, 'plugins/ia');
}
// A `node` the repository plants in `dir`, recording that it ran.
function plantNode(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const marker = resolve(dir, 'node-ran.txt');
  writeFileSync(resolve(dir, 'node'), `#!/bin/sh\necho planted > '${marker}'\n`);
  chmodSync(resolve(dir, 'node'), 0o755);
  return marker;
}
// The host's environment: this process's, with PATH replaced.
function hostEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (key.toLowerCase() !== 'path') env[key] = value;
  return { ...env, PATH: path };
}

// Windows keeps the earlier command, which looks node up on PATH (host plugin distribution design §6.1, residual limit),
// so this case runs on macOS and Linux only; the Windows rendering case above checks that command byte for byte.
const posixIt = it.skipIf(process.platform === 'win32');
posixIt(
  'a node planted in the project or behind a relative PATH entry never starts the hook, and sh runs the recorded Node as written (#436)',
  async () => {
    // The recorded Node sits under a directory named with the accepted characters, linked to this process's Node.
    const node = resolve(tempDir(), ACCEPTED.slice('/opt/'.length));
    mkdirSync(dirname(node), { recursive: true });
    symlinkSync(process.execPath, node);
    const root = materialize(node),
      project = tempDir(),
      elsewhere = tempDir();
    const markers = [plantNode(project), plantNode(resolve(project, 'bin'))];
    // A relative entry and an empty one, both naming the project, come before a qualified directory with no node in it.
    const env = {
      ...hostEnv(['bin', '', elsewhere].join(delimiter)),
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PROJECT_DIR: project,
    };
    const handler = JSON.parse(readFileSync(resolve(root, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0];
    expect(handler.args).toBeUndefined();
    // The host hands the command to sh -c with the placeholder substituted, or sh expands the exported variable itself.
    for (const command of [handler.command.split(PLACEHOLDER).join(root), handler.command]) {
      const result = await runBounded('/bin/sh', ['-c', command], { cwd: project, env, timeoutMs: 10_000 });
      expect(
        markers.filter((marker) => existsSync(marker)),
        command,
      ).toEqual([]);
      expect(result.status, result.timedOut ? 'timed out' : result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe('IA workspace ready.');
    }
    // The recorded Node is the linked one: its real path is this process's Node.
    expect(realpathSync(node)).toBe(realpathSync(process.execPath));
    // Control: the plant is live. Looked up by name from the project with this PATH, as the earlier command was, it runs.
    const control = await runBounded('/bin/sh', ['-c', 'node --version'], { cwd: project, env, timeoutMs: 10_000 });
    expect(
      markers.some((marker) => existsSync(marker)),
      control.timedOut ? 'timed out' : control.stderr,
    ).toBe(true);
  },
  25_000,
);
