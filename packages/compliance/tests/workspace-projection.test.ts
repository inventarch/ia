import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRegistry, compile, parse } from '@inventarch/language';
import type { CompiledRecord, Location } from '@inventarch/language';
import { WORKSPACE_PROJECTION_MARKER, renderWorkspaceProjection } from '../src/index.js';
import type { ProjectionMembership, WorkspaceProjectionInput } from '../src/index.js';
import { id, list, listRequires, refusal, steward } from './host-projection-fixture.js';

// `packages/compliance/fixtures/loop` is a small, self-contained workspace fixture (floor plus five
// authored systems, each with a system.ia and a steward.ia). It is compiled directly with @inventarch/language,
// the same way tests/native.ts compiles the real repository, so this test needs neither @inventarch/db nor a
// fully admitted corpus (renderWorkspaceProjection requires only systems and their stewards).
const fixtureRoot = resolve(import.meta.dirname, '../fixtures/loop');
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(path, entry.name))
      : entry.name.endsWith('.ia')
        ? [resolve(path, entry.name)]
        : [],
  );
}
const inputs = files(resolve(fixtureRoot, '.ia/src'))
  .sort()
  .map((path) => {
    const name = relative(fixtureRoot, path).replaceAll('\\', '/');
    const location: Location = name.startsWith('.ia/src/floor/')
      ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
      : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
    return { path: name, text: readFileSync(path, 'utf8'), location };
  });
const sources = inputs.map((input) => ({ ...parse(input.text, input.path), location: input.location }));
const registered = buildRegistry(sources);
if (registered.diagnostics.length > 0) throw new Error(JSON.stringify(registered.diagnostics));
const registry = registered.registry;
const first = sources.flatMap((s) => compile(s.ast, registry, s.location, []).records);
const records: readonly CompiledRecord[] = sources.flatMap((s) => {
  const result = compile(
    s.ast,
    registry,
    s.location,
    first.filter((r) => r.source.path !== s.ast.path),
  );
  if (result.diagnostics.length > 0) throw new Error(JSON.stringify(result.diagnostics));
  return result.records;
});

const revision = 'workspace-projection-test-revision';
/** Mirrors the default membership fallback in projections.ts:28-31: derive {path, system, root} from each source path. */
function membershipFor(pool: readonly CompiledRecord[]): ProjectionMembership {
  const members = [...new Set(pool.map((r) => r.source.path))].map((path) => {
    const match = /^(\.ia\/src\/systems\/([a-z][a-z0-9-]*))\//.exec(path);
    return { path, system: match?.[2] ?? null, root: match?.[1] ?? null };
  });
  return { revision, members };
}
const baseMembership = membershipFor(records);
const input: WorkspaceProjectionInput = {
  host: 'claude',
  modes: [
    {
      invocation: 'node <cache>/scripts/ia.mjs verify',
      meaning: 'Verify the whole cache against its pinned inventory',
    },
    {
      invocation: 'node <cache>/scripts/ia.mjs door <operation> --root <workspace>',
      meaning: 'Run one read-only door operation and print its JSON response',
    },
  ],
  // Deliberately out of id order, to exercise renderWorkspaceProjection's own sort.
  distributions: [
    { id: '@inventarch/zeta-distribution', version: '2.0.0' },
    { id: '@inventarch/example-distribution', version: '1.2.3' },
  ],
  operations: ['records', 'report', 'validate'],
};
const nonFloorSystemNames = [
  'agent-system',
  'compliance-system',
  'governance-system',
  'session-system',
  'workspace-system',
];
const hasMarkerLine = (text: string): boolean => text.split(/\r?\n/).includes(WORKSPACE_PROJECTION_MARKER);

