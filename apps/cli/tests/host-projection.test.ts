/**
 * Host registration spec §4: a consumer workspace's projection, rendered from its own admitted records. It is the
 * position packet's consumer rendering (runtime R19 and R20): the target is initialized from the bundled base, so
 * every system line comes from the base's systems.
 */
import { cpSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { PACKET_MARKER } from '@inventarch/runtime';
import { sha256 } from '@inventarch/distribution/services';
import { packetCatalog } from '../src/commands.js';
import { renderProjectionFor } from '../src/host-projection.js';
import { read } from './host-fixture.js';
import { cleanup, cli, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanup, 120_000);

async function initialized(): Promise<string> {
  const root = resolve(scratch('host-projection'), 'demo');
  const result = await run(['init', root, '--apply', '--yes', '--json']);
  expect(result.exitCode, result.stdout).toBe(0);
  return root;
}
const section = (text: string, heading: string): readonly string[] =>
  text.split(`## ${heading}\n\n`)[1]!.split('\n\n')[0]!.split('\n');

it('renders a consumer workspace for claude as its position packet, with no agent file and no machine path', async () => {
  const root = await initialized();
  // SPEC `init`: the starter is the @workspace, its participant @agent and that @mandate, and no local
  // @system; no steward of an installed system is an agent either.
  expect(read(root, '.ia/src/workspace.ia')).toContain('@mandate demo-mandate');
  const { files, receipt } = renderProjectionFor(root, 'claude');
  expect(files.map((file) => file.path)).toEqual([
    '.claude/rules/ia-workspace.md',
    '.claude/skills/ia-authoring/SKILL.md',
  ]);
  for (const file of files) expect(file.text.split('\n')).toContain(PACKET_MARKER);
  const rules = files[0]!.text;
  expect(rules.startsWith(`${PACKET_MARKER}\n\n# IA position packet: demo\n`)).toBe(true);
  // The base's eleven systems (workspace initialization spec §3) are pointer lines, each with its steward and the
  // command that seats at it.
  const systems = section(rules, 'Systems');
  expect(systems).toHaveLength(11);
  for (const line of systems)
    expect(line).toMatch(
      /; steward `agent-system\/binding\/agent\/public-[a-z-]+-steward`; reach `ia position --seat floor\/definition\/system\/[a-z-]+`$/,
    );
  // The participant its mandate names is the one entry under Participants, and the seat names it as steward.
  expect(section(rules, 'Seat')[0]).toContain('steward `agent-system/binding/agent/demo`');
  expect(section(rules, 'Participants')).toEqual([
    '- `agent-system/binding/agent/demo`: The IDE agent operating in the demo workspace, any vendor.',
  ]);
  expect(section(rules, 'Mandates')).toHaveLength(1);
  // The three starter records are the captured-record tallies, one per word.
  expect(section(rules, 'Captured records')).toEqual(['- agent 1', '- mandate 1', '- workspace 1']);
  expect(
    section(rules, 'Commands')
      .slice(2)
      .map((row) => row.split(' | ')[0]),
  ).toEqual(packetCatalog().map((row) => `| \`${row.command}\``));
  expect(rules).toContain('## Host note (not part of the packet)');
  expect(rules).not.toContain(root);
  expect(rules).not.toContain(root.replaceAll('\\', '/'));
  // The receipt the render fills; the applying caller sets the rest.
  expect(receipt).toMatchObject({
    host: 'claude',
    slug: 'demo',
    cli: null,
    guard: 'none',
    writtenAt: null,
    participants: ['agent-system/binding/agent/demo'],
    mandates: ['agent-system/policy/mandate/demo-mandate'],
  });
  expect(receipt.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
  // On a fresh init: P = M = 1, the seat, N systems, T = 3 tallies, 5 intents, 4 phases, C catalog
  // rows, provenance and 3 SPEC lines.
  expect(receipt.entries).toBe(1 + 1 + 1 + systems.length + 3 + 5 + 4 + packetCatalog().length + 1 + 3);
  // The seven KB mode rows make C = 16, so a fresh init renders 35 + N = 46.
  expect(packetCatalog()).toHaveLength(16);
  expect(receipt.entries).toBe(46);
});

it('admits the composition fixture over the bundled base, and renders its generated set beside the packet', async () => {
  // The fixture is this initialization's starter and descriptor, byte for byte, with an authored @agent-profile, its
  // @agent, @voice and @capability, the @operation that capability names, an authored @playbook with cells in all
  // four phases, and an authored @hook. The render holds the host set generated once from those records.
  const root = await initialized(),
    fixture = resolve(cli, 'tests/fixtures/composition-workspace');
  for (const path of ['.ia/src/workspace.ia', '.ia/release.json'])
    expect(read(fixture, path), path).toBe(read(root, path));
  cpSync(fixture, root, { recursive: true });
  // The capability made invocable under the playbook's name: its skill is the one generated skill (C′).
  const composition = resolve(root, '.ia/src/composition.ia');
  writeFileSync(
    composition,
    read(root, '.ia/src/composition.ia')
      .replaceAll('@capability note-reading', '@capability note-review')
      .replace('    effects [read]\n', '    effects [read]\n  invocation\n    mode model\n'),
  );
  const validated = await run(['validate', '--root', root, '--json']);
  expect(validated.exitCode, validated.stdout).toBe(0);
  expect(JSON.parse(validated.stdout)).toMatchObject({ status: 'admitted', counts: { errors: 0 } });
  const claude = renderProjectionFor(root, 'claude'),
    profile = 'agent-composition-system/binding/agent-profile/reviewer',
    capability = 'agent-composition-system/definition/capability/note-review',
    hook = 'hook-authoring-system/binding/hook/note-edits';
  expect(claude.files.map((file) => file.path)).toEqual([
    '.claude/rules/ia-workspace.md',
    '.claude/skills/ia-authoring/SKILL.md',
    '.claude/agents/reviewer.md',
    '.claude/skills/note-review/SKILL.md',
  ]);
  for (const file of claude.files) expect(file.text.split('\n'), file.path).toContain(PACKET_MARKER);
  const digestOf = (path: string) => sha256(claude.files.find((file) => file.path === path)!.text);
  expect(claude.receipt.files.map((file) => file.path)).toEqual(claude.files.map((file) => file.path));
  expect(claude.receipt.generated).toEqual([
    {
      identity: profile,
      word: 'agent-profile',
      path: '.claude/agents/reviewer.md',
      sha256: digestOf('.claude/agents/reviewer.md'),
    },
    {
      identity: capability,
      word: 'capability',
      path: '.claude/skills/note-review/SKILL.md',
      sha256: digestOf('.claude/skills/note-review/SKILL.md'),
    },
  ]);
  expect(claude.receipt.unsupported).toEqual([]);
  expect(claude.hooks?.map((row) => [row.identity, row.tools])).toEqual([[hook, ['Write', 'Edit', 'MultiEdit']]]);
  // Definitions only: the operation's handler and validators are catalog keys, and the harness registers this set.
  expect(claude.receipt.definitions?.map((row) => [row.word, row.identity])).toEqual([
    ['operation', 'authoring-system/binding/operation/read-note'],
    ['harness', 'agent-composition-system/definition/harness/note-workspace'],
  ]);
  expect(claude.receipt.definitions?.[0]?.definition).toMatchObject({
    handler: 'read-note-v1',
    input: 'read-note-input-v1',
    output: 'read-note-output-v1',
  });
  // Codex takes the packet and the skill; the agent and the hook are reported, never written.
  const codex = renderProjectionFor(root, 'codex');
  expect(codex.files.map((file) => file.path)).toEqual([
    'AGENTS.md',
    '.agents/skills/ia-authoring/SKILL.md',
    '.agents/skills/note-review/SKILL.md',
  ]);
  expect(codex.hooks).toEqual([]);
  expect(codex.receipt.unsupported?.map((row) => [row.word, row.identity])).toEqual([
    ['agent-profile', profile],
    ['hook', hook],
  ]);
});

it('renders codex rows only', async () => {
  const root = await initialized();
  expect(renderProjectionFor(root, 'codex').files.map((file) => file.path)).toEqual([
    'AGENTS.md',
    '.agents/skills/ia-authoring/SKILL.md',
  ]);
});
