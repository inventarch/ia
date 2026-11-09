/**
 * The release gate for `inventarch/language` bases. A base change that could invalidate existing records must be a
 * major (or carry a migration); a purely additive change is a minor; a label-only change is a patch. The gate compares
 * the last published base (the ledger's newest) with the base this tree builds, classifies the difference between their
 * schema catalogues, and fails when the `inventarch/language` entry of `releases/native/notes.json` bumps less than the
 * class needs. It also fails when the published `ia-kb` method fixture kit no longer proves on the candidate base
 * (`ia floor --verify`), so kits are reassessed only when they must be.
 *
 * `--check` runs the gate against this checkout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { BaseCatalogue, CatalogueWord } from '../../packages/db/src/distribution/index.js';
import { isEntry } from '../entry/is-entry.mjs';
import { BASE_ID, buildLanguageBase } from '../native/language-base.js';
import { ledgerArchive, readBaseLedger } from '../native/language-bases.js';
import { baseCatalogue } from '../native/language-compat.js';
import { NATIVE_NOTES } from './native-version.js';

export type ChangeClass = 'label' | 'additive' | 'breaking' | 'unclassified';
export type Bump = 'patch' | 'minor' | 'major';
export interface BaseChange {
  readonly kind: string;
  readonly key: string;
}

/** The compatibility class of each change kind; the base's class is the worst of its changes. */
const CLASS: Readonly<Record<string, 'additive' | 'breaking' | 'unclassified'>> = {
  'word-removed': 'breaking',
  'section-removed': 'breaking',
  'field-removed': 'breaking',
  'edge-removed': 'breaking',
  'type-changed': 'breaking',
  'target-changed': 'breaking',
  'values-narrowed': 'breaking',
  'section-required': 'breaking',
  'field-required': 'breaking',
  'edge-required': 'breaking',
  'section-added-required': 'breaking',
  'field-added-required': 'breaking',
  'edge-added-required': 'breaking',
  'word-closed': 'breaking',
  'word-added': 'additive',
  'section-added': 'additive',
  'field-added': 'additive',
  'edge-added': 'additive',
  'values-widened': 'additive',
  'section-relaxed': 'additive',
  'field-relaxed': 'additive',
  'edge-relaxed': 'additive',
  'word-opened': 'additive',
  'language-record-changed': 'unclassified',
  'engine-changed': 'unclassified',
};
const RANK = { label: 0, additive: 1, unclassified: 2, breaking: 3 } as const;
const BUMPS: readonly Bump[] = ['patch', 'minor', 'major'];

/** Members of one kind (sections, fields, edges) compared by key. */
function compareMembers<T extends { required: boolean }>(
  noun: string,
  word: string,
  previous: readonly T[],
  next: readonly T[],
  key: (member: T) => string,
  changes: BaseChange[],
  detail?: (key: string, before: T, after: T) => void,
): void {
  const after = new Map(next.map((member) => [key(member), member]));
  const before = new Map(previous.map((member) => [key(member), member]));
  for (const [name, member] of before) {
    const now = after.get(name);
    if (now === undefined) changes.push({ kind: `${noun}-removed`, key: `${word}.${name}` });
    else {
      if (!member.required && now.required) changes.push({ kind: `${noun}-required`, key: `${word}.${name}` });
      if (member.required && !now.required) changes.push({ kind: `${noun}-relaxed`, key: `${word}.${name}` });
      detail?.(name, member, now);
    }
  }
  for (const [name, member] of after)
    if (!before.has(name))
      changes.push({ kind: member.required ? `${noun}-added-required` : `${noun}-added`, key: `${word}.${name}` });
}

function compareWord(name: string, previous: CatalogueWord, next: CatalogueWord, changes: BaseChange[]): void {
  if (!previous.closed && next.closed) changes.push({ kind: 'word-closed', key: name });
  if (previous.closed && !next.closed) changes.push({ kind: 'word-opened', key: name });
  compareMembers('section', name, previous.sections, next.sections, (section) => section.name, changes);
  compareMembers(
    'field',
    name,
    previous.fields,
    next.fields,
    (field) => field.path,
    changes,
    (path, before, after) => {
      const key = `${name}.${path}`;
      if (before.type !== after.type) changes.push({ kind: 'type-changed', key });
      if ((before.target ?? '') !== (after.target ?? '')) changes.push({ kind: 'target-changed', key });
      if (before.values === undefined && after.values !== undefined) changes.push({ kind: 'values-narrowed', key });
      else if (before.values !== undefined && after.values === undefined) changes.push({ kind: 'values-widened', key });
      else if (before.values !== undefined && after.values !== undefined) {
        const kept = new Set(after.values);
        const known = new Set(before.values);
        if (before.values.some((value) => !kept.has(value))) changes.push({ kind: 'values-narrowed', key });
        else if (after.values.some((value) => !known.has(value))) changes.push({ kind: 'values-widened', key });
      }
    },
  );
  compareMembers('edge', name, previous.edges, next.edges, (edge) => `${edge.predicate}/${edge.direction}`, changes);
}

