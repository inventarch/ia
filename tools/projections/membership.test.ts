import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stableSerialize } from '../../packages/graph/src/index.js';
import { open, readInputs } from '../../packages/db/src/index.js';
import { renderHostArtifacts } from '../../packages/compliance/src/index.js';
import { generateProjections, projectionMembership } from './generate.js';

const root = resolve(import.meta.dirname, '../..'),
  temporary: string[] = [];
function fixture(): string {
  const base = mkdtempSync(resolve(tmpdir(), 'ia-projection-membership-'));
  temporary.push(base);
  const sources = readInputs(root, { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  for (const source of sources) {
    const target = resolve(base, 'vendor/foundation', source.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source.text);
  }
  mkdirSync(resolve(base, '.ia'), { recursive: true });
  writeFileSync(
    resolve(base, '.ia/workspace.json'),
    JSON.stringify({
      version: 1,
      adopted: [
        {
          id: 'foundation',
          path: 'vendor/foundation',
          revision: createHash('sha256').update(stableSerialize(sources)).digest('hex'),
        },
      ],
    }),
  );
  return base;
}
afterEach(() => {
  for (const path of temporary.splice(0)) {
    const rel = relative(tmpdir(), path);
    if (isAbsolute(rel) || !rel.startsWith('ia-projection-membership-') || rel.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

it('projects a real pinned adopted tree without promoting local methods or changing definitions', () => {
  const base = fixture(),
    path = '.ia/src/systems/governance-system/project-method.ia';
  mkdirSync(dirname(resolve(base, path)), { recursive: true });
  writeFileSync(
    resolve(base, path),
    '#! ia 1.0\n\n@playbook projection-project-method\n  meaning\n    says "A project contribution"\n    answers "What is local?"\n  cognition\n    plan\n      Inference means "PROJECT-METHOD-SENTINEL"\n',
  );
  const source = resolve(base, 'vendor/foundation/.ia/src/systems/governance-system/system.ia'),
    before = readFileSync(source);
  const db = open(base, { cache: false });
  try {
    expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    const records = db.records(),
      result = renderHostArtifacts(records, db.revision, projectionMembership(records, db.revision));
    expect(result.assessment.outcome).toBe('pass');
    expect(result.artifacts).toHaveLength(14);
    const expert = result.artifacts.find((a) => a.path === '.claude/agents/public-governance-system-steward.md')!;
    expect(expert.text).toMatch(
      /\.ia\/adopted\/foundation\/[a-f0-9]{64}\/\.ia\/src\/systems\/governance-system\/system\.ia/,
    );
    expect(expert.text).toContain('Adopted source paths are immutable references');
    const skill = result.artifacts.find((a) => a.path === '.agents/skills/ia-authoring/SKILL.md')!;
    expect(skill.text).toContain('canonical schema');
    expect(skill.text).not.toContain('Read .ia/adopted/');
    expect(skill.text).not.toContain('Edit the native method');
    expect(expert.text).not.toContain('PROJECT-METHOD-SENTINEL');
    expect(expert.text).not.toContain(path);
    expect(renderHostArtifacts(records, db.revision).assessment.outcome).toBe('fail');
    expect(generateProjections(base, false)).toHaveLength(14);
    expect(existsSync(resolve(base, '.claude'))).toBe(false);
    expect(existsSync(resolve(base, '.ia/adopted'))).toBe(false);
    expect(existsSync(resolve(base, '.ia/src/systems/governance-system/system.ia'))).toBe(false);
    expect(readFileSync(source)).toEqual(before);
  } finally {
    db.close();
  }
});

it('refuses stale, duplicate, aliased, omitted or wrong-root membership before returning artifacts', () => {
  const db = open(fixture(), { cache: false });
  try {
    const records = db.records(),
      membership = projectionMembership(records, db.revision),
      first = membership.members[0]!;
    const changes = [
      { ...membership, revision: 'stale' },
      { ...membership, members: [...membership.members, first] },
      { ...membership, members: membership.members.slice(1) },
      { ...membership, members: [{ ...first, path: first.path.toUpperCase() }, ...membership.members.slice(1)] },
      { ...membership, members: [{ ...first, root: '../' + first.root }, ...membership.members.slice(1)] },
      {
        ...membership,
        members: membership.members.map((m) =>
          m.path.endsWith('/system.ia') ? { ...m, system: 'different-system' } : m,
        ),
      },
    ];
    for (const changed of changes) {
      const result = renderHostArtifacts(records, db.revision, changed);
      expect(result.artifacts).toEqual([]);
      expect(result.assessment.findings).toHaveLength(1);
      expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    }
  } finally {
    db.close();
  }
});

it('refuses a scope-excluded steward and tied or same-name foreign occurrences', () => {
  const db = open(fixture(), { cache: false });
  try {
    const records = db.records(),
      steward = records.find((r) => r.name === 'public-governance-system-steward')!;
    const scope = db.resolveScope({
      identities: records.filter((r) => r.identity !== steward.identity).map((r) => r.identity),
    });
    const scoped = db.records({ within: scope.token });
    const pools = [
      scoped,
      [...records, steward],
      records.map((r) =>
        r === steward
          ? { ...r, source: { ...r.source, path: r.source.path.replace('/governance-system/', '/agent-system/') } }
          : r,
      ),
      [
        ...records,
        {
          ...steward,
          identity: steward.identity + '-duplicate',
          source: { ...steward.source, line: steward.source.line + 1 },
        },
      ],
    ];
    for (const pool of pools) {
      const result = renderHostArtifacts(pool, db.revision, projectionMembership(pool, db.revision));
      expect(result.assessment.outcome).toBe('fail');
      expect(result.artifacts).toEqual([]);
    }
  } finally {
    db.close();
  }
});

it('refuses changed immutable source bytes before generation', () => {
  const base = fixture(),
    path = resolve(base, 'vendor/foundation/.ia/src/systems/governance-system/system.ia');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n# Changed after pinning\n');
  expect(() => generateProjections(base, false)).toThrow('Pinned source revision differs');
  expect(existsSync(resolve(base, '.claude'))).toBe(false);
});

it('keeps authored-only artifact bytes identical across the compatibility and observed-membership APIs', () => {
  const db = open(root, { cache: false });
  try {
    const records = db.records();
    expect(renderHostArtifacts(records, db.revision, projectionMembership(records, db.revision))).toEqual(
      renderHostArtifacts(records, db.revision),
    );
  } finally {
    db.close();
  }
});
