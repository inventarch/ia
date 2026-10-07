import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { open } from '../../packages/db/src/index.js';
import { PROJECTION_MARKER, renderHostArtifacts } from '../../packages/compliance/src/index.js';
import { generateProjections, publishArtifacts } from './generate.js';

const root = resolve(import.meta.dirname, '../..'),
  temporary: string[] = [];
function temp(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'ia-projection-tests-'));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) {
    const rel = relative(tmpdir(), path);
    if (isAbsolute(rel) || !rel.startsWith('ia-projection-tests-') || rel.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
it('renders every list-form steward requires from the native corpus as bullets, never an empty clause', () => {
  const db = open(root, { cache: false });
  try {
    const records = db.records(),
      result = renderHostArtifacts(records, db.revision);
    expect(result.assessment.findings).toEqual([]);
    const listForm = records.filter(
      (r) =>
        r.discriminator === 'agent' &&
        r.source.path.endsWith('/steward.ia') &&
        r.variants.some((v) => v.key === 'requires' && v.condition === undefined && v.value.kind === 'block'),
    );
    for (const agent of result.artifacts.filter((a) => a.path.startsWith('.claude/agents/')))
      expect(agent.text).not.toMatch(/^requires:\s*$\n^\s*$/m);
    for (const steward of listForm) {
      const block = steward.sections
        .find((s) => s.name === 'governance')!
        .fields.find((f) => 'key' in f && f.key === 'requires')!;
      const first = 'fields' in block ? block.fields!.find((c) => 'item' in c) : undefined;
      const text = result.artifacts.find((a) => a.path === `.claude/agents/${steward.name}.md`)!.text;
      expect(text).toContain('requires:\n- ');
      if (first !== undefined && 'item' in first && 'text' in first.item)
        expect(text).toContain(`- ${first.item.text}`);
    }
  } finally {
    db.close();
  }
});
it('refuses bad owner, unsafe or colliding agent names with one diagnostic', () => {
  const db = open(root, { cache: false });
  try {
    const records = db.records();
    for (const pool of [
      records.filter((r) => r.name !== 'public-governance-system-steward'),
      [...records, records.find((r) => r.name === 'public-governance-system-steward')!],
      records.map((r) =>
        r.discriminator === 'system' && r.name === 'governance-system'
          ? { ...r, source: { ...r.source, path: 'wrong/system.ia' } }
          : r,
      ),
    ]) {
      const result = renderHostArtifacts(pool, db.revision);
      expect(result.artifacts).toEqual([]);
      expect(result.assessment.findings).toHaveLength(1);
      expect(result.assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    }
    expect(renderHostArtifacts(records, '').assessment.outcome).toBe('fail');
    for (const name of ['../escape', 'public-agent-system-steward']) {
      const changed = records.map((r) =>
        r.name === 'public-governance-system-steward'
          ? { ...r, name }
          : r.discriminator === 'system' && r.name === 'governance-system'
            ? {
                ...r,
                head: r.head.map((f) =>
                  f.key !== 'steward' || f.value.kind !== 'ref' ? f : { ...f, value: { ...f.value, name } },
                ),
              }
            : r,
      );
      expect(renderHostArtifacts(changed, db.revision).assessment.findings[0]!.code).toBe('IA-COMP-PROJECTION-INVALID');
    }
  } finally {
    db.close();
  }
});
it('checks without writing, publishes changed bytes and leaves equal bytes untouched', () => {
  const base = temp(),
    artifact = { path: 'CLAUDE.md', text: PROJECTION_MARKER + '\nfirst\n' };
  expect(publishArtifacts(base, [artifact], false)).toEqual(['CLAUDE.md']);
  expect(publishArtifacts(base, [artifact], true)).toEqual(['CLAUDE.md']);
  const time = statSync(resolve(base, 'CLAUDE.md')).mtimeMs;
  expect(publishArtifacts(base, [artifact], true)).toEqual([]);
  expect(statSync(resolve(base, 'CLAUDE.md')).mtimeMs).toBe(time);
  const changed = { ...artifact, text: PROJECTION_MARKER + '\nsecond\n' };
  expect(publishArtifacts(base, [changed], true)).toEqual(['CLAUDE.md']);
  expect(readFileSync(resolve(base, 'CLAUDE.md'), 'utf8')).toBe(changed.text);
});
it('preflights unmanaged or stale files before writing and refuses arbitrary outputs and aliases', () => {
  const base = temp(),
    outside = temp();
  writeFileSync(resolve(base, 'CLAUDE.md'), 'User-authored');
  const first = { path: '.claude/agents/fresh.md', text: PROJECTION_MARKER },
    last = { path: 'CLAUDE.md', text: PROJECTION_MARKER };
  // Design row 27: the refusal names the file to delete and the one command that follows.
  expect(() => publishArtifacts(base, [first, last], true)).toThrow(
    'Refusing unmanaged projection: CLAUDE.md; delete CLAUDE.md, then run "pnpm projections:generate"',
  );
  expect(() => statSync(resolve(base, first.path))).toThrow();
  expect(() => publishArtifacts(base, [{ path: '../escape', text: '' }], true)).toThrow('output set');
  mkdirSync(resolve(base, '.claude/agents'), { recursive: true });
  writeFileSync(resolve(base, '.claude/agents/stale.md'), PROJECTION_MARKER);
  expect(() => publishArtifacts(base, [first], false)).toThrow(
    'Stale managed projection requires source-aware reconciliation: .claude/agents/stale.md; delete .claude/agents/stale.md, then run "pnpm projections:generate"',
  );
  symlinkSync(outside, resolve(base, '.agents'), 'junction');
  expect(() =>
    publishArtifacts(
      base,
      [
        { path: '.agents/skills/ia-authoring/SKILL.md', text: PROJECTION_MARKER },
        { path: '.claude/agents/stale.md', text: PROJECTION_MARKER },
      ],
      true,
    ),
  ).toThrow('aliased');
});
it('refuses generating a partial corpus with admission errors, naming the command that prints them', () => {
  expect(() => generateProjections(resolve(root, 'packages/compliance/fixtures/loop'), false)).toThrow(
    'Native corpus has errors; projections refused; run "pnpm native:check" for the findings',
  );
});

it('names one next command in every refusal the generator raises (design row 27)', () => {
  // Every construction site in the source, so a refusal added later without a next command fails here.
  const source = readFileSync(resolve(import.meta.dirname, 'generate.ts'), 'utf8');
  const messages = [...source.matchAll(/throw new Error\(\s*`([^`]*)`/g)].map((match) => match[1]!);
  expect(source.match(/throw new Error\(/g)).toHaveLength(messages.length);
  expect(messages).toHaveLength(11);
  for (const message of messages)
    expect(message.match(/\$\{(?:GENERATE|SHOW_FINDINGS|SHOW_RENDERER)\}/g), message).toHaveLength(1);
});
it('names the next command for a usage refusal of the generator run as a program', () => {
  const result = spawnSync(
    process.execPath,
    ['--conditions=development', '--import', 'tsx', resolve(import.meta.dirname, 'generate.ts')],
    { cwd: root, encoding: 'utf8', timeout: 15000 },
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.split(/\r?\n/)).toContain('Usage: generate.ts --check|--write; run "pnpm projections:generate"');
});

it('renders attributed language references without private methods', () => {
  const db = open(root, { cache: false });
  try {
    const result = renderHostArtifacts(db.records(), db.revision);
    expect(result.assessment.outcome).toBe('pass');
    expect(result.artifacts).toHaveLength(14);
    const agents = result.artifacts.filter((artifact) => artifact.path.startsWith('.claude/agents/'));
    expect(agents).toHaveLength(11);
    for (const agent of agents) {
      expect(agent.text.startsWith('---\nname: ')).toBe(true);
      expect(agent.text).toContain(PROJECTION_MARKER);
      expect(agent.text).toContain(db.revision);
      expect(agent.text).toContain('.ia/src/systems/');
      expect(agent.text).toContain('canonical words and schemas');
      expect(agent.text).not.toContain('Native domain methods');
    }
    const skills = result.artifacts.filter((artifact) => artifact.path.includes('/skills/'));
    expect(skills).toHaveLength(2);
    expect(skills[0]!.text).toBe(skills[1]!.text);
    expect(Object.isFrozen(result.artifacts[0])).toBe(true);
    expect(generateProjections(root, false)).toEqual([]);
    const base = temp();
    expect(publishArtifacts(base, result.artifacts, false)).toHaveLength(14);
    publishArtifacts(base, result.artifacts, true);
    expect(publishArtifacts(base, result.artifacts, false)).toEqual([]);
  } finally {
    db.close();
  }
});
