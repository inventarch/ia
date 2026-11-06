import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { BLOCK_BEGIN, BLOCK_END, applyBootstrap, instructionBlock, planBootstrap } from '../src/bootstrap.js';
import { COPILOT_FOLDER } from '../src/hosts.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ia-bootstrap-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const put = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const LAUNCH = { command: 'npx', args: ['-y', '@inventarch/mcp-door@3.5.0'] };

it('writes the Claude block and door entry beside what the files hold, and removes exactly them', () => {
  put('CLAUDE.md', '# Project\n\nOur notes.\n');
  put('.mcp.json', '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
  const plan = planBootstrap(root, 'claude', '3.5.0');
  expect(plan.files.map(({ path, action }) => [path, action])).toEqual([
    ['CLAUDE.md', 'update'],
    ['.mcp.json', 'update'],
  ]);
  applyBootstrap(plan);
  const claude = read('CLAUDE.md');
  expect(claude.startsWith('# Project\n\nOur notes.\n\n' + BLOCK_BEGIN)).toBe(true);
  expect(claude).toContain('`ia_session`');
  expect(claude).toContain('`ia:work`, `ia:knowledge` or `ia:delivery`');
  const mcp = JSON.parse(read('.mcp.json'));
  expect(mcp.mcpServers).toEqual({ other: { command: 'x' }, ia: LAUNCH });
  expect(read('.mcp.json')).not.toContain(root);
  expect(planBootstrap(root, 'claude', '3.5.0').files.every((file) => file.action === 'unchanged')).toBe(true);
  expect(JSON.parse(planBootstrap(root, 'claude', '3.6.0').files[1]!.after!).mcpServers.ia.args[1]).toBe(
    '@inventarch/mcp-door@3.6.0',
  );
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
  expect(read('CLAUDE.md')).toBe('# Project\n\nOur notes.\n');
  expect(JSON.parse(read('.mcp.json')).mcpServers).toEqual({ other: { command: 'x' } });
});

it('writes the Codex block into AGENTS.md and a marked TOML server, and refuses a generated packet', () => {
  put('.codex/config.toml', 'model = "o3"\n');
  applyBootstrap(planBootstrap(root, 'codex', '3.5.0'));
  expect(read('AGENTS.md')).toBe(read('AGENTS.md').slice(read('AGENTS.md').indexOf(BLOCK_BEGIN)));
  const toml = parse(read('.codex/config.toml')) as { model: string; mcp_servers: Record<string, unknown> };
  expect(toml).toEqual({ model: 'o3', mcp_servers: { ia: LAUNCH } });
  applyBootstrap(planBootstrap(root, 'codex', '3.5.0', true));
  expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  expect(read('.codex/config.toml')).toBe('model = "o3"\n');
  put('AGENTS.md', `# IA position packet\n\nia-generated ${'a'.repeat(64)} ${'b'.repeat(64)} ia-codex\n`);
  expect(() => planBootstrap(root, 'codex', '3.5.0')).toThrow(/generated position packet/);
});

it('writes Copilot instructions, AGENTS.md, the VS Code server and the Copilot CLI server', () => {
  applyBootstrap(planBootstrap(root, 'copilot', '3.5.0'));
  expect(read(`${COPILOT_FOLDER}/copilot-instructions.md`)).toContain(BLOCK_END);
  expect(read('AGENTS.md')).toContain(BLOCK_BEGIN);
  expect(JSON.parse(read('.vscode/mcp.json'))).toEqual({ servers: { ia: { type: 'stdio', ...LAUNCH } } });
  expect(JSON.parse(read(`${COPILOT_FOLDER}/mcp.json`))).toEqual({
    mcpServers: { ia: { type: 'local', ...LAUNCH, tools: ['*'] } },
  });
});

it('refuses a foreign ia server, a repeated block and a version that is not exact', () => {
  put('.mcp.json', '{ "mcpServers": { "ia": { "command": "node", "args": ["x.js"] } } }');
  expect(() => planBootstrap(root, 'claude', '3.5.0')).toThrow(/not the IA door/);
  rmSync(join(root, '.mcp.json'));
  put('CLAUDE.md', `${BLOCK_BEGIN}\n${BLOCK_END}\n${BLOCK_BEGIN}\n${BLOCK_END}\n`);
  expect(() => planBootstrap(root, 'claude', '3.5.0')).toThrow(/repeated/);
  expect(() => planBootstrap(root, 'copilot', 'latest')).toThrow(/exact door version/);
});

/** The marker line both bootstraps carry, and the one parse rule that reads it. */
const MARKER_LINE =
  'ia-bootstrap v1 public-contribution=available needs-method=ia:work,ia:knowledge,ia:delivery needs-authority=declared-operations';
const MARKER = /^ia-bootstrap v1( [a-z-]+=\S+)+$/m;
/** The two halves of the loose detector a consumer of the text may apply: availability, and what needs a binding. */
const AVAILABLE = /public[- ]contribution[^\n]{0,80}available|available[^\n]{0,80}public[- ]contribution/i;
const NEEDS_BINDING = /(need|require)s?[^\n]{0,60}(bound method|binding|private authority)/i;
const claudeBlock = (): string => {
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0'));
  return read('CLAUDE.md');
};

it('the block states public contribution needs no binding, in a parseable marker line', () => {
  const block = claudeBlock();
  const marker = block.match(MARKER);
  expect(marker?.[0]).toBe(MARKER_LINE);
  expect(block).toMatch(AVAILABLE);
  expect(block).toMatch(
    /Reading, building, testing, editing and submitting a change need no binding, plugin, door or private access/,
  );
});

it('the block carries the required sentence on one line, apart from the marker', () => {
  const block = claudeBlock();
  const lines = block.split('\n');
  expect(
    lines.some((line) =>
      /^Operations that need a bound method or private authority refuse alone, naming it; everything else continues\./.test(
        line,
      ),
    ),
  ).toBe(true);
  const withoutMarker = lines.filter((line) => !MARKER.test(line)).join('\n');
  expect(withoutMarker).toMatch(NEEDS_BINDING);
  // The marker alone does not state it: the sentence has to be there in prose.
  expect(MARKER_LINE).not.toMatch(NEEDS_BINDING);
});

it('the block does not order routing unconditionally', () => {
  const block = claudeBlock();
  expect(block).not.toContain('For any task, use one lane');
  expect(block).not.toMatch(/before any other skill, plan or action/i);
  expect(block).toContain('When a task needs a method');
  expect(block).toContain('`ia_session`');
  expect(block).toContain('`ia:work`, `ia:knowledge` or `ia:delivery`');
  expect(block).toContain('If the `ia` MCP server is unavailable, continue on the public path and run `ia doctor`.');
});

it('the block names CONTRIBUTING.md when the repository has one and says so generically when not', () => {
  expect(claudeBlock()).toContain("the repository's own contributing guide");
  expect(read('CLAUDE.md')).not.toContain('CONTRIBUTING.md');
  put('CONTRIBUTING.md', '# Contributing\n');
  const plan = planBootstrap(root, 'claude', '3.5.0');
  const after = plan.files[0]!.after!;
  expect(plan.files[0]!.action).toBe('update');
  expect(after).toContain('follow `CONTRIBUTING.md`');
  expect(after).not.toContain("the repository's own contributing guide");
});

it('a block written by the previous text is updated in place, and every other byte of the file is kept', () => {
  const previous = [
    BLOCK_BEGIN,
    '## IA',
    '',
    'This repository is an IA workspace. Start each session by calling `ia_session` on the `ia` MCP server. For any task, use one lane: `ia:work`, `ia:knowledge` or `ia:delivery`.',
    BLOCK_END,
    '',
  ].join('\n');
  const head = '# Project\n\nOur notes.\n\n',
    tail = '\n## Later\n\nMore notes.\n';
  put('CLAUDE.md', head + previous + tail);
  const plan = planBootstrap(root, 'claude', '3.5.0');
  expect(plan.files[0]!.action).toBe('update');
  const after = plan.files[0]!.after!;
  expect(after.startsWith(head + BLOCK_BEGIN)).toBe(true);
  expect(after.endsWith(BLOCK_END + '\n' + tail)).toBe(true);
  expect(after).not.toContain('For any task, use one lane');
  expect(after).toMatch(MARKER);
  applyBootstrap(plan);
  expect(planBootstrap(root, 'claude', '3.5.0').files[0]!.action).toBe('unchanged');
});

const bareLf = /(?<!\r)\n/;

it('a CRLF instruction file keeps CRLF through install, update and remove, with no bare LF in the block', () => {
  const original = '# Project\r\n\r\nOur notes.\r\n';
  put('CLAUDE.md', original);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0'));
  const installed = read('CLAUDE.md');
  expect(installed.startsWith(original)).toBe(true);
  expect(installed).toContain(BLOCK_END + '\r\n');
  expect(installed).not.toMatch(bareLf);
  // An older block with a different body is replaced in place, the file's own endings kept on both sides.
  const old = [BLOCK_BEGIN, '## IA', 'old', BLOCK_END];
  const head = '# Project\r\n\r\n',
    tail = '\r\n## Later\r\n';
  put('CLAUDE.md', head + old.join('\r\n') + '\r\n' + tail);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0'));
  const updated = read('CLAUDE.md');
  expect(updated).not.toContain('\r\nold\r\n');
  expect(updated.startsWith(head + BLOCK_BEGIN + '\r\n')).toBe(true);
  expect(updated.endsWith(BLOCK_END + '\r\n' + tail)).toBe(true);
  expect(updated).not.toMatch(bareLf);
  // Removing what install appended restores the original bytes.
  put('CLAUDE.md', installed);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
  expect(read('CLAUDE.md')).toBe(original);
});

it.each([
  ['a leading CRLF blank line', '\r\n# Project\r\n'],
  ['a trailing CRLF blank line', '# Project\r\n\r\n'],
  ['CRLF first, then a bare LF ending', '# Project\r\nOur notes.\n'],
  ['LF first, then a CRLF ending', '# Project\nOur notes.\r\n'],
  ['a leading LF blank line', '\n# Project\n'],
  ['a trailing LF blank line', '# Project\n\n'],
  ['plain CRLF', '# Project\r\nOur notes.\r\n'],
  ['plain LF', '# Project\nOur notes.\n'],
])('install then remove restores the file byte for byte: %s', (_name, original) => {
  put('CLAUDE.md', original);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0'));
  expect(read('CLAUDE.md')).not.toBe(original);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
  expect(read('CLAUDE.md')).toBe(original);
});

it.each([
  ['CRLF', '\r\n'],
  ['LF', '\n'],
])("updating an LF block inside a %s file writes the closing line in the file's own ending", (_name, eol) => {
  // An LF block, as main or v3.5.0 wrote it, inside a file whose own ending is `eol`.
  put('CLAUDE.md', `# P${eol}${eol}${instructionBlock()}tail${eol}`);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0'));
  const updated = read('CLAUDE.md');
  if (eol === '\r\n') expect(updated).not.toMatch(bareLf);
  expect(updated.endsWith(`${BLOCK_END}${eol}tail${eol}`)).toBe(true);
  expect(planBootstrap(root, 'claude', '3.5.0').files[0]!.action).toBe('unchanged');
});

it.each([
  ['CRLF', '\r\n'],
  ['LF', '\n'],
])("installing on a %s file with no trailing newline appends in the file's own ending", (_name, eol) => {
  put('CLAUDE.md', `# Project${eol}Our notes.`);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0'));
  const installed = read('CLAUDE.md');
  if (eol === '\r\n') expect(installed).not.toMatch(bareLf);
  expect(installed.startsWith(`# Project${eol}Our notes.${eol}${eol}${BLOCK_BEGIN}${eol}`)).toBe(true);
});

it.each([
  ['CRLF', '\r\n'],
  ['LF', '\n'],
])('removing a block that starts a %s file also takes out the blank lines after it', (_name, eol) => {
  put('CLAUDE.md', `${instructionBlock().replace(/\n/g, eol)}${eol}# Project${eol}`);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
  expect(read('CLAUDE.md')).toBe(`# Project${eol}`);
});

it('removing a hand-placed block trims only the one separator install adds before it', () => {
  put('CLAUDE.md', '# A\n\n\n\n' + instructionBlock());
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
  expect(read('CLAUDE.md')).toBe('# A\n\n\n');
});

it('a lowercase contributing.md is not CONTRIBUTING.md, on a case-insensitive volume too', () => {
  put('contributing.md', '# Contributing\n');
  const plan = planBootstrap(root, 'claude', '3.5.0');
  expect(plan.files[0]!.after).toContain("the repository's own contributing guide");
  expect(plan.files[0]!.after).not.toContain('follow `CONTRIBUTING.md`');
});

const GENERIC = "follow the repository's own contributing guide";
const kinds: ReadonlyArray<readonly [string, () => void]> = [
  ['a directory', () => mkdirSync(join(root, 'CONTRIBUTING.md'))],
  ['a file over 1 MiB', () => put('CONTRIBUTING.md', 'x'.repeat(1024 * 1024 + 1))],
  [
    'a hard link',
    () => {
      put('guide.md', '# Contributing\n');
      linkSync(join(root, 'guide.md'), join(root, 'CONTRIBUTING.md'));
    },
  ],
];
for (const [name, make] of kinds)
  it(`installing, updating and removing never fail over a CONTRIBUTING.md that is ${name}`, () => {
    make();
    const plan = planBootstrap(root, 'claude', '3.5.0');
    expect(plan.files[0]!.after).toContain(GENERIC);
    applyBootstrap(plan);
    expect(planBootstrap(root, 'claude', '3.6.0').files[0]!.action).toBe('unchanged');
    applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

it('a CONTRIBUTING.md that is a symlink selects the generic wording', (context) => {
  put('guide.md', '# Contributing\n');
  try {
    symlinkSync(join(root, 'guide.md'), join(root, 'CONTRIBUTING.md'));
  } catch {
    context.skip();
  }
  const plan = planBootstrap(root, 'claude', '3.5.0');
  expect(plan.files[0]!.after).toContain(GENERIC);
  applyBootstrap(plan);
  applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
});

const OLD_BLOCK = [BLOCK_BEGIN, '## IA', '', 'Start each session by calling `ia_session`.', BLOCK_END].join('\n');
for (const [name, terminator] of [
  ['CRLF', '\r\n'],
  ['LF', '\n'],
  ['no terminator at the end of the file', ''],
] as const)
  it(`replacing an old block writes its closing line in the file's own ending, found as ${name}`, () => {
    const head = '# Project\n\n';
    const tail = terminator === '' ? '' : 'tail\n';
    put('CLAUDE.md', head + OLD_BLOCK + terminator + tail);
    const plan = planBootstrap(root, 'claude', '3.5.0');
    const after = plan.files[0]!.after!;
    expect(after.startsWith(head + BLOCK_BEGIN)).toBe(true);
    // The file is LF, so a CRLF terminator found after the old block comes out as LF; none at the end stays none.
    const closing = terminator === '' ? '' : '\n';
    expect(after.endsWith(`${BLOCK_END}${closing}${tail}`)).toBe(true);
    expect(after).not.toContain(`${BLOCK_END}\n\r\n`);
    expect(after).toMatch(MARKER);
    applyBootstrap(plan);
    expect(planBootstrap(root, 'claude', '3.5.0').files[0]!.action).toBe('unchanged');
    applyBootstrap(planBootstrap(root, 'claude', '3.5.0', true));
    expect(read('CLAUDE.md')).toBe('# Project\n' + tail);
  });
