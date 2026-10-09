import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { afterEach, vi } from 'vitest';
import { open, readInputs } from '@inventarch/db';
import type { Handle, OpenOptions } from '@inventarch/db';
import { stableSerialize } from '@inventarch/graph';

// Files importing this helper exercise real native-corpus admission and disk I/O.
// CI has measured otherwise identical fixtures at 1–10s across runs. Keep their
// bounded integration allowance here; pure tests and production limits retain theirs.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const temporary: string[] = [],
  handles: Handle[] = [];
export const methodPath = '.ia/src/systems/governance-system/records/sample-procedure.ia';
export const methodId = 'governance-system/definition/procedure/sample-procedure';
export const lawPath = '.ia/src/systems/governance-system/records/sample-rule.ia';
export const lawId = 'governance-system/governance/law/sample-rule';
export const workspacePath = '.ia/src/systems/workspace-system/records/foundation-workspace.ia';
/** The three records of plan T6 step 1 that a fresh init authors (B13), for the packet tests. */
export const packetFixture = resolve(import.meta.dirname, 'fixtures/packet/workspace.ia');
const conformance = resolve(import.meta.dirname, '../../../examples/conformance/native');
export function workspace(source: string | null = conformance): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-runtime-tests-'));
  temporary.push(root);
  if (source !== null)
    cpSync(source, resolve(root, '.ia/src'), {
      recursive: true,
      filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
    });
  return root;
}
export function put(root: string, path: string, text: string): void {
  const target = resolve(root, path);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, text);
}
/** The foundation workspace declaring `sources`, so the records under them are its capture members. */
export function declare(root: string, sources: readonly string[]): void {
  const text = readFileSync(resolve(root, workspacePath), 'utf8');
  put(
    root,
    workspacePath,
    text.replace(
      '  relationships\n',
      `    sources [${sources.map((s) => JSON.stringify(s)).join(', ')}]\n  relationships\n`,
    ),
  );
}
/**
 * A fresh init (plan T6 step 1): the three records an `ia init` authors at `.ia/src/workspace.ia`, over the conformance
 * corpus adopted at band 90 as the installed base would be, so the authored root holds those three records alone.
 * `vendored` adds files to the installed base before its revision is pinned.
 */
export function freshInit(
  records = readFileSync(packetFixture, 'utf8'),
  vendored: Readonly<Record<string, string>> = {},
): string {
  const root = workspace(null),
    vendor = 'vendor/foundation';
  cpSync(conformance, resolve(root, vendor, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(vendored)) put(root, `${vendor}/${path}`, text);
  const pinned = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = createHash('sha256').update(stableSerialize(pinned)).digest('hex');
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  put(root, '.ia/src/workspace.ia', records);
  return root;
}
export function database(root: string, options: OpenOptions = {}): Handle {
  const db = open(root, { cache: false, ...options });
  handles.push(db);
  return db;
}
/** Every file under `root`, by path, hashed with its bytes, to show a read wrote nothing. */
export function tree(root: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), `${path}/`);
      else
        hash
          .update(`${path}\0`)
          .update(readFileSync(resolve(directory, entry.name)))
          .update('\0');
    }
  };
  walk(root, '');
  return hash.digest('hex');
}
/** A fixture @law of `severity`, `more` appended as further sections. */
export function law(name: string, severity: string, more = ''): string {
  return `#! ia 1.0\n@law ${name}\n  meaning\n    says "Fixture law ${name}."\n    answers "What does ${name} require?"\n  governance\n    severity ${severity}\n${more}`;
}
export function playbook(
  name: string,
  body = '',
  cognition = '    orient\n      primary Memory\n      Memory means "Fallback fixture memory"\n',
): string {
  return `#! ia 1.0\n@playbook ${name}\n  meaning\n    says "Fixture procedure ${name}"\n    answers "What does this procedure do?"\n  cognition\n${cognition}${body}`;
}
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of temporary.splice(0)) {
    const path = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(path) || !path.startsWith('ia-runtime-tests-') || path.includes('..'))
      throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
