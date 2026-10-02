import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fail } from './files.js';
import { readHomeFile, writeHomeFile } from './ia-home.js';

/** Host plugin distribution spec §9: answers to "initialize this repository?", kept in the IA home, never in the repository. */
export const DECISIONS = 'state/decisions.json';
export type DeclineKind = 'today' | 'forever';
export interface Decision {
  readonly decision: 'declined-today' | 'declined-forever';
  readonly at: string;
  readonly until?: string;
  readonly host: string;
  readonly path: string;
}
/** The realpath of the deepest existing ancestor of `directory`, with any not-yet-created tail segments appended literally: a decline recorded before `mkdir` then keys identically to one recorded after. `realpathSync.native` resolves links/junctions in the prefix and Windows 8.3 short names (e.g. `PROGRA~1`); `realpathSync` is the fallback if the native call throws. */
function realPrefix(directory: string): string {
  const target = resolve(directory);
  const remaining: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    remaining.unshift(basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(current);
  } catch {
    try {
      real = realpathSync(current);
    } catch {
      real = current;
    }
  }
  return remaining.length > 0 ? join(real, ...remaining) : real;
}
/** §9.1: the git top level when inside a work tree, else the directory; its real path, case-folded on Windows. */
export function repositoryKey(
  directory: string,
  platform: string = process.platform,
): { readonly key: string; readonly path: string } {
  const start = realPrefix(directory);
  let path = start;
  for (let current = start; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) {
      path = current;
      break;
    }
    if (dirname(current) === current) break;
  }
  return { key: platform === 'win32' ? path.toLowerCase() : path, path };
}
export const nextLocalMidnight = (at: Date): Date => new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
const validAt = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
/** A shape the writer below can produce: `at` and any `until` must be parseable timestamps, `declined-today` always carries `until` and `declined-forever` never does. */
const shaped = (value: unknown): value is Decision => {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (!validAt(row['at']) || typeof row['host'] !== 'string' || typeof row['path'] !== 'string') return false;
  return row['decision'] === 'declined-forever'
    ? row['until'] === undefined
    : row['decision'] === 'declined-today' && validAt(row['until']);
};
/** §9.2: an unreadable or malformed file reads as empty and says so. `reason` is the filesystem error's `code`, `'parse'` for JSON that does not parse, or `'schema'` for a wrong/missing schema or a row that fails `shaped`. */
export function readDecisions(home: string): {
  readonly repositories: Readonly<Record<string, Decision>>;
  readonly invalid: boolean;
  readonly reason?: string;
} {
  let text: string | null;
  try {
    text = readHomeFile(home, DECISIONS);
  } catch (error) {
    return { repositories: {}, invalid: true, reason: (error as NodeJS.ErrnoException).code ?? 'unknown' };
  }
  if (text === null) return { repositories: {}, invalid: false };
  let value: { schema?: unknown; repositories?: unknown };
  try {
    value = JSON.parse(text) as { schema?: unknown; repositories?: unknown };
  } catch {
    return { repositories: {}, invalid: true, reason: 'parse' };
  }
  const rows = value.repositories;
  if (
    value.schema !== 'ia.decisions.v1' ||
    rows === null ||
    typeof rows !== 'object' ||
    Array.isArray(rows) ||
    !Object.values(rows).every(shaped)
  )
    return { repositories: {}, invalid: true, reason: 'schema' };
  return { repositories: rows as Record<string, Decision>, invalid: false };
}
const live = (decision: Decision, now: Date): boolean =>
  decision.decision === 'declined-forever' ||
  (decision.until !== undefined && now.getTime() < Date.parse(decision.until));
export function decisionFor(home: string, directory: string, now: Date = new Date()): Decision | null {
  const found = readDecisions(home).repositories[repositoryKey(directory).key];
  return found !== undefined && live(found, now) ? found : null;
}
/** §9.2: never overwrite a file that did not parse; expired entries are dropped on every write. */
function writable(home: string, now: Date): Record<string, Decision> {
  const current = readDecisions(home);
  if (current.invalid) {
    const remedy =
      current.reason === 'parse' || current.reason === 'schema' ? 'fix or delete it' : 'check its permissions';
    fail('INPUT-INVALID', `The decisions file ${join(home, DECISIONS)} cannot be read (${current.reason}); ${remedy}`);
  }
  return Object.fromEntries(Object.entries(current.repositories).filter(([, decision]) => live(decision, now)));
}
const save = (home: string, repositories: Record<string, Decision>): void =>
  writeHomeFile(home, DECISIONS, JSON.stringify({ schema: 'ia.decisions.v1', repositories }, null, 2) + '\n');
export function recordDecision(
  home: string,
  directory: string,
  kind: DeclineKind,
  host: string,
  now: Date = new Date(),
): Decision {
  const repositories = writable(home, now),
    { key, path } = repositoryKey(directory);
  const decision: Decision =
    kind === 'forever'
      ? { decision: 'declined-forever', at: now.toISOString(), host, path }
      : { decision: 'declined-today', at: now.toISOString(), until: nextLocalMidnight(now).toISOString(), host, path };
  save(home, { ...repositories, [key]: decision });
  return decision;
}
export function forgetDecision(home: string, directory: string, now: Date = new Date()): boolean {
  const repositories = writable(home, now),
    { key } = repositoryKey(directory);
  if (!Object.hasOwn(repositories, key)) return false;
  delete repositories[key];
  save(home, repositories);
  return true;
}
