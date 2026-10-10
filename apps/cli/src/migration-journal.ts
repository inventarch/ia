import { lstatSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from '@inventarch/db/distribution';
import {
  createFile,
  readInstalledState,
  readWorkspaceFile,
  readWorkspaceJson,
  replace,
} from '@inventarch/distribution/services';
import { Refusal } from './consumer.js';
import { quote } from './render.js';
import type { BasePin, MigrationView } from './init.js';

export const MIGRATION_JOURNAL = '.ia/migration.json';
type State = { readonly digest: string; readonly bytes: string } | 'directory' | null;
interface Operation {
  readonly path: string;
  readonly before: State;
  readonly after: State;
  readonly step: string;
}
export interface MigrationJournal {
  readonly format: 'ia-migration-1';
  readonly view: MigrationView;
  readonly operations: readonly Operation[];
  readonly digest: string;
  readonly lockDigest: string;
  readonly receiptsBefore: Readonly<Record<string, string | null>>;
  readonly removals: Readonly<Record<string, readonly { path: string; sha256: string }[]>>;
  readonly completed: Record<string, string>;
  cursor: number;
}
const refused = (path: string, message: string, root: string, system = false): Refusal =>
  new Refusal(
    'IA-CLI-CONFLICT',
    message,
    3,
    { path },
    `Preserve the journal and restore the named path to its recorded bytes, then run "ia init ${quote(root)} --migrate${system ? ' --system' : ''} --apply --yes".`,
  );
function state(root: string, path: string): State {
  const segments = path.replace(/\/$/, '').split('/');
  for (let end = 1; end < segments.length; end++) {
    const ancestor = segments.slice(0, end).join('/');
    const entry = lstatSync(resolve(root, ancestor), { throwIfNoEntry: false });
    if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw refused(ancestor, 'Migration ancestor is not a plain directory', root);
  }
  const stat = lstatSync(resolve(root, path), { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw refused(path, 'Migration path is not a plain file or directory', root);
  if (stat.isDirectory()) return 'directory';
  const bytes = readWorkspaceFile({ root, path });
  return { digest: sha256(bytes), bytes: bytes.toString('base64') };
}
const file = (bytes: Buffer): State => ({ digest: sha256(bytes), bytes: bytes.toString('base64') });
const equal = (left: State, right: State): boolean =>
  typeof left === 'object' && left !== null && typeof right === 'object' && right !== null
    ? left.digest === right.digest
    : left === right;
const digest = (
  view: MigrationView,
  operations: readonly Operation[],
  lockDigest: string,
  receiptsBefore: Readonly<Record<string, string | null>>,
  removals: MigrationJournal['removals'],
): string => sha256(Buffer.from(JSON.stringify({ view, operations, lockDigest, receiptsBefore, removals })));
function check(journal: MigrationJournal): void {
  const { root } = journal.view;
  if (sha256(readWorkspaceFile({ root, path: '.ia/distributions.lock.json' })) !== journal.lockDigest) {
    const lock = readInstalledState({ root }).lock;
    const pin = journal.view.base.pin;
    const pkg = lock?.packages[0];
    if (
      !journal.view.steps.includes('install') ||
      lock?.packages.length !== 1 ||
      lock.requests.length !== 1 ||
      lock.requests[0]?.id !== pin.id ||
      lock.requests[0]?.range !== `^${pin.version}` ||
      pkg?.id !== pin.id ||
      pkg.version !== pin.version ||
      pkg.archive !== pin.archive ||
      pkg.manifest !== pin.manifest
    )
      throw refused(
        '.ia/distributions.lock.json',
        'Installation lock differs from this migration operation',
        root,
        journal.view.system,
      );
  }

  for (const [host, expected] of Object.entries(journal.completed)) {
    const path = `.ia/distributions/hosts/${host}-receipt.json`;
    if (
      !journal.view.hosts.some((row) => row.host === host) ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      sha256(readWorkspaceFile({ root, path })) !== expected
    )
      throw refused(path, 'Completed migration projection receipt changed', root, journal.view.system);
  }
  for (let index = 0; index < journal.operations.length; index++) {
    const operation = journal.operations[index]!;
    const actual = state(journal.view.root, operation.path);
    const expected = index < journal.cursor ? operation.after : operation.before;
    if (!equal(actual, expected) && !(index === journal.cursor && equal(actual, operation.after)))
      throw refused(
        operation.path,
        'Migration path differs from its recorded before/after digest; no recovery writes were made',
        journal.view.root,
        journal.view.system,
      );
  }
}
export function readMigrationJournal(root: string, system: boolean, pin: BasePin): MigrationJournal | null {
  if (lstatSync(resolve(root, MIGRATION_JOURNAL), { throwIfNoEntry: false }) === undefined) return null;
  let journal: MigrationJournal;
  try {
    journal = readWorkspaceJson({ root, path: MIGRATION_JOURNAL }) as MigrationJournal;
    if (
      journal.format !== 'ia-migration-1' ||
      journal.view.root !== root ||
      journal.view.system !== system ||
      !/^[a-z][a-z0-9-]*$/.test(journal.view.name) ||
      journal.view.conflicts.length !== 0 ||
      JSON.stringify(journal.view.base.pin) !== JSON.stringify(pin) ||
      !Array.isArray(journal.operations) ||
      journal.completed === null ||
      typeof journal.completed !== 'object' ||
      Array.isArray(journal.completed) ||
      journal.receiptsBefore === null ||
      typeof journal.receiptsBefore !== 'object' ||
      journal.removals === null ||
      typeof journal.removals !== 'object' ||
      !Number.isInteger(journal.cursor) ||
      journal.cursor < 0 ||
      journal.cursor > journal.operations.length ||
      journal.digest !==
        digest(journal.view, journal.operations, journal.lockDigest, journal.receiptsBefore, journal.removals)
    )
      throw new Error('Journal schema, root, options, base or digest differs');
    const seen = new Set<string>();
    for (const operation of journal.operations) {
      if (
        typeof operation.path !== 'string' ||
        operation.path.split('/').some((part: string) => part === '..' || part === '.') ||
        operation.path.includes('\\') ||
        !(
          operation.path.startsWith('.ia/src/') ||
          operation.path === '.ia/release.json' ||
          operation.path === '.ia/.gitignore'
        ) ||
        operation.path.includes(':') ||
        operation.path.includes('\0') ||
        seen.has(operation.path)
      )
        throw new Error('Invalid or repeated operation path');
      seen.add(operation.path);
      for (const value of [operation.before, operation.after])
        if (
          value !== null &&
          value !== 'directory' &&
          (typeof value !== 'object' ||
            typeof value.bytes !== 'string' ||
            sha256(Buffer.from(value.bytes, 'base64')) !== value.digest)
        )
          throw new Error('Invalid operation bytes');
    }
  } catch (error) {
    throw refused(
      MIGRATION_JOURNAL,
      `Cannot resume migration: ${error instanceof Error ? error.message : String(error)}`,
      root,
      system,
    );
  }
  check(journal);
  return journal;
}
export function beginMigrationJournal(view: MigrationView, ignore: string): MigrationJournal {
  const operations: Operation[] = [];
  const add = (path: string, after: State, step: string): void => {
    operations.push({ path, before: state(view.root, path), after, step });
  };
  for (const move of view.moves) {
    add(move.to, file(readWorkspaceFile({ root: view.root, path: move.from })), 'move');
    add(move.from, null, 'move');
  }
  for (const authored of view.files) add(authored.path, file(Buffer.from(authored.text)), 'author');
  if (view.ignore === 'create') add('.ia/.gitignore', file(Buffer.from(ignore)), 'author');
  for (const removal of view.removes) add(removal.path, null, 'remove');
  add(
    '.ia/release.json',
    view.rewrite === null ? state(view.root, '.ia/release.json') : file(Buffer.from(view.rewrite)),
    'descriptor',
  );
  const lockDigest = sha256(readWorkspaceFile({ root: view.root, path: '.ia/distributions.lock.json' }));
  const receiptsBefore = Object.fromEntries(
    view.hosts.map(({ host }) => {
      const value = state(view.root, `.ia/distributions/hosts/${host}-receipt.json`);
      return [host, value === null ? null : typeof value === 'object' ? value.digest : 'invalid'];
    }),
  );
  const removals = Object.fromEntries(
    view.hosts.map(({ host, files }) => [
      host,
      files
        .filter((row) => row.action === 'remove')
        .map((row) => ({ path: row.path, sha256: sha256(readWorkspaceFile({ root: view.root, path: row.path })) })),
    ]),
  );
  const journal: MigrationJournal = {
    format: 'ia-migration-1',
    view,
    operations,
    lockDigest,
    receiptsBefore,
    removals,
    completed: {},
    digest: digest(view, operations, lockDigest, receiptsBefore, removals),
    cursor: 0,
  };
  createFile(view.root, MIGRATION_JOURNAL, Buffer.from(JSON.stringify(journal)));
  return journal;
}
export function applyMigrationFiles(
  journal: MigrationJournal,
  checkpoint: (name: string) => void,
  signal?: AbortSignal,
): void {
  check(journal);
  while (journal.cursor < journal.operations.length) {
    signal?.throwIfAborted();
    check(journal);
    const operation = journal.operations[journal.cursor]!;
    if (!equal(state(journal.view.root, operation.path), operation.after)) {
      if (operation.after === null) {
        if (operation.before === 'directory') rmdirSync(resolve(journal.view.root, operation.path));
        else replace(journal.view.root, operation.path, null);
      } else if (operation.after !== 'directory') {
        const bytes = Buffer.from(operation.after.bytes, 'base64');
        if (operation.before === null) createFile(journal.view.root, operation.path, bytes);
        else replace(journal.view.root, operation.path, bytes);
      }
      // Deliberately before the cursor write: a process killed here resumes by exact after digest.
      checkpoint(`migrate:mutation:${journal.cursor}:${operation.path}`);
    }
    journal.cursor++;
    replace(journal.view.root, MIGRATION_JOURNAL, Buffer.from(JSON.stringify(journal)));
    if (journal.operations[journal.cursor]?.step !== operation.step) checkpoint(`migrate:${operation.step}`);
  }
}
export function finishMigrationJournal(root: string): void {
  replace(root, MIGRATION_JOURNAL, null);
}

export function completeMigrationProjection(journal: MigrationJournal, host: string): void {
  journal.completed[host] = sha256(
    readWorkspaceFile({ root: journal.view.root, path: `.ia/distributions/hosts/${host}-receipt.json` }),
  );
  replace(journal.view.root, MIGRATION_JOURNAL, Buffer.from(JSON.stringify(journal)));
}
