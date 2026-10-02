import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  DECISIONS,
  decisionFor,
  forgetDecision,
  nextLocalMidnight,
  readDecisions,
  recordDecision,
  repositoryKey,
} from '../src/decisions.js';

const made: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ia-decisions-'));
  made.push(p);
  return p;
};
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});

it('keys a subdirectory by its git top level, case-folded on Windows', () => {
  const repo = temp();
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'a/b'), { recursive: true });
  expect(repositoryKey(join(repo, 'a/b'), 'linux').path).toBe(repositoryKey(repo, 'linux').path);
  expect(repositoryKey(repo, 'win32').key).toBe(repositoryKey(repo, 'win32').path.toLowerCase());
});
it('expires "today" at the next local midnight and keeps "forever"', () => {
  const home = join(temp(), '.ia'),
    repo = temp(),
    late = new Date(2026, 8, 23, 23, 30);
  const today = recordDecision(home, repo, 'today', 'claude', late);
  expect(today.until).toBe(nextLocalMidnight(late).toISOString());
  expect(decisionFor(home, repo, new Date(2026, 8, 23, 23, 59))?.decision).toBe('declined-today');
  expect(decisionFor(home, repo, new Date(2026, 8, 24, 0, 0))).toBeNull();
  recordDecision(home, repo, 'forever', 'claude', late);
  expect(decisionFor(home, repo, new Date(2030, 0, 1))?.decision).toBe('declined-forever');
  expect(forgetDecision(home, repo)).toBe(true);
  expect(decisionFor(home, repo)).toBeNull();
  expect(forgetDecision(home, repo)).toBe(false);
});
it('reads an invalid file as empty, refuses to write over it, and leaves it untouched', () => {
  const home = join(temp(), '.ia'),
    repo = temp();
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, DECISIONS), '{broken');
  expect(readDecisions(home)).toEqual({ repositories: {}, invalid: true, reason: 'parse' });
  expect(() => recordDecision(home, repo, 'today', 'claude')).toThrow(
    expect.objectContaining({ code: 'IA-DIST-INPUT-INVALID' }),
  );
  expect(readFileSync(join(home, DECISIONS), 'utf8')).toBe('{broken');
});
it('records the documented on-disk shape under the IA home', () => {
  const home = join(temp(), '.ia'),
    repo = temp(),
    now = new Date(2026, 8, 23, 12, 0);
  mkdirSync(join(repo, '.git'));
  const decision = recordDecision(home, repo, 'today', 'claude', now);
  const { key, path } = repositoryKey(repo);
  const onDisk = JSON.parse(readFileSync(join(home, DECISIONS), 'utf8')) as unknown;
  expect(onDisk).toEqual({
    schema: 'ia.decisions.v1',
    repositories: {
      [key]: { decision: 'declined-today', at: decision.at, until: decision.until, host: 'claude', path },
    },
  });
});
it('drops an expired entry on the next write and keeps a live one', () => {
  const home = join(temp(), '.ia'),
    repoA = temp(),
    repoB = temp();
  mkdirSync(join(repoA, '.git'));
  mkdirSync(join(repoB, '.git'));
  recordDecision(home, repoA, 'today', 'claude', new Date(2026, 8, 23, 23, 30));
  recordDecision(home, repoB, 'today', 'claude', new Date(2026, 8, 24, 0, 30));
  const onDisk = JSON.parse(readFileSync(join(home, DECISIONS), 'utf8')) as { repositories: Record<string, unknown> };
  expect(Object.hasOwn(onDisk.repositories, repositoryKey(repoA).key)).toBe(false);
  expect(Object.hasOwn(onDisk.repositories, repositoryKey(repoB).key)).toBe(true);
});
it('forgetDecision refuses on an invalid file and leaves it untouched', () => {
  const home = join(temp(), '.ia'),
    repo = temp();
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, DECISIONS), '{broken');
  expect(() => forgetDecision(home, repo)).toThrow(expect.objectContaining({ code: 'IA-DIST-INPUT-INVALID' }));
  expect(readFileSync(join(home, DECISIONS), 'utf8')).toBe('{broken');
});
it('keys a not-yet-existing path under a directory link the same before and after it exists', () => {
  const base = temp(),
    real = join(base, 'real'),
    link = join(base, 'link');
  mkdirSync(real, { recursive: true });
  try {
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  const before = repositoryKey(join(link, 'new'));
  mkdirSync(join(real, 'new'));
  const after = repositoryKey(join(link, 'new'));
  expect(before.key).toBe(after.key);
});
it('an entry with an unparseable "until" makes the file invalid with reason \'schema\'', () => {
  const home = join(temp(), '.ia');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(
    join(home, DECISIONS),
    JSON.stringify({
      schema: 'ia.decisions.v1',
      repositories: {
        x: {
          decision: 'declined-today',
          at: new Date().toISOString(),
          until: 'not-a-date',
          host: 'claude',
          path: '/x',
        },
      },
    }),
  );
  expect(readDecisions(home)).toEqual({ repositories: {}, invalid: true, reason: 'schema' });
});
it('a directory where the decisions file should be reads as invalid with a filesystem reason', () => {
  const home = join(temp(), '.ia');
  mkdirSync(join(home, DECISIONS), { recursive: true });
  const result = readDecisions(home);
  expect(result.invalid).toBe(true);
  expect(typeof result.reason).toBe('string');
  expect(result.reason?.length).toBeGreaterThan(0);
  expect(result.reason).not.toBe('parse');
  expect(result.reason).not.toBe('schema');
});