/** The class of the change from `previous` to `next`, and every difference that sets it. */
export function classifyBaseChange(
  previous: BaseCatalogue,
  next: BaseCatalogue,
): { kind: ChangeClass; changes: BaseChange[] } {
  const changes: BaseChange[] = [];
  for (const [name, word] of Object.entries(previous.words)) {
    const now = next.words[name];
    if (now === undefined) changes.push({ kind: 'word-removed', key: name });
    else compareWord(name, word, now, changes);
  }
  for (const name of Object.keys(next.words))
    if (!(name in previous.words)) changes.push({ kind: 'word-added', key: name });
  if (previous.languageRecord !== next.languageRecord)
    changes.push({ kind: 'language-record-changed', key: 'records/language.ia' });
  if (previous.engine !== next.engine) changes.push({ kind: 'engine-changed', key: 'engine' });
  let kind: ChangeClass = 'label';
  for (const change of changes) {
    const class_ = CLASS[change.kind]!;
    if (RANK[class_] > RANK[kind]) kind = class_;
  }
  return { kind, changes };
}

/** The least bump a change class needs; an unclassified change that was reviewed as additive needs a minor. */
export function minimumBump(kind: ChangeClass, compatibility?: string): Bump {
  if (kind === 'label') return 'patch';
  if (kind === 'additive') return 'minor';
  if (kind === 'unclassified' && compatibility === 'reviewed-additive') return 'minor';
  return 'major';
}

export interface GateInput {
  readonly previous: BaseCatalogue;
  readonly next: BaseCatalogue;
  /** The `inventarch/language` entry of the native release notes, when there is one. */
  readonly notes: { readonly bump: string; readonly compatibility?: string } | undefined;
  /** Proves the method fixture kit on the candidate base; run only when the base changed. */
  readonly verify: () => { ok: boolean; detail: string };
}

export function checkLanguageCompat(input: GateInput): {
  kind: ChangeClass;
  changes: BaseChange[];
  failures: string[];
} {
  const { previous, next, notes } = input;
  if (previous.archive === next.archive) return { kind: 'label', changes: [], failures: [] };
  const { kind, changes } = classifyBaseChange(previous, next);
  const failures: string[] = [];
  const needed = minimumBump(kind, notes?.compatibility);
  const list = changes.map((change) => `${change.kind} ${change.key}`).join('; ');
  if (notes === undefined)
    failures.push(
      `${BASE_ID} ${previous.version} -> ${next.version} is ${kind}${list ? ` (${list})` : ''}: ${NATIVE_NOTES} needs an ${BASE_ID} entry with at least a ${needed} bump`,
    );
  else if (!BUMPS.includes(notes.bump as Bump) || BUMPS.indexOf(notes.bump as Bump) < BUMPS.indexOf(needed))
    failures.push(
      `${BASE_ID} ${previous.version} -> ${next.version} is ${kind}${list ? ` (${list})` : ''}: the notes bump ${notes.bump}, below the ${needed} it needs`,
    );
  const proof = input.verify();
  if (!proof.ok) failures.push(`ia floor --verify of the method fixture kit fails on ${next.version}: ${proof.detail}`);
  return { kind, changes, failures };
}

/** `ia floor --verify` on the published `ia-kb` method fixture kit, with the CLI built in this checkout. */
export function verifyFixtureKit(root: string): { ok: boolean; detail: string } {
  const bin = resolve(root, 'apps/cli/dist/bin.js');
  if (!existsSync(bin)) return { ok: false, detail: `${bin} is not built; run pnpm build first` };
  const scratch = mkdtempSync(resolve(tmpdir(), 'language-compat-gate-'));
  try {
    const published = JSON.parse(
      gunzipSync(readFileSync(resolve(root, 'apps/mcp-door/tests/fixtures/method/plugin.json.gz'))).toString('utf8'),
    ) as Record<string, string>;
    const kit = resolve(scratch, 'ia-kb');
    for (const [path, text] of Object.entries(published))
      if (path.startsWith('config/kits/ia-kb/')) {
        const target = resolve(kit, path.slice('config/kits/ia-kb/'.length));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
    const run = spawnSync(process.execPath, [bin, 'floor', '--root', kit, '--verify', '--json'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return run.status === 0
      ? { ok: true, detail: '' }
      : { ok: false, detail: (run.stdout + run.stderr).trim().slice(0, 2000) || `exit ${String(run.status)}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The gate on a checkout: the newest published base against the base this tree builds. */
export function languageCompatGate(root: string) {
  const ledger = readBaseLedger(root);
  const newest = ledger.bases[ledger.bases.length - 1];
  if (newest === undefined) throw new Error('The language base ledger lists no base');
  const built = buildLanguageBase(root);
  const previous = baseCatalogue(ledgerArchive(root, newest), newest.archive);
  const next = baseCatalogue(built.bytes, built.pin.archive);
  const file = JSON.parse(readFileSync(resolve(root, NATIVE_NOTES), 'utf8')) as {
    changes: { id: string; bump: string; compatibility?: string }[];
  };
  const notes = file.changes.find((change) => change.id === BASE_ID);
  return checkLanguageCompat({ previous, next, notes, verify: () => verifyFixtureKit(root) });
}

if (isEntry(process.argv[1], import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = languageCompatGate(root);
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(failure);
    process.exit(1);
  }
  console.log(`Language base compatibility gate passed (${result.kind}).`);
}