describe('renderWorkspaceProjection', () => {
  it('renders the claude artifact set: rules, skill and one subagent per local system', () => {
    const result = renderWorkspaceProjection(records, revision, baseMembership, input);
    expect(result.assessment.outcome).toBe('pass');
    const paths = result.artifacts.map((a) => a.path).sort();
    expect(paths).toEqual([
      '.claude/agents/agent-steward.md',
      '.claude/agents/compliance-steward.md',
      '.claude/agents/governance-steward.md',
      '.claude/agents/session-steward.md',
      '.claude/agents/workspace-steward.md',
      '.claude/rules/ia-workspace.md',
      '.claude/skills/ia-authoring/SKILL.md',
    ]);
    const rules = result.artifacts.find((a) => a.path === '.claude/rules/ia-workspace.md')!;
    expect(rules.text).toContain(`Source revision: ${revision}`);
    for (const name of nonFloorSystemNames) expect(rules.text).toMatch(new RegExp(`- ${name}: steward `));
    // Sorted by id ascending, regardless of the unsorted order given above.
    expect(rules.text).toContain('- @inventarch/example-distribution 1.2.3\n- @inventarch/zeta-distribution 2.0.0');
    expect(rules.text).toContain('ia <operation> --root <workspace>');
    expect(rules.text).toContain('records, report, validate');
    expect(rules.text).toContain('node <cache>/scripts/ia.mjs verify');
    expect(rules.text).toContain('This file is a projection of records. Adding text to it creates no rule');
    expect(rules.text).toContain('~/.ia is the user-level IA home, not a workspace; ia doctor reports it.');
    // Operator decision 2026-09-23: the Claude rules disclose the guard's steward scope, in the systems section, without claiming it ran.
    const systems = rules.text.slice(
      rules.text.indexOf('## Systems and stewards'),
      rules.text.indexOf('## Installed distributions'),
    );
    expect(systems).toContain(
      "\n\nWhen the steward guard is registered, edits under .ia/src/systems/<name>/ are accepted only from that system's steward subagent.\n\n",
    );
    const skill = result.artifacts.find((a) => a.path === '.claude/skills/ia-authoring/SKILL.md')!;
    expect(skill.text).toContain('ia vocabulary');
    expect(skill.text).toContain('ia validate');
    expect(skill.text).toContain('ia inspect');
    const steward = result.artifacts.find((a) => a.path === '.claude/agents/agent-steward.md')!;
    expect(steward.text.startsWith('---\nname: agent-steward\n')).toBe(true);
    expect(steward.text).toContain('The designated expert for expert agent identities and bounded mandates.');
    expect(steward.text).toContain('applies: agent, mandate');
    expect(steward.text).toContain('requires: Use the owning schema');
    expect(Object.isFrozen(result.artifacts[0])).toBe(true);
    expect(Object.isFrozen(result.artifacts)).toBe(true);
  });

  it('renders the codex artifact set: AGENTS.md and the codex skill, no subagent files', () => {
    const codexInput: WorkspaceProjectionInput = { ...input, host: 'codex' };
    const result = renderWorkspaceProjection(records, revision, baseMembership, codexInput);
    expect(result.assessment.outcome).toBe('pass');
    expect(result.artifacts.map((a) => a.path).sort()).toEqual(['.agents/skills/ia-authoring/SKILL.md', 'AGENTS.md']);
    const agentsMd = result.artifacts.find((a) => a.path === 'AGENTS.md')!;
    for (const name of nonFloorSystemNames) expect(agentsMd.text).toMatch(new RegExp(`- ${name}: steward `));
    expect(agentsMd.text).toContain(`Source revision: ${revision}`);
    expect(agentsMd.text).toContain('~/.ia is the user-level IA home, not a workspace; ia doctor reports it.');
    expect(agentsMd.text).not.toContain('steward guard');
  });

  it('projects a subagent file for a system whose membership root is an installed package, not only a local one', () => {
    // Host plugin distribution spec §10 (amends M5.3 §6.2): a steward follows its system into the workspace, authored
    // or installed. Relocate agent-system's system.ia and steward.ia under an installed-package-shaped root — the
    // shape @inventarch/db's systemMember (packages/db/src/inputs.ts:176) recognizes for the distributions store — so the
    // membership and the record paths move together, unlike the workspace's other four systems which stay under
    // .ia/src/systems.
    const installedRoot = `.ia/distributions/store/${'a'.repeat(64)}/.ia/src/systems/agent-system`;
    const relocated = records.map((r) =>
      r.discriminator === 'system' && r.name === 'agent-system'
        ? { ...r, source: { ...r.source, path: `${installedRoot}/system.ia` } }
        : r.discriminator === 'agent' && r.name === 'agent-steward'
          ? { ...r, source: { ...r.source, path: `${installedRoot}/steward.ia` } }
          : r,
    );
    const installedMembership: ProjectionMembership = {
      revision,
      members: baseMembership.members.map((m) =>
        m.path === '.ia/src/systems/agent-system/system.ia'
          ? { path: `${installedRoot}/system.ia`, system: 'agent-system', root: installedRoot }
          : m.path === '.ia/src/systems/agent-system/steward.ia'
            ? { path: `${installedRoot}/steward.ia`, system: 'agent-system', root: installedRoot }
            : m,
      ),
    };
    const result = renderWorkspaceProjection(relocated, revision, installedMembership, input);
    expect(result.assessment.outcome).toBe('pass');
    const paths = result.artifacts.map((a) => a.path);
    expect(paths).toContain('.claude/agents/agent-steward.md');
    // The other four local systems still get their subagent files.
    expect(paths).toContain('.claude/agents/compliance-steward.md');
    expect(paths).toContain('.claude/agents/governance-steward.md');
    expect(paths).toContain('.claude/agents/session-steward.md');
    expect(paths).toContain('.claude/agents/workspace-steward.md');
    // The installed system gets the same row in the instructions file as an authored one.
    const rules = result.artifacts.find((a) => a.path === '.claude/rules/ia-workspace.md')!;
    expect(rules.text).toMatch(/- agent-system: steward /);
    // Installed definitions are immutable (C24, as projections.ts marks adopted ones), so the installed steward is told
    // so and is not offered as the one to repair them; a local steward keeps its authoring description.
    const installed = result.artifacts.find((a) => a.path === '.claude/agents/agent-steward.md')!.text;
    expect(installed).toContain('Installed or adopted definition sources are immutable.');
    expect(installed).not.toContain('reviewing or repairing records owned by agent-system');
    const local = result.artifacts.find((a) => a.path === '.claude/agents/compliance-steward.md')!.text;
    expect(local).toContain('Use for authoring, reviewing or repairing records owned by compliance-system.');
    expect(local).not.toContain('immutable');
  });

  it('never projects a subagent file for a floor system, even under a fully qualified, installed-shaped membership root', () => {
    // admittedStewards (projections.ts:49) drops any @system whose source path starts with .ia/src/floor/ before
    // steward resolution runs; this is now the *only* thing keeping a floor system out of .claude/agents, since the
    // local-root restriction above no longer exists. Relocate agent-system under a floor-rooted, otherwise valid
    // installed-shaped membership to prove the floor exclusion still holds, the same way the case above proves
    // an installed root is now admitted.
    const floorRoot = '.ia/src/floor/agent-system';
    const relocated = records.map((r) =>
      r.discriminator === 'system' && r.name === 'agent-system'
        ? { ...r, source: { ...r.source, path: `${floorRoot}/system.ia` } }
        : r.discriminator === 'agent' && r.name === 'agent-steward'
          ? { ...r, source: { ...r.source, path: `${floorRoot}/steward.ia` } }
          : r,
    );
    const floorMembership: ProjectionMembership = {
      revision,
      members: baseMembership.members.map((m) =>
        m.path === '.ia/src/systems/agent-system/system.ia'
          ? { path: `${floorRoot}/system.ia`, system: 'agent-system', root: floorRoot }
          : m.path === '.ia/src/systems/agent-system/steward.ia'
            ? { path: `${floorRoot}/steward.ia`, system: 'agent-system', root: floorRoot }
            : m,
      ),
    };
    const result = renderWorkspaceProjection(relocated, revision, floorMembership, input);
    expect(result.assessment.outcome).toBe('pass');
    const paths = result.artifacts.map((a) => a.path);
    expect(paths).not.toContain('.claude/agents/agent-steward.md');
    // The other four local systems are unaffected.
    expect(paths).toContain('.claude/agents/compliance-steward.md');
    expect(paths).toContain('.claude/agents/governance-steward.md');
    expect(paths).toContain('.claude/agents/session-steward.md');
    expect(paths).toContain('.claude/agents/workspace-steward.md');
    // The floor system is dropped before rendering, so it gets no row either.
    const rules = result.artifacts.find((a) => a.path === '.claude/rules/ia-workspace.md')!;
    expect(rules.text).not.toMatch(/- agent-system: steward /);
  });

  it('carries the marker as its own line on every rendered artifact, in every case above', () => {
    const cases = [
      renderWorkspaceProjection(records, revision, baseMembership, input),
      renderWorkspaceProjection(records, revision, baseMembership, { ...input, host: 'codex' }),
    ];
    for (const result of cases) {
      expect(result.artifacts.length).toBeGreaterThan(0);
      for (const artifact of result.artifacts) expect(hasMarkerLine(artifact.text)).toBe(true);
    }
  });

  it('never leaks the absolute fixture filesystem path into rendered text', () => {
    const result = renderWorkspaceProjection(records, revision, baseMembership, input);
    const forward = fixtureRoot.replaceAll('\\', '/');
    for (const artifact of result.artifacts) {
      expect(artifact.text).not.toContain(fixtureRoot);
      expect(artifact.text).not.toContain(forward);
    }
  });

  it('refuses with IA-COMP-PROJECTION-INVALID when the membership revision is stale', () => {
    const result = renderWorkspaceProjection(records, 'a-different-revision', baseMembership, input);
    expect(result.assessment.outcome).toBe('fail');
    expect(result.artifacts).toEqual([]);
    expect(result.assessment.findings).toHaveLength(1);
    expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    expect(result.assessment.findings[0]!.message).toBe('Projection membership revision is stale');
  });

  // The next five conditions come from projections.ts's shared admittedStewards helper (spec §6.1), which
  // renderWorkspaceProjection now enforces identically to renderHostArtifacts.
  it('refuses a membership member that names no admitted source', () => {
    const membership: ProjectionMembership = {
      revision,
      members: [...baseMembership.members, { path: 'not-a-real-source.ia', system: null, root: null }],
    };
    const result = renderWorkspaceProjection(records, revision, membership, input);
    expect(result.assessment.outcome).toBe('fail');
    expect(result.artifacts).toEqual([]);
    expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    expect(result.assessment.findings[0]!.message).toBe('Invalid or conflicting projection membership');
  });

  it('refuses two membership members whose paths are case aliases of each other', () => {
    // A non-system, non-agent record: aliasing it cannot also satisfy or trip the later per-system steward
    // resolution, so a failure here can only come from the membership loop's own case-alias check.
    const target = records.find((r) => r.discriminator !== 'system' && r.discriminator !== 'agent')!;
    const upperPath = target.source.path.toUpperCase();
    expect(upperPath).not.toBe(target.source.path);
    const aliased = [
      ...records,
      { ...target, identity: target.identity + '-case-alias', source: { ...target.source, path: upperPath } },
    ];
    const membership: ProjectionMembership = {
      revision,
      members: [...baseMembership.members, { path: upperPath, system: null, root: null }],
    };
    const result = renderWorkspaceProjection(aliased, revision, membership, input);
    expect(result.assessment.outcome).toBe('fail');
    expect(result.artifacts).toEqual([]);
    expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    expect(result.assessment.findings[0]!.message).toBe('Invalid or conflicting projection membership');
  });

  it('refuses a steward ref that carries a fragment', () => {
    const withFragment = records.map((r) =>
      r.discriminator === 'system' && r.name === 'agent-system'
        ? {
            ...r,
            head: r.head.map((f) =>
              f.key === 'steward' && f.value.kind === 'ref' ? { ...f, value: { ...f.value, fragment: 'section' } } : f,
            ),
          }
        : r,
    );
    const result = renderWorkspaceProjection(withFragment, revision, baseMembership, input);
    expect(result.assessment.outcome).toBe('fail');
    expect(result.artifacts).toEqual([]);
    expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    expect(result.assessment.findings[0]!.message).toBe('Invalid or nonunique host steward for agent-system');
  });

  it('refuses duplicate admitted record identities', () => {
    const duplicated = [...records, records[0]!];
    const result = renderWorkspaceProjection(duplicated, revision, baseMembership, input);
    expect(result.assessment.outcome).toBe('fail');
    expect(result.artifacts).toEqual([]);
    expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    expect(result.assessment.findings[0]!.message).toBe('Projection requires unique admitted record identities');
  });

  it('refuses a membership member whose root is not a prefix of its own path', () => {
    const membership: ProjectionMembership = {
      revision,
      members: baseMembership.members.map((m) =>
        m.path === '.ia/src/systems/agent-system/system.ia' ? { ...m, root: '.ia/src/elsewhere/agent-system' } : m,
      ),
    };
    const result = renderWorkspaceProjection(records, revision, membership, input);
    expect(result.assessment.outcome).toBe('fail');
    expect(result.artifacts).toEqual([]);
    expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    expect(result.assessment.findings[0]!.message).toBe('Invalid or conflicting projection membership');
  });
});

