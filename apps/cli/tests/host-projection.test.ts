/**
 * Host registration spec §6: a consumer workspace's projection, rendered from its own admitted records. Since
 * milestone position-packet task replace-renderers it is the position packet's consumer rendering (runtime R19 and
 * R20): the target is initialized from the bundled base, so every system line comes from the base's systems.
 */
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { PACKET_MARKER } from '@inventarch/runtime';
import { packetCatalog } from '../src/commands.js';
import { renderProjectionFor } from '../src/host-projection.js';
import { read } from './host-fixture.js';
import { cleanup, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanup);

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
  // The compatibility fixture: this release's starter still authors a local @system with its steward (plan task
  // init-three-records replaces it). It admits and projects the packet; no steward, local or installed, is an agent.
  expect(read(root, '.ia/src/systems/demo/system.ia')).toContain('@agent demo-steward');
  const { files, receipt } = renderProjectionFor(root, 'claude');
  expect(files.map((file) => file.path)).toEqual([
    '.claude/rules/ia-workspace.md',
    '.claude/skills/ia-authoring/SKILL.md',
  ]);
  for (const file of files) expect(file.text.split('\n')).toContain(PACKET_MARKER);
  const rules = files[0]!.text;
  expect(rules.startsWith(`${PACKET_MARKER}\n\n# IA position packet: demo\n`)).toBe(true);
  // The base's eleven systems (spec §2.2) are pointer lines, each with its steward and the command that seats at it.
  const systems = section(rules, 'Systems');
  expect(systems).toHaveLength(11);
  for (const line of systems)
    expect(line).toMatch(
      /; steward `agent-system\/binding\/agent\/public-[a-z-]+-steward`; reach `ia position --seat floor\/definition\/system\/[a-z-]+`$/,
    );
  // The starter authors no @mandate yet, so no participant renders and none is refused.
  expect(section(rules, 'Seat')[0]).toContain('participants none (no authored `@mandate` names an `@agent`)');
  expect(
    section(rules, 'Commands')
      .slice(2)
      .map((row) => row.split(' | ')[0]),
  ).toEqual(packetCatalog().map((row) => `| \`${row.command}\``));
  expect(rules).toContain('## Host note (not part of the packet)');
  expect(rules).not.toContain(root);
  expect(rules).not.toContain(root.replaceAll('\\', '/'));
  // The receipt the render fills; the applying caller sets the rest (B12).
  expect(receipt).toMatchObject({ host: 'claude', slug: 'demo', cli: null, guard: 'none', writtenAt: null });
  expect(receipt.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
  expect(receipt.entries).toBe(1 + systems.length + 5 + 4 + packetCatalog().length + 1 + 3);
});

it('renders codex rows only', async () => {
  const root = await initialized();
  expect(renderProjectionFor(root, 'codex').files.map((file) => file.path)).toEqual([
    'AGENTS.md',
    '.agents/skills/ia-authoring/SKILL.md',
  ]);
});
