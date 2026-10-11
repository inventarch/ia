import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stableSerialize } from '../../packages/graph/src/index.js';
import { open, readInputs } from '../../packages/db/src/index.js';
import { generateProjections, renderProjections } from './generate.js';

// The repository projection over a pinned adopted tree (milestone position-packet task replace-renderers): the packet
// renders what the database admits, whatever its mount, and neither promotes a local contribution nor touches the
// adopted source.
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
  } finally {
    db.close();
  }
  const files = renderProjections(base);
  expect(files.map((file) => file.path)).toEqual([
    'CLAUDE.md',
    '.claude/skills/ia-authoring/SKILL.md',
    '.agents/skills/ia-authoring/SKILL.md',
  ]);
  const claude = files[0]!.text;
  // No record body is part of the packet (design §4: K0 has n = 0), and no adopted or local source path is printed.
  expect(claude).not.toContain('PROJECT-METHOD-SENTINEL');
  expect(claude).not.toContain(path);
  expect(claude).not.toContain('.ia/adopted/');
  expect(claude).not.toContain('vendor/foundation');
  const skill = files[2]!.text;
  expect(skill).toContain('canonical schema');
  expect(skill).not.toContain('Read .ia/adopted/');
  // A check plans the three files and writes none of them, nor anything under the adopted mount.
  expect(generateProjections(base, false)).toHaveLength(3);
  expect(existsSync(resolve(base, '.claude'))).toBe(false);
  expect(existsSync(resolve(base, 'CLAUDE.md'))).toBe(false);
  expect(existsSync(resolve(base, '.ia/adopted'))).toBe(false);
  expect(existsSync(resolve(base, '.ia/src/systems/governance-system/system.ia'))).toBe(false);
  expect(readFileSync(source)).toEqual(before);
});

it('renders byte-equal files for the same adopted tree at two roots, naming neither', () => {
  const [first, second] = [fixture(), fixture()].map((base) => ({ base, files: renderProjections(base) }));
  expect(JSON.stringify(second!.files)).toBe(JSON.stringify(first!.files));
  for (const { base, files } of [first!, second!])
    for (const file of files)
      for (const spelling of [base, base.replaceAll('\\', '/')]) expect(file.text).not.toContain(spelling);
});

it('refuses changed immutable source bytes before generation', () => {
  const base = fixture(),
    path = resolve(base, 'vendor/foundation/.ia/src/systems/governance-system/system.ia');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n# Changed after pinning\n');
  expect(() => generateProjections(base, false)).toThrow('Pinned source revision differs');
  expect(existsSync(resolve(base, '.claude'))).toBe(false);
});
