/**
 * `ia preview`: the read-only half of record authoring (milestone generation-binding plan amendments C18 and C19, lane C
 * round 2), in the validate mode, whose move is Verification.
 *
 * - `ia preview <word> <name> [field=value ...] [--at <path>]` drafts a new record (language `draftSource`) and appends it
 *   to its file: `--at`, or `<first authored root>/<word>.ia`;
 * - `ia preview --relate <owned> <spelling> <target>` adds one relationship row to an owned record;
 * - `ia preview --set <owned> <section.key>=<value>` (or `+=` for one list item) sets one field of an owned record;
 * - `ia preview <word>` prints the word's lowering, schema, default file and consent.
 *
 * Owned is a record at authored placement (band 100) whose file lies under an authored root the repository's
 * `@workspace` declares in `composition.sources`, inside `.ia/src` and outside the floor, named by canonical identity or
 * `@word name`. The edit is language's (`appendRecord`, `addRelationship`, `setField`): the whole file again, formatted,
 * with one record changed. It is compiled through db's draft overlay (`reader.preview`) against one editor snapshot of the
 * workspace, and printed with the record before and after, the findings it adds, the candidate revision and the target
 * file's current sha256, which `ia author` will require. Every record of the file other than the target keeps its digest,
 * or the preview refuses. The participant's mandate profile is judged first (`profile.ts`). Nothing is written: the
 * snapshot publishes no cache, and every path is checked link by link and its file read through an opened handle.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fieldTypeText } from '@inventarch/compliance';
import { linked, pathKey, readWorkspaceBytes } from '@inventarch/db';
import { mandateAuthorityOf, RuntimeError } from '@inventarch/runtime';
import type { MandateAuthority } from '@inventarch/runtime';
import {
  addRelationship,
  appendRecord,
  draftSource,
  encodeValue,
  relationshipConsent,
  setField,
  SourceEditError,
  VERB_PHRASES,
} from '@inventarch/runtime/editor';
import type { Arguments } from './args.js';
import { UsageError } from './args.js';
import { findCommand, nearestTokens } from './commands.js';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot, respell } from './consumer.js';
import { ADMINISTRATIVE_WORDS, repositoryWorkspace, requireProfile } from './profile.js';
import type { Profile } from './profile.js';
import type { Capabilities, Token } from './render.js';
import {
  atom,
  document,
  entry,
  errorBlock,
  fieldRows,
  headerLine,
  quote,
  sectionLabel,
  terminalText,
  truncateDigest,
  words,
} from './render.js';
import { isSystemName, starterSystem, systemPath } from './init.js';
import { identityNext, openEditor } from './session.js';
import type { Editor } from './session.js';

type Snapshot = ReturnType<typeof openEditor>['snapshot'];
type Node = ReturnType<Snapshot['records']>[number];
type Registry = ReturnType<Snapshot['inspect']>['graph']['registry'];
type Schema = NonNullable<ReturnType<Registry['schemas']['get']>>;
type SchemaField = Schema['fields'][number];
type Finding = Snapshot['report']['findings'][number];

/** One `key=value` (or `key+=value`) argument; `key` is `section.key`, or a key one schema field alone has. */
export interface Assignment {
  readonly key: string;
  readonly append: boolean;
  readonly value: string;
}
export type PreviewRequest =
  | { readonly mode: 'word'; readonly word: string; readonly at?: string }
  | {
      readonly mode: 'record';
      readonly word: string;
      readonly name: string;
      readonly fields: readonly Assignment[];
      readonly at?: string;
    }
  | { readonly mode: 'relate'; readonly owned: string; readonly spelling: string; readonly target: string }
  | { readonly mode: 'set'; readonly owned: string; readonly assignment: Assignment };

const WORD = /^[a-z][a-z0-9-]*$/;
const NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const FRAGMENT = '(?:#[A-Za-z0-9][A-Za-z0-9-]*(?:/[A-Za-z0-9][A-Za-z0-9-]*)*)?';
const IDENTITY = '[a-z][a-z0-9-]*/[a-z][a-z0-9-]*/[a-z][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9-]*';
const ASSIGNMENT = /^([A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)?)(\+?=)([\s\S]*)$/;
/** The bytes a source may hold for its opened-handle read; the db has already read it whole. */
const SOURCE_LIMIT = 16 * 1024 * 1024;
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * One record named across one positional or two: a canonical identity, `@word name` given as one argument, or `@word`
 * then `name` as the shell splits them; `fragment` admits a trailing `#fragment`.
 */
function takeRecord(
  tokens: readonly string[],
  at: number,
  fragment: boolean,
): { readonly spelled: string; readonly next: number } | undefined {
  const tail = fragment ? FRAGMENT : '',
    first = tokens[at]?.trim().replace(/\s+/g, ' ');
  if (first === undefined) return undefined;
  if (new RegExp(`^@[a-z][a-z0-9-]* [A-Za-z][A-Za-z0-9-]*${tail}$`).test(first))
    return { spelled: first, next: at + 1 };
  const name = tokens[at + 1];
  if (
    WORD.test(first.slice(1)) &&
    first.startsWith('@') &&
    name !== undefined &&
    new RegExp(`^[A-Za-z][A-Za-z0-9-]*${tail}$`).test(name)
  )
    return { spelled: `${first} ${name}`, next: at + 2 };
  if (new RegExp(`^${IDENTITY}${tail}$`).test(first)) return { spelled: first, next: at + 1 };
  return undefined;
}
const assignment = (text: string): Assignment | undefined => {
  const match = ASSIGNMENT.exec(text);
  return match === null ? undefined : { key: match[1]!, append: match[2] === '+=', value: match[3]! };
};

/**
 * §2.0: the positionals read into one of the four forms, before any workspace is read, so a malformed form is usage at
 * exit 2. A field value split across arguments by the shell is joined again with single spaces: an argument that does
 * not start `<key>=` continues the value before it.
 */