describe('renderWorkspaceProjection shares the block clause renderer', () => {
  const clauseInput: WorkspaceProjectionInput = {
    host: 'claude',
    modes: [],
    distributions: [],
    operations: ['records'],
  };
  it('renders list-form requires as bullets and refuses an empty clause', () => {
    const pool = steward(records, [['applies', list(id('agent'))], listRequires]);
    const result = renderWorkspaceProjection(pool, revision, membershipFor(pool), clauseInput);
    expect(result.assessment.findings).toEqual([]);
    expect(result.artifacts.find((a) => a.path === '.claude/agents/agent-steward.md')!.text).toContain(
      'requires:\n- Ground in agent-system schemas.\n- Return validation evidence.',
    );
    const none = steward(records, [['applies', list()], listRequires]);
    const noneText = renderWorkspaceProjection(none, revision, membershipFor(none), clauseInput).artifacts.find(
      (a) => a.path === '.claude/agents/agent-steward.md',
    )!.text;
    expect(noneText).not.toContain('applies:');
    const empty = steward(records, [
      ['applies', list()],
      ['requires', []],
    ]);
    expect(refusal(renderWorkspaceProjection(empty, revision, membershipFor(empty), clauseInput))).toBe(
      'Steward agent-steward: empty requires clause',
    );
  });
});
