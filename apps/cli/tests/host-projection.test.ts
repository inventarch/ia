/**
 * Host registration spec §6: a consumer workspace's projection, rendered from its own admitted records. The target
 * is initialized from the bundled base, so every row below comes from the base's systems plus the one starter.
 */
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { WORKSPACE_PROJECTION_MARKER } from '@inventarch/compliance';
import { renderProjectionFor } from '../src/host-projection.js';
import { cleanup, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 120_000 });
afterAll(cleanup);

async function initialized(): Promise<string> {
  const root = resolve(scratch('host-projection'), 'demo');
  const result = await run(['init', root, '--apply', '--yes', '--json']);
  expect(result.exitCode, result.stdout).toBe(0);
  return root;
}

it('renders a consumer workspace for claude with a subagent per system, authored and installed, and no machine paths', async () => {
  const root = await initialized();
  const artifacts = renderProjectionFor(root, 'claude');
  // Host plugin distribution spec §10 (amends M5.3 §6.2): a steward follows its system into the workspace whether
  // authored (the starter's own "demo" system) or installed (the bundled base's eleven language systems, §2.2;
  // work-system joined the base with docs/specs/work-system/README.md §9.2).
  expect(artifacts.map((artifact) => artifact.path).sort()).toEqual([
    '.claude/agents/demo-steward.md',
    '.claude/agents/public-agent-composition-system-steward.md',
    '.claude/agents/public-agent-system-steward.md',
    '.claude/agents/public-authoring-system-steward.md',
    '.claude/agents/public-compliance-system-steward.md',
    '.claude/agents/public-governance-system-steward.md',
    '.claude/agents/public-hook-authoring-system-steward.md',
    '.claude/agents/public-learning-system-steward.md',
    '.claude/agents/public-session-system-steward.md',
    '.claude/agents/public-template-system-steward.md',
    '.claude/agents/public-work-system-steward.md',
    '.claude/agents/public-workspace-system-steward.md',
    '.claude/rules/ia-workspace.md',
    '.claude/skills/ia-authoring/SKILL.md',
  ]);
  for (const artifact of artifacts) expect(artifact.text.split('\n')).toContain(WORKSPACE_PROJECTION_MARKER);
  const rules = artifacts.find((artifact) => artifact.path === '.claude/rules/ia-workspace.md')!.text;
  expect(rules).toContain('- demo: steward demo-steward;');
  expect(rules).toContain('node <cache>/scripts/ia.mjs door');
  expect(rules).not.toContain(root);
  expect(rules).not.toContain(root.replaceAll('\\', '/'));
  // Spec §2.2's measurement: the base's eleven language systems (work-system included) plus the starter.
  expect(rules.match(/^- [a-z-]+: steward /gm)).toHaveLength(12);
});

it('renders codex rows only', async () => {
  const root = await initialized();
  expect(renderProjectionFor(root, 'codex').map((artifact) => artifact.path)).toEqual([
    'AGENTS.md',
    '.agents/skills/ia-authoring/SKILL.md',
  ]);
});