export function previewRequest(args: Arguments): PreviewRequest {
  const tokens = args.positionals,
    at = args.value('at');
  if (args.flag('relate')) {
    const owned = takeRecord(tokens, 0, false);
    if (owned === undefined) throw new UsageError('Expected <owned> as a canonical identity or @<word> <name>');
    let index = owned.next;
    const verb: string[] = [];
    while (index < tokens.length && !tokens[index]!.startsWith('@') && !tokens[index]!.includes('/'))
      verb.push(tokens[index++]!);
    const spelling = verb.join(' ').trim().replace(/\s+/g, ' ');
    if (!VERB_PHRASES.includes(spelling)) {
      const [near] = nearestTokens(spelling, VERB_PHRASES, 1);
      throw new UsageError(
        spelling === ''
          ? 'Expected <spelling> after <owned>, a relationship verb such as requires'
          : `Unknown relationship verb "${spelling}"${near === undefined ? '' : `; did you mean "${near}"?`}`,
      );
    }
    const target = takeRecord(tokens, index, true);
    if (target === undefined) throw new UsageError('Expected <target> as a canonical identity or @<word> <name>');
    if (target.next < tokens.length) throw new UsageError(`Unexpected argument ${tokens[target.next]}`);
    return { mode: 'relate', owned: owned.spelled, spelling, target: target.spelled };
  }
  if (args.flag('set')) {
    const owned = takeRecord(tokens, 0, false);
    if (owned === undefined) throw new UsageError('Expected <owned> as a canonical identity or @<word> <name>');
    const set = assignment(tokens.slice(owned.next).join(' '));
    if (set === undefined)
      throw new UsageError('Expected <section.key>=<value> or <section.key>+=<value> after <owned>');
    return { mode: 'set', owned: owned.spelled, assignment: set };
  }
  const [word, name, ...rest] = tokens;
  if (word === undefined || !WORD.test(word)) throw new UsageError(`Expected <word> as a lowercase word; got ${word}`);
  if (name === undefined) return { mode: 'word', word, ...(at === undefined ? {} : { at }) };
  if (!NAME.test(name))
    throw new UsageError(`Expected <name> to begin with a letter, then letters, digits or hyphens; got ${name}`);
  // Plan amendment C20: a system is init's starter system, at its own path, with no field to set.
  if (word === 'system' && (rest.length > 0 || at !== undefined))
    throw new UsageError(
      `A new @system is the starter system at ${systemPath('<name>')}; it takes no field and no --at`,
    );
  if (word === 'system' && !isSystemName(name))
    throw new UsageError(`A system name is lowercase letters, digits and hyphens, at most 64; got ${name}`);
  const fields: { key: string; append: boolean; value: string }[] = [];
  for (const token of rest) {
    const set = assignment(token);
    if (set !== undefined) {
      if (set.append) throw new UsageError(`A new record sets each field with =; got ${token}`);
      fields.push({ ...set });
    } else if (fields.length === 0) throw new UsageError(`Expected <field>=<value>; got ${token}`);
    else fields.at(-1)!.value += ` ${token}`;
  }
  return { mode: 'record', word, name, fields, ...(at === undefined ? {} : { at }) };
}

export interface RecordDigest {
  readonly identity: string;
  readonly before: string | null;
  readonly after: string | null;
}
/** The modes a candidate is judged for: `ia preview`'s validate (Verification) or `ia author`'s (Synthesis). */
export type EditMode = 'validate' | 'author';
/** One form's candidate: what the preview reports, the whole new file and its target, and the record as `@word name`. */
export interface Candidate {
  readonly view: PreviewView;
  readonly text: string;
  readonly target: Target;
  readonly reference: string;
}
/** What a preview reports of its edit: the envelope's and the renderer's one input. */
export interface PreviewView {
  readonly mode: 'record' | 'relate' | 'set';
  readonly root: string;
  readonly path: string;
  /** The target file's sha256 as it is now; an absent file reads as empty. */
  readonly digest: string;
  readonly exists: boolean;
  readonly identity: string;
  /** Whether admission holds the record in the candidate; a refused record's findings say why. */
  readonly admitted: boolean;
  /** Every record the target file holds before or after, with its digest at each: only the target's may differ. */
  readonly records: readonly RecordDigest[];
  /** The record's source before the edit (null for a new record) and after it. */
  readonly before: string | null;
  readonly after: string;
  readonly baseRevision: string;
  readonly revision: string;
  readonly findings: readonly Finding[];
  readonly clean: boolean;
  readonly profile: Profile;
}
export interface WordView {
  readonly root: string;
  readonly word: string;
  readonly registration: NonNullable<ReturnType<Registry['registrations']['get']>>;
  readonly schema: Schema | null;
  readonly consent: readonly {
    readonly system: string;
    readonly predicate: string;
    readonly targets: readonly string[] | '*';
    readonly sources: readonly string[] | '*';
  }[];
  readonly file: { readonly path: string; readonly exists: boolean; readonly digest: string } | null;
  /** For `system`, whose new record goes to a file of its own: that file's path, `<name>` in it. */
  readonly template?: string;
  readonly example: string | null;
  readonly profile: Profile;
}

/** The workspace's authored roots, as `composition.sources` declares them, and every declared root, deepest first. */
interface Roots {
  readonly workspace: string | undefined;
  readonly authored: readonly string[];
  readonly declared: readonly { readonly root: string; readonly workspace: string; readonly placement: string }[];
}
const contains = (root: string, path: string): boolean =>
  root === '' || pathKey(path) === pathKey(root) || pathKey(path).startsWith(`${pathKey(root)}/`);
function rootsOf(snapshot: Snapshot, within: string, workspace: string | undefined): Roots {
  const declared = snapshot.roots({ within });
  if (workspace === undefined) return { workspace, authored: [], declared };
  const node = snapshot.get(workspace, { within });
  const spelled = (node?.sections ?? [])
    .filter((section) => section.name === 'composition')
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.key === 'sources' && field.value.kind === 'list' ? field.value.items : [],
    )
    .flatMap((item) =>
      'text' in item ? [item.text.trim().split(/\s+/)[0]!.replace(/^\.\//, '').replace(/\/+$/, '')] : [],
    );
  const order = (root: string): number => {
    const index = spelled.findIndex((text) => pathKey(text) === pathKey(root));
    return index === -1 ? spelled.length : index;
  };
  const authored = declared
    .filter((root) => root.workspace === workspace && root.placement === 'authored')
    .map((root) => root.root)
    .sort((a, b) => order(a) - order(b));
  return { workspace, authored, declared };
}
/** Why `path` is not an owned authored path of the workspace, or undefined when it is. */
function unowned(roots: Roots, path: string): string | undefined {
  if (!pathKey(path).startsWith('.ia/src/') || !path.endsWith('.ia')) return `${path} is no .ia file inside .ia/src`;
  if (pathKey(path).startsWith('.ia/src/floor/')) return `${path} is floor source`;
  const holder = roots.declared.find((root) => contains(root.root, path));
  if (holder === undefined || holder.workspace !== roots.workspace || holder.placement !== 'authored')
    return roots.workspace === undefined
      ? `${path} lies under no authored root: this repository authors no @workspace`
      : `${path} lies under no authored root ${roots.workspace} declares in composition.sources`;
  return undefined;
}
/** The default file for a new `@<word>` record: `<first authored root inside .ia/src>/<word>.ia`. */
const defaultFile = (roots: Roots, word: string): string | undefined => {
  // A root of '' is the whole repository, which holds .ia/src (review C-N5).
  const root = roots.authored.find((candidate) => candidate === '' || contains('.ia/src', candidate));
  return root === undefined ? undefined : `${root === '' ? '.ia/src' : root}/${word}.ia`;
};

export interface Target {
  readonly path: string;
  readonly text: string;
  readonly exists: boolean;
  readonly digest: string;
}
/**
 * The target file as the snapshot admitted it, confirmed byte for byte through db's opened-handle reader; or, for a path
 * no source holds, nothing there yet and no link on the way to it.
 */
function targetFile(
  root: string,
  snapshot: Snapshot,
  path: string,
  again: string,
  spelled: (path: string) => string = () => again,
): Target {
  const source = snapshot.sources.find((candidate) => pathKey(candidate.path) === pathKey(path));
  if (source !== undefined) {
    if (source.path !== path)
      throw new Refusal(
        'IA-DB-PATH-UNSAFE',
        `${path} names the source ${source.path} in another spelling`,
        3,
        { path },
        `Run "${spelled(source.path)}" naming the source as ${source.path}.`,
      );
    let bytes: Uint8Array;
    try {
      bytes = readWorkspaceBytes(root, path, SOURCE_LIMIT);
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code;
      throw new Refusal(
        typeof code === 'string' ? code : 'IA-DB-SOURCE-UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        3,
        { path },
        `Once ${path} is a regular file and nothing else is writing it, run "${again}" again.`,
      );
    }
    if (Buffer.compare(Buffer.from(bytes), Buffer.from(source.text, 'utf8')) !== 0)
      throw new Refusal(
        'IA-DB-SOURCE-CHANGED',
        `File changed during read: ${path}`,
        3,
        { path },
        `Once nothing is writing ${path}, run "${again}" again.`,
      );
    return { path, text: source.text, exists: true, digest: sha256(bytes) };
  }
  const absolute = resolve(root, ...path.split('/'));
  let present: boolean;
  try {
    present = lstatSync(absolute, { throwIfNoEntry: false }) !== undefined || linked(absolute);
  } catch {
    present = true;
  }
  if (present)
    throw new Refusal(
      'IA-DB-PATH-UNSAFE',
      `${path} is not a workspace source, yet something is there or a link lies on the way to it`,
      3,
      { path },
      `Move what is at ${path} aside, then run "${again}".`,
    );
  return { path, text: '', exists: false, digest: sha256('') };
}

/**
 * Review C-R1: `path` as the volume spells it. Each component that exists is named by its directory entry, matched
 * exactly; a component another spelling answers (a case variant on a case-insensitive volume, or an 8.3 short name) is
 * replaced by the entry's own name, found by a case-insensitive match or the volume's real path. Components below the
 * first one that does not exist are kept as typed. A mandate's covers and the authored roots are spelled as the volume
 * spells them, so a path is judged only in that spelling.
 */
function onDisk(root: string, path: string): string {
  const parts = path.split('/'),
    spelled: string[] = [];
  let directory = root;
  for (const [index, part] of parts.entries()) {
    let names: readonly string[];
    try {
      names = readdirSync(directory);
    } catch {
      return [...spelled, ...parts.slice(index)].join('/');
    }
    if (!names.includes(part)) {
      const candidate = join(directory, part);
      let present: boolean;
      try {
        present = lstatSync(candidate, { throwIfNoEntry: false }) !== undefined;
      } catch {
        present = true;
      }
      if (!present) return [...spelled, ...parts.slice(index)].join('/');
      const folded = names.filter((name) => name.toLowerCase() === part.toLowerCase());
      let real: string | undefined = folded.length === 1 ? folded[0] : undefined;
      if (real === undefined)
        try {
          real = basename(realpathSync.native(candidate));
        } catch {
          real = part;
        }
      spelled.push(real);
      directory = join(directory, real);
      continue;
    }
    spelled.push(part);
    directory = join(directory, part);
  }
  return spelled.join('/');
}
/** The typed path, refused when the volume spells an existing part of it otherwise (C-R1), naming that spelling (C-R7). */
function spelledPath(run: Invocation, path: string): string {
  const canonical = onDisk(run.root, path);
  if (canonical === path) return path;
  throw new Refusal(
    'IA-DB-PATH-UNSAFE',
    `${path} names ${canonical} in another spelling`,
    3,
    { path },
    `Run "${previewAgain(run, { options: { at: [canonical] } })}" naming the path as the volume spells it.`,
  );
}

/** The source lines `node` spans in `text`. */
const linesOf = (text: string, node: Pick<Node, 'source'>): string =>
  text
    .split(/\r?\n/)
    .slice(node.source.line - 1, node.source.endLine)
    .join('\n');
/**
 * The record's lines after an edit of it: formatting keeps every line where it is and the edit adds or replaces lines
 * only inside the record, below its header, so the record starts where it did and grows by the lines the file grew by.
 */
const afterLines = (before: string, after: string, node: Pick<Node, 'source'>): string => {
  const lines = (text: string) => text.replace(/\r?\n$/, '').split(/\r?\n/);
  const grown = lines(after).length - lines(before).length;
  return lines(after)
    .slice(node.source.line - 1, node.source.endLine + grown)
    .join('\n');
};
const findingKey = (finding: Finding): string =>
  JSON.stringify([finding.code, finding.path, finding.line, finding.message]);

export interface Invocation {
  readonly context: Context;
  readonly root: string;
  readonly rooted: string;
  readonly snapshot: Snapshot;
  readonly within: string;
  readonly registry: Registry;
  readonly roots: Roots;
}
/**
 * The preview of this invocation's form, `changes` applied: what a refusal of either verb names to rerun, since an
 * author form run again would need a digest the preview prints first.
 */
const previewAgain = (run: Invocation, changes: Parameters<typeof respell>[1] = {}): string =>
  respell({ command: findCommand('preview')!, args: run.context.args }, changes);
const invalid = (message: string, next: string, where: Refusal['where'] = null): Refusal =>
  new Refusal('IA-CLI-EDIT-INVALID', message, 1, where, next);
const guidance = (run: Invocation, word: string): string =>
  `Run "ia preview ${word}${run.rooted}" for the word's schema, fields and consent.`;
/** A language refusal of the edit, as IA-CLI-EDIT-INVALID naming the word's guidance. */
function edited<T>(run: Invocation, word: string, path: string, edit: () => T): T {
  try {
    return edit();
  } catch (error) {
    if (!(error instanceof SourceEditError)) throw error;
    if (error.reason === 'parse' && !error.message.startsWith('The edit'))
      throw invalid(error.message, `Run "ia validate${run.rooted}" for the located findings of ${path}.`, { path });
    throw invalid(error.message, guidance(run, word), { path });
  }
}
/** The admitted record `spelled` names (canonical identity or `@word name`), or undefined. */
function recordNamed(run: Invocation, spelled: string): Node | undefined {
  const [identity, fragment] = spelled.split('#') as [string, string | undefined];
  if (fragment !== undefined && fragment === '') return undefined;
  // `get` refuses an identity the scope does not hold, so an unknown one is looked up among the admitted records.
  if (!identity.startsWith('@'))
    return run.snapshot
      .records({ within: run.within })
      .find((node) => node.identity === identity || node.identity === identity.toLowerCase());
  const [word, name] = identity.slice(1).split(' ') as [string, string];
  const resolved = run.snapshot.resolve({ kind: 'ref', discriminator: word, name }, { within: run.within });
  return resolved.ok ? run.snapshot.get(resolved.identity, { within: run.within }) : undefined;
}
const missing = (run: Invocation, spelled: string): Refusal =>
  new Refusal(
    'IA-CLI-EDIT-MISSING',
    `No admitted record answers ${spelled}`,
    1,
    null,
    spelled.startsWith('@')
      ? `Run "ia inspect${run.rooted}" for the overview of what the workspace admits.`
      : identityNext(run.snapshot, spelled.split('#')[0]!, 'inspect', run.rooted),
  );
/** The owned record a relate or set form edits, or the refusal that it is not one. */
function ownedRecord(run: Invocation, node: Node): void {
  const reason =
    node.band !== 100 || node.placement.kind !== 'authored'
      ? `${node.identity} is at ${node.placement.kind} placement (band ${node.band}), not authored by this workspace`
      : unowned(run.roots, node.source.path);
  if (reason !== undefined) {
    const steward = run.snapshot
      .records({ within: run.within })
      .find((candidate) => candidate.discriminator === 'system' && candidate.name === node.system);
    throw new Refusal(
      'IA-CLI-EDIT-UNOWNED',
      reason,
      1,
      { path: node.source.path, identity: node.identity },
      `Run "ia position --seat ${steward?.identity ?? node.identity}${run.rooted}" for the system that owns ${node.identity}; author a record of your own instead.`,
    );
  }
  if (node.parent !== undefined)
    throw invalid(
      `${node.identity} is nested in ${node.parent}; edit it in its source`,
      guidance(run, node.discriminator),
      {
        path: node.source.path,
        identity: node.identity,
      },
    );
}
/**
 * Review C2-R6 (a lead decision, flagged for the operator): whether a `@mandate` binds the acting participant, so that
 * neither verb may create or change it, before or after the edit; moves pool across the mandates that bind an actor, so
 * a participant that could write one could lift its own restrictions. It binds when its participant resolves to the
 * actor, or when it names no participant and governs where the actor acts: its scope names the workspace, or it claims
 * paths (`covers`). One whose authority the runtime cannot read binds too, since it would refuse every gated command
 * here. Mandates are cooperative: a human, or another participant, still makes the change.
 */
function bindsActor(run: Invocation, node: Node, profile: Profile): boolean {
  if (node.discriminator !== 'mandate') return false;
  let authority: MandateAuthority;
  try {
    authority = mandateAuthorityOf(node);
  } catch (error) {
    if (error instanceof RuntimeError) return true;
    throw error;
  }
  if (authority.participant !== undefined) {
    if (profile.actor === undefined) return false;
    const resolved = run.snapshot.resolve(
      { kind: 'ref', discriminator: 'agent', name: authority.participant },
      { within: run.within },
    );
    return resolved.ok && resolved.identity === profile.actor;
  }
  const workspace =
    profile.workspace === undefined ? undefined : run.snapshot.get(profile.workspace, { within: run.within })?.name;
  return (
    (authority.covers?.length ?? 0) > 0 ||
    (workspace !== undefined && (authority.scope ?? []).some((name) => name.toLowerCase() === workspace))
  );
}
/** IA-CLI-EDIT-MANDATE when `node`, before or after the edit, is a `@mandate` that binds the acting participant. */
function guardMandate(run: Invocation, node: Node | undefined, profile: Profile, path: string, created: boolean): void {
  if (node === undefined || !bindsActor(run, node, profile)) return;
  const actor = profile.actor ?? 'whoever acts here',
    seat = created ? profile.workspace : node.identity;
  throw new Refusal(
    'IA-CLI-EDIT-MANDATE',
    `${node.identity} ${created ? 'would be a new' : 'is a'} @mandate that binds the acting participant, ${actor}; a participant may not create or change a mandate that binds it`,
    1,
    { path, identity: node.identity },
    seat === undefined
      ? `Run "ia position${run.rooted}" for the mandates that govern here; a human or another participant makes this change.`
      : `Run "ia position --seat ${seat} --shape governance${run.rooted}" for the mandates that bind ${actor}; a human or another participant makes this change.`,
  );
}
/** One schema field by `section.key`, or by a key no other field of the schema has. */
function schemaField(run: Invocation, schema: Schema, word: string, key: string): SchemaField {
  const found = key.includes('.')
    ? schema.fields.filter((field) => `${field.section}.${field.key}` === key)
    : schema.fields.filter((field) => field.key === key);
  if (found.length === 1) return found[0]!;
  throw invalid(
    found.length === 0
      ? `@${word} declares no field ${key}`
      : `${key} names ${found.map((field) => `${field.section}.${field.key}`).join(' and ')}; give it as <section>.<key>`,
    guidance(run, word),
  );
}
function schemaOf(run: Invocation, word: string, name: string): Schema {
  const schema = run.registry.schemas.get(name);
  if (schema === undefined)
    throw invalid(
      `@${word} has no admitted schema ${name}`,
      `Run "ia validate${run.rooted}" for why its schema is not admitted.`,
    );
  return schema;
}

/**
 * Compiles the candidate file through the snapshot's draft overlay and checks the edit stayed on its record: of the
 * records the file holds before or after, only `identity` (or the new record) may change its digest. The findings
 * reported are the target file's and any the candidate adds elsewhere.
 */
function compiled(
  run: Invocation,
  target: Target,
  text: string,
  expected: { readonly identity: string; readonly word: string; readonly name: string },
): {
  identity: string;
  /** The edited (or new) record as the candidate admits it; absent when admission refuses it. */
  node: Node | undefined;
  admitted: boolean;
  records: readonly RecordDigest[];
  revision: string;
  findings: readonly Finding[];
  clean: boolean;
} {
  let candidate: ReturnType<Snapshot['preview']>;
  try {
    candidate = run.snapshot.preview([{ path: target.path, text }]);
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    throw new Refusal(
      typeof code === 'string' ? code : 'IA-DB-DRAFT-INVALID',
      error instanceof Error ? error.message : String(error),
      3,
      { path: target.path },
      `Run "${previewAgain(run, { options: { at: [] } })}" to preview the default file instead.`,
    );
  }
  const key = pathKey(target.path),
    at = (node: Node) => pathKey(node.source.path) === key;
  const before = new Map(
    run.snapshot
      .records({ within: run.within })
      .filter(at)
      .map((node) => [node.identity, node.digest]),
  );
  const nodes = candidate.records.filter(at),
    after = new Map(nodes.map((node) => [node.identity, node.digest]));
  const record =
    nodes.find((node) => node.identity === expected.identity) ??
    nodes.find((node) => node.discriminator === expected.word && node.name === expected.name.toLowerCase());
  // A record admission refuses (a required field missing, say) is no node, but the refusal names its identity.
  const refused = candidate.refused.find(
    (entry) => pathKey(entry.path) === key && entry.identity === expected.identity,
  );
  const identity = record?.identity ?? refused?.identity ?? expected.identity;
  const records = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((id) => ({ identity: id, before: before.get(id) ?? null, after: after.get(id) ?? null }));
  // A file absent before holds only what the edit writes (a starter system and its steward, say).
  const beyond = [...new Set([...before.keys(), ...after.keys()])]
    .filter((id) => target.exists && before.get(id) !== after.get(id) && id !== identity)
    .sort();
  if (beyond.length > 0)
    throw invalid(
      `The edit would change records beyond its target in ${target.path}: ${beyond.join(', ')}`,
      `Run "ia validate${run.rooted}" for the located findings of ${target.path}.`,
      { path: target.path },
    );
  // Review C-R4: a finding counts when it is the edited (or new) record's, or one the base does not hold. In the target
  // file lines move with the edit, so a finding there is matched by its code and record (its message, located finding
  // prefix stripped, when it names none); elsewhere by its code, path, line and message.
  const span = record === undefined ? undefined : record.source;
  const own = (finding: Finding): boolean =>
    finding.identity === identity ||
    (finding.identity === undefined && span !== undefined && finding.line >= span.line && finding.line <= span.endLine);
  const keyOf = (finding: Finding): string =>
    pathKey(finding.path) === key
      ? JSON.stringify([
          finding.code,
          finding.identity ?? null,
          finding.identity === undefined ? finding.message.replace(/^[^:]*:\d+: /, '') : null,
        ])
      : findingKey(finding);
  const base = new Map<string, number>();
  for (const finding of run.snapshot.report.findings) base.set(keyOf(finding), (base.get(keyOf(finding)) ?? 0) + 1);
  const findings = candidate.report.findings.filter((finding) => {
    if (pathKey(finding.path) === key && own(finding)) return true;
    const held = base.get(keyOf(finding)) ?? 0;
    if (held === 0) return true;
    base.set(keyOf(finding), held - 1);
    return false;
  });
  return {
    identity,
    node: record,
    admitted: record !== undefined,
    records,
    revision: candidate.revision,
    findings,
    clean: !findings.some((finding) => finding.severity === 'error'),
  };
}

function previewRecord(
  run: Invocation,
  request: Extract<PreviewRequest, { mode: 'record' }>,
  mode: EditMode,
): Candidate {
  const { word, name } = request;
  if (word === 'system') return previewSystem(run, name, mode);
  const typed = request.at ?? defaultFile(run.roots, word),
    path = typed === undefined || !portable(typed) ? typed : spelledPath(run, typed);
  const profile = requireProfile({
    reader: run.snapshot,
    within: run.within,
    context: run.context,
    mode,
    words: [word],
    ...(path === undefined || !portable(path) ? {} : { path }),
  });
  const registration = registrationOf(run, word);
  const schema = schemaOf(run, word, registration.schema);
  const target = ownedTarget(run, word, path);
  const values: Record<string, string> = {};
  for (const assigned of request.fields) {
    const field = schemaField(run, schema, word, assigned.key);
    // Each value is judged as its field's type first, so draftSource meets only values it spells.
    edited(run, word, target.path, () => encodeValue(field, assigned.value));
    // Review C-N10: one field given twice is refused alike whether spelled `key` or `section.key`.
    if (values[`${field.section}/${field.key}`] !== undefined)
      throw invalid(`@${word} field ${field.section}.${field.key} is given twice`, guidance(run, word));
    values[`${field.section}/${field.key}`] = assigned.value;
  }
  const draft = edited(run, word, target.path, () => draftSource(word, name, schema, values));
  const text = edited(run, word, target.path, () => appendRecord(target.text, draft));
  // Spec 3.1: a new record's identity is its registration's system, kind and first facet, then its lowercased name.
  const identity = `${registration.system}/${registration.kind}/${registration.facets[0]}/${name.toLowerCase()}`;
  const result = compiled(run, target, text, { identity, word, name });
  guardMandate(run, result.node, profile, target.path, true);
  return {
    view: {
      mode: 'record',
      root: run.root,
      path: target.path,
      digest: target.digest,
      exists: target.exists,
      identity: result.identity,
      admitted: result.admitted,
      records: result.records,
      before: null,
      after: draft.replace(/^#! ia [^\n]*\n/, '').trim(),
      baseRevision: run.snapshot.revision,
      revision: result.revision,
      findings: result.findings,
      clean: result.clean,
      profile,
    },
    text,
    target,
    reference: `@${word} ${name}`,
  };
}
/**
 * Plan amendment C20: a new local system is `ia init --system`'s starter system, `@system <name>` and its steward
 * `@agent <name>-steward`, in `.ia/src/systems/<name>/system.ia`, a file no source may hold yet. Its words are the floor's
 * `system` and `agent`, both judged for exclusion.
 */
function previewSystem(run: Invocation, name: string, mode: EditMode): Candidate {
  const path = spelledPath(run, systemPath(name));
  const profile = requireProfile({
    reader: run.snapshot,
    within: run.within,
    context: run.context,
    mode,
    words: ['system', 'agent'],
    path,
  });
  if (run.registry.systems.has(name))
    throw invalid(
      `A system named ${name} is already in force here`,
      `Run "ia position --seat floor/definition/system/${name}${run.rooted}" for where that system sits.`,
    );
  const target = ownedTarget(run, 'system', path);
  if (target.exists)
    throw invalid(`${path} already holds a source`, `Run "ia validate${run.rooted}" for what that source admits.`, {
      path,
    });
  const text = starterSystem(name),
    identity = `floor/definition/system/${name}`;
  const result = compiled(run, target, text, { identity, word: 'system', name });
  return {
    view: {
      mode: 'record',
      root: run.root,
      path,
      digest: target.digest,
      exists: false,
      identity: result.identity,
      admitted: result.admitted,
      records: result.records,
      before: null,
      after: text.replace(/^#! ia [^\n]*\n/, '').trim(),
      baseRevision: run.snapshot.revision,
      revision: result.revision,
      findings: result.findings,
      clean: result.clean,
      profile,
    },
    text,
    target,
    reference: `@system ${name}`,
  };
}
function previewEdit(
  run: Invocation,
  request: Extract<PreviewRequest, { mode: 'relate' | 'set' }>,
  mode: EditMode,
): Candidate {
  const node = recordNamed(run, request.owned);
  const profile = requireProfile({
    reader: run.snapshot,
    within: run.within,
    context: run.context,
    mode,
    words: node === undefined ? [] : [node.discriminator],
    ...(node === undefined ? {} : { path: node.source.path }),
  });
  if (node === undefined) throw missing(run, request.owned);
  ownedRecord(run, node);
  guardMandate(run, node, profile, node.source.path, false);
  const word = node.discriminator,
    path = node.source.path,
    reference = `@${word} ${node.displayName}`;
  let text: string;
  if (request.mode === 'relate') {
    const counterpart = recordNamed(run, request.target);
    if (counterpart === undefined) throw missing(run, request.target);
    const fragment = request.target.split('#')[1];
    const consent = relationshipConsent(run.registry, word, request.spelling, counterpart.discriminator, fragment);
    if (consent.refused !== undefined)
      throw new Refusal(
        'IA-LANG-EDGE-UNCONSENTED',
        `The ${consent.refused.side} system ${consent.refused.system}, which registers @${consent.refused.side === 'source' ? consent.from : consent.to}, does not consent to ${consent.predicate} ${consent.from} -> ${consent.to}: no row of its consent ledger admits it`,
        1,
        { path, identity: node.identity },
        `Run "ia preview ${word}${run.rooted}" for the relationships @${word} may state and the consent each system gives them.`,
      );
    const target = targetFile(run.root, run.snapshot, path, previewAgain(run));
    text = edited(run, word, path, () => addRelationship(target.text, reference, request.spelling, request.target));
    return finish(run, request.mode, target, text, node, profile);
  }
  const schema = schemaOf(run, word, registrationOf(run, word).schema);
  const field = schemaField(run, schema, word, request.assignment.key);
  const target = targetFile(run.root, run.snapshot, path, previewAgain(run));
  text = edited(run, word, path, () =>
    setField(
      target.text,
      reference,
      `${field.section}.${field.key}`,
      request.assignment.value,
      schema,
      request.assignment.append,
    ),
  );
  return finish(run, request.mode, target, text, node, profile);
}
function finish(
  run: Invocation,
  mode: 'relate' | 'set',
  target: Target,
  text: string,
  node: Node,
  profile: Profile,
): Candidate {
  const result = compiled(run, target, text, { identity: node.identity, word: node.discriminator, name: node.name });
  guardMandate(run, result.node, profile, target.path, false);
  return {
    view: {
      mode,
      root: run.root,
      path: target.path,
      digest: target.digest,
      exists: target.exists,
      identity: node.identity,
      admitted: result.admitted,
      records: result.records,
      before: linesOf(target.text, node),
      after: afterLines(target.text, text, node),
      baseRevision: run.snapshot.revision,
      revision: result.revision,
      findings: result.findings,
      clean: result.clean,
      profile,
    },
    text,
    target,
    reference: `@${node.discriminator} ${node.displayName}`,
  };
}

/** The candidate one record, relate or set form compiles to, judged for `mode`: preview's validate or author's. */
export function candidateOf(
  run: Invocation,
  request: Exclude<PreviewRequest, { mode: 'word' }>,
  mode: EditMode,
): Candidate {
  const candidate = request.mode === 'record' ? previewRecord(run, request, mode) : previewEdit(run, request, mode);
  if (mode === 'author') {
    // Administrative records can change the actor, its governing closure, admission, or the edit guard itself.
    // Freeze these words for every actor, including an ungoverned one: --actor is a declaration, not authentication.
    // Comparing only the current actor's moves misses a newly created participant and future path selections.
    const word = candidate.reference.slice(1).split(' ')[0]!;
    if (ADMINISTRATIVE_WORDS.includes(word))
      throw new Refusal(
        'IA-CLI-EDIT-AUTHORITY',
        `ia author does not create or change @${word} records: this administrative word can change participant rights, admission or source protection; nothing was written`,
        1,
        { path: candidate.target.path, identity: candidate.view.identity },
        `Run "ia position${run.rooted}" to inspect the workspace's authority. An owner must make this administrative change in source and validate it; naming an actor does not authorize it.`,
      );
  }
  return candidate;
}
/** The invocation a preview or an author form runs through: one editor snapshot of the workspace at `root`. */
export function invocationOf(context: Context, root: string, editor: Editor): Invocation {
  const snapshot = editor.snapshot,
    within = snapshot.resolveScope().token,
    supplied = context.args.value('root');
  return {
    context,
    root,
    rooted: supplied === undefined ? '' : ` --root ${quote(supplied)}`,
    snapshot,
    within,
    registry: snapshot.inspect().graph.registry,
    roots: rootsOf(snapshot, within, repositoryWorkspace(snapshot, within)),
  };
}

/**
 * A canonical workspace-relative path: what `reader.preview` and the opened-handle reader accept. db keeps its rule private,
 * so this copy is held to it by a parity test (review C-N9, tests/preview.test.ts). The CLI also refuses DEL, the C1
 * controls, the Unicode line and paragraph separators and the bidirectional controls, which db admits, so an `--at` path
 * a terminal or a line scanner could misread is never written (review C-RC4); the parity test states that difference.
 */
export function portable(path: string): boolean {
  return (
    path !== '' &&
    path === path.normalize('NFC') &&
    path.length <= 1024 &&
    !/[\\\u0000-\u001f<>:"|?*]/.test(path) &&
    !/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(path) &&
    path
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  );
}
function registrationOf(run: Invocation, word: string) {
  const registration = run.registry.registrations.get(word);
  if (registration !== undefined && !run.registry.blocked.has(word)) return registration;
  const [near] = nearestTokens(
    word,
    [...run.registry.registrations.keys()].filter((key) => !run.registry.blocked.has(key)),
    1,
  );
  throw invalid(
    run.registry.blocked.has(word)
      ? `@${word} is registered by two systems at one band, so no record of it can be admitted here`
      : `No admitted system registers the word ${word}`,
    near === undefined
      ? `Run "ia inspect${run.rooted}" for the overview of what the workspace admits.`
      : `Run "ia preview ${near}${run.rooted}" for the nearest word this workspace registers.`,
  );
}
/** The file a new record goes to, checked as an owned authored path, then read as `targetFile` reads it. */
function ownedTarget(run: Invocation, word: string, path: string | undefined): Target {
  const fallback = defaultFile(run.roots, word);
  if (path === undefined)
    throw new Refusal(
      'IA-CLI-EDIT-UNOWNED',
      run.roots.workspace === undefined
        ? 'This repository authors no @workspace, so it declares no authored root to hold a new record'
        : `${run.roots.workspace} declares no authored root inside .ia/src in composition.sources`,
      1,
      run.roots.workspace === undefined ? null : { identity: run.roots.workspace },
      run.roots.workspace === undefined
        ? `Run "ia position${run.rooted}" for the repository's position.`
        : `Run "ia position --seat ${run.roots.workspace}${run.rooted}" for the roots the workspace declares.`,
    );
  const elsewhere =
    fallback !== undefined && fallback !== path
      ? `Run "${previewAgain(run, { options: { at: [] } })}" to preview the default file ${fallback} instead.`
      : run.roots.workspace === undefined
        ? `Run "ia position${run.rooted}" for the repository's position; it authors no @workspace to declare roots.`
        : `Run "ia position --seat ${run.roots.workspace}${run.rooted}" for the roots the workspace declares.`;
  if (!portable(path)) throw new Refusal('IA-DB-PATH-UNSAFE', `Unsafe workspace path: ${path}`, 3, { path }, elsewhere);
  const reason = unowned(run.roots, path);
  if (reason !== undefined) throw new Refusal('IA-CLI-EDIT-UNOWNED', reason, 1, { path }, elsewhere);
  return targetFile(run.root, run.snapshot, path, previewAgain(run), (spelled) =>
    previewAgain(run, { options: { at: [spelled] } }),
  );
}

/** A placeholder for one field's value in the guidance's example command. */
const placeholder = (field: SchemaField): string => {
  const item = field.type.replace(/^list of /, ''),
    one =
      item === 'ref'
        ? `@${field.target ?? '<word>'} <name>`
        : field.values !== undefined
          ? field.values.join('|')
          : `<${field.form ?? item}>`;
  return field.type.startsWith('list of ') ? `[${one}, ...]` : one;
};
function previewWord(run: Invocation, request: Extract<PreviewRequest, { mode: 'word' }>): WordView {
  const word = request.word,
    typed = request.at ?? defaultFile(run.roots, word),
    path = typed === undefined || !portable(typed) ? typed : spelledPath(run, typed);
  const profile = requireProfile({
    reader: run.snapshot,
    within: run.within,
    context: run.context,
    mode: 'validate',
    words: [word],
    ...(path === undefined || !portable(path) ? {} : { path }),
  });
  const registration = registrationOf(run, word);
  const schema = run.registry.schemas.get(registration.schema) ?? null;
  // The rows that name the word, in any system's ledger, and every row of its own system's ledger that can admit it:
  // the relationships a record of the word may state or receive, each needing its other end's system to consent too.
  const names = (side: readonly string[] | '*') => side !== '*' && side.includes(word);
  const admits = (side: readonly string[] | '*') => side === '*' || side.includes(word) || side.includes('any-adopter');
  const consent = [...run.registry.consent.entries()]
    .flatMap(([system, rows]) =>
      rows
        .filter((row) =>
          system === registration.system
            ? admits(row.sources) || admits(row.targets)
            : names(row.sources) || names(row.targets),
        )
        .map((row) => ({ system, predicate: row.predicate, targets: row.targets, sources: row.sources })),
    )
    .sort((a, b) => Number(b.system === registration.system) - Number(a.system === registration.system));
  // Plan amendment C20: a system has a file of its own, `ia author system <name>` writes it, and it takes no field.
  if (word === 'system')
    return {
      root: run.root,
      word,
      registration,
      schema,
      consent,
      file: null,
      template: systemPath('<name>'),
      example: 'ia preview system <name>',
      profile,
    };
  const file = path === undefined ? null : ownedTarget(run, word, path);
  const required = (schema?.fields ?? []).filter((field) => field.must);
  return {
    root: run.root,
    word,
    registration,
    schema,
    consent,
    file: file === null ? null : { path: file.path, exists: file.exists, digest: file.digest },
    example:
      schema === null
        ? null
        : [
            'ia',
            'preview',
            word,
            '<name>',
            ...required.map((field) => `${field.section}.${field.key}=${quote(placeholder(field))}`),
          ].join(' '),
    profile,
  };
}

const profileEnvelope = (profile: Profile) => ({
  actor: profile.actor ?? null,
  by: profile.by ?? null,
  mandates: profile.mandates,
  ...(profile.notice === undefined ? {} : { notice: profile.notice }),
});
export function previewEnvelope(view: PreviewView): unknown {
  const count = (severity: string) => view.findings.filter((finding) => finding.severity === severity).length;
  return {
    version: 1,
    mode: view.mode,
    root: view.root,
    path: view.path,
    digest: view.digest,
    exists: view.exists,
    identity: view.identity,
    admitted: view.admitted,
    records: view.records,
    before: view.before,
    after: view.after,
    baseRevision: view.baseRevision,
    revision: view.revision,
    clean: view.clean,
    counts: { errors: count('error'), warnings: count('warning') },
    findings: view.findings,
    profile: profileEnvelope(view.profile),
  };
}
export function wordEnvelope(view: WordView): unknown {
  const { registration, schema } = view;
  return {
    version: 1,
    mode: 'word',
    root: view.root,
    word: view.word,
    system: registration.system,
    lowering: {
      kind: registration.kind,
      category: registration.category,
      facets: registration.facets,
      ...(registration.primitive === undefined ? {} : { primitive: registration.primitive }),
      ...(registration.move === undefined ? {} : { move: registration.move }),
      ...(registration.artifactSet === undefined ? {} : { artifactSet: registration.artifactSet }),
    },
    schema:
      schema === null
        ? null
        : {
            name: schema.name,
            closed: schema.closed,
            sections: schema.sections.map((section) => ({ name: section.name, must: section.must })),
            fields: schema.fields.map((field) => ({
              path: `${field.section}.${field.key}`,
              type: fieldTypeText(field),
              must: field.must,
              ...(field.description === undefined ? {} : { description: field.description }),
            })),
            edges: schema.edges.map((edge) => ({
              spelling: edge.spelling,
              target: edge.target,
              must: edge.must,
              cardinality: edge.cardinality,
            })),
          },
    consent: view.consent,
    file: view.file,
    ...(view.template === undefined ? {} : { template: view.template }),
    example: view.example,
    profile: profileEnvelope(view.profile),
  };
}

const sourceBlock = (label: string, text: string, caps: Capabilities): readonly string[] => [
  sectionLabel(label, caps),
  ...text.split('\n').map((line) => (line === '' ? '' : `  ${terminalText(line)}`)),
];
const actorRow = (profile: Profile): readonly Token[] =>
  words(
    profile.actor === undefined
      ? `none named${profile.notice === undefined ? '' : `; ${profile.notice}`}`
      : `${profile.actor} (${profile.by === 'actor' ? '--actor' : profile.by === 'steward' ? 'the workspace steward' : 'the one participant'})${
          profile.mandates.length === 0
            ? `; ${profile.notice ?? 'no mandate governs here'}`
            : `, under ${profile.mandates.join(', ')}`
        }`,
  );
export function renderPreview(view: PreviewView, caps: Capabilities): string {
  const errors = view.findings.filter((finding) => finding.severity === 'error').length,
    warnings = view.findings.length - errors;
  const blocks: (readonly string[])[] = [
    headerLine(
      'Preview',
      terminalText(view.path),
      [{ text: view.exists ? 'existing file' : 'new file', column: 50 }],
      caps,
    ),
    entry(
      [
        words(
          `${view.clean ? 'Clean candidate' : 'Candidate with errors'}: ${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'} in what it changes.`,
        ),
      ],
      { depth: 1, symbol: view.clean ? 'success' : 'error' },
      caps,
    ),
    fieldRows(
      [
        {
          label: 'record',
          value: [
            atom(view.identity, 'cyan', 0),
            ...(view.admitted ? [] : words('refused by admission; the findings say why', 'dim', 2)),
          ],
        },
        {
          label: 'sha256',
          value: [atom(view.digest, null, 0)],
          note: words('the file as it is now; an absent file reads as empty', 'dim'),
        },
        {
          label: 'revision',
          value: words(
            `${truncateDigest(view.baseRevision, caps.ascii)} -> ${truncateDigest(view.revision, caps.ascii)}`,
          ),
        },
        { label: 'actor', value: actorRow(view.profile) },
      ],
      { depth: 1 },
      caps,
    ),
    ...(view.before === null ? [] : [sourceBlock('Before', view.before, caps)]),
    sourceBlock(view.before === null ? 'Record' : 'After', view.after, caps),
  ];
  const located = view.findings.map((finding) =>
    errorBlock(
      {
        location: finding.path === '' ? null : terminalText(`${finding.path}:${finding.line}`),
        ...(finding.identity === undefined ? {} : { identity: terminalText(finding.identity) }),
        code: finding.code,
        message: terminalText(finding.message),
        severity: finding.severity,
      },
      { depth: 1 },
      caps,
    ),
  );
  if (located.length > 0) blocks.push([sectionLabel('Findings', caps), ...located.flat()]);
  blocks.push(entry([words('Preview writes nothing.')], { depth: 0, symbol: 'step' }, caps));
  return document(blocks, { leadingBlank: true });
}
export function renderWord(view: WordView, caps: Capabilities): string {
  const { registration, schema } = view;
  const lowering = [
    `category ${registration.category}`,
    `facets ${registration.facets.join(', ')}`,
    ...(registration.primitive === undefined ? [] : [`primitive ${registration.primitive}`]),
    ...(registration.move === undefined ? [] : [`move ${registration.move}`]),
    ...(registration.artifactSet === undefined ? [] : [`artifact set ${registration.artifactSet}`]),
  ].join('; ');
  const side = (value: readonly string[] | '*') => (value === '*' ? '*' : value.join(', '));
  const blocks: (readonly string[])[] = [
    headerLine('Word', view.word, [{ text: registration.system, column: 30 }], caps),
    fieldRows(
      [
        { label: 'lowers to', value: words(`${registration.kind} (${lowering})`) },
        {
          label: 'schema',
          value: words(schema === null ? 'none admitted' : `${schema.name}, ${schema.closed ? 'closed' : 'open'}`),
        },
        {
          label: 'file',
          value: words(
            view.template !== undefined
              ? `${view.template}, a new file for each system`
              : view.file === null
                ? 'none: the workspace declares no authored root inside .ia/src'
                : `${view.file.path} (${view.file.exists ? 'existing' : 'new'}), sha256 ${view.file.digest}`,
          ),
        },
        { label: 'actor', value: actorRow(view.profile) },
      ],
      { depth: 1 },
      caps,
    ),
  ];
  if (schema !== null) {
    blocks.push([
      sectionLabel('Sections', caps),
      ...schema.sections.map((section) => `  ${section.must ? 'must' : 'may'} have ${section.name}`),
    ]);
    blocks.push([
      sectionLabel('Fields', caps),
      ...fieldRows(
        schema.fields.map((field) => ({
          label: `${field.must ? 'must' : 'may'} ${field.section}.${field.key}`,
          value: words(`${fieldTypeText(field)}${field.description === undefined ? '' : ` - ${field.description}`}`),
        })),
        { depth: 1 },
        caps,
      ),
    ]);
    if (schema.edges.length > 0)
      blocks.push([
        sectionLabel('Edges', caps),
        ...schema.edges.map(
          (edge) => `  ${edge.must ? 'must' : 'may'} ${edge.spelling} ${edge.target} ${edge.cardinality}`,
        ),
      ]);
  }
  if (view.consent.length > 0)
    blocks.push([
      sectionLabel('Consent', caps),
      ...view.consent.map((row) => `  ${row.system}: ${row.predicate} ${side(row.targets)} using ${side(row.sources)}`),
    ]);
  if (view.example !== null)
    blocks.push([
      sectionLabel('Preview a new record', caps),
      ...entry([[atom(view.example, null, 0)]], { depth: 1 }, caps),
    ]);
  return document(blocks, { leadingBlank: true });
}

export function runPreview(context: Context): Result {
  const { args, caps, json } = context;
  const request = previewRequest(args);
  const root = requireRoot(context);
  const editor = openEditor(root);
  try {
    const run = invocationOf(context, root, editor);
    if (request.mode === 'word') {
      const view = previewWord(run, request);
      return json
        ? { exitCode: 0, stdout: JSON.stringify(wordEnvelope(view)) + '\n', stderr: '' }
        : { exitCode: 0, stdout: renderWord(view, caps), stderr: '' };
    }
    const { view } = candidateOf(run, request, 'validate');
    const exitCode = view.clean ? 0 : 1;
    return json
      ? { exitCode, stdout: JSON.stringify(previewEnvelope(view)) + '\n', stderr: '' }
      : { exitCode, stdout: renderPreview(view, caps), stderr: '' };
  } finally {
    editor.close();
  }
}
