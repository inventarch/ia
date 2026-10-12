/**
 * `ia author`: the writing half of record authoring (milestone generation-binding plan amendments C19 and C20, lane C
 * round 3), in the author mode, whose move is Synthesis.
 *
 * Every form of `ia preview` that changes a non-administrative record has an author form with `--digest <sha256>`,
 * the target file's sha256 the preview printed: `ia author <word> <name> [<field>=<value>...] [--at <path>]`,
 * `ia author --relate <owned> <spelling> <target>` and `ia author --set <owned> <section.key>=<value>` (or `+=`). Each
 * compiles exactly the candidate the preview showed, against one editor snapshot of the workspace, judged for the
 * author mode, and writes it only when the file is still the one the digest names and the candidate is clean.
 * Administrative words, including the system starter, are refused by candidateOf before any write.
 *
 * The record written carries one attribution comment above it, `# authored-by @agent <participant> under @mandate <name>
 * at <authored revision>`: the acting participant, the governing mandate that grants it Synthesis, and the authored
 * revision of the workspace the candidate was compiled against (db `authoredRevision`, which the editor snapshot reads
 * as every reader does). A comment is trivia: it moves no digest and is not written into capture membership. A second
 * author replaces the attribution rather than stacking one.
 *
 * The write is the distribution's: `replace` (a temporary file, then a rename, every path component checked for links)
 * for a file that exists, after an opened-handle read confirms it is still the file the snapshot read; `createFile` (a
 * hard link that refuses an existing entry) for a new file. Nothing else is written.
 */
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { readWorkspaceBytes } from '@inventarch/db';
import { createFile, replace } from '@inventarch/distribution/services';
import { annotateRecord, SourceEditError } from '@inventarch/runtime/editor';
import { UsageError } from './args.js';
import { findCommand } from './commands.js';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot, respell } from './consumer.js';
import { candidateOf, invocationOf, previewRequest, sha256 } from './preview.js';
import type { Candidate, Invocation, PreviewView } from './preview.js';
import { DIGEST, judgedNext } from './profile.js';
import type { Profile } from './profile.js';
import type { Capabilities } from './render.js';
import {
  atom,
  document,
  entry,
  errorBlock,
  fieldRows,
  headerLine,
  sectionLabel,
  terminalText,
  truncateDigest,
  words,
} from './render.js';
import { openEditor } from './session.js';

/** The bytes a source may hold for its opened-handle read before the write. */
const SOURCE_LIMIT = 16 * 1024 * 1024;

/** What an author form wrote: the envelope's and the renderer's one input. */
export interface AuthorView {
  readonly mode: PreviewView['mode'];
  readonly root: string;
  readonly path: string;
  /** Whether the write created the file. */
  readonly created: boolean;
  /** The file's sha256 before the write (an absent file reads as empty) and after it. */
  readonly previousDigest: string;
  readonly digest: string;
  readonly identity: string;
  /** The attribution comment written above the record. */
  readonly attribution: string;
  /** The record as written, its attribution first. */
  readonly record: string;
  /** The authored revision the candidate was compiled against, and the revision of the workspace with what was written. */
  readonly authoredRevision: string;
  readonly revision: string;
  readonly records: PreviewView['records'];
  readonly findings: PreviewView['findings'];
  readonly profile: Profile;
  /** The one command to run next. */
  readonly next: string;
}

/** The same form as `ia preview`: what prints the candidate and the digest an author form needs. */
const previewOf = (context: Pick<Context, 'args'>): string =>
  respell({ command: findCommand('preview')!, args: context.args });

/** `# authored-by @agent <participant> under @mandate <name> at <authored revision>`, from the profile that allowed it. */
function attributionOf(run: Invocation, profile: Profile): string {
  const name = (identity: string | undefined): string | undefined =>
    identity === undefined
      ? undefined
      : run.snapshot.records({ within: run.within }).find((node) => node.identity === identity)?.displayName;
  const agent = name(profile.actor),
    mandate = name(profile.grantedBy);
  return `# authored-by ${agent === undefined ? 'no participant' : `@agent ${agent}`} under ${
    mandate === undefined ? 'no @mandate' : `@mandate ${mandate}`
  } at ${run.snapshot.authoredRevision}`;
}

/**
 * A failed write's refusal code: the distribution's own (IA-DIST-*) or another IA code as raised, and IA-CLI-FAILED for
 * anything else, a volume's raw errno (EPERM, EACCES, EROFS) included, which is no refusal code (review C2-N15).
 */
const distribution = (error: unknown): { readonly code: string; readonly message: string } => ({
  code:
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('IA-')
      ? error.code
      : 'IA-CLI-FAILED',
  message: error instanceof Error ? error.message : String(error),
});
/**
 * Writes `text` over the target, which must still be the file the snapshot read: an existing file through an
 * opened-handle read and `replace`, keeping its permission bits; a new one through `createFile`, which refuses an entry
 * that appeared since. Returns the written bytes' sha256.
 */
function write(run: Invocation, candidate: Candidate, text: string, again: string): string {
  const { target } = candidate,
    bytes = Buffer.from(text, 'utf8'),
    stale = (message: string): Refusal =>
      new Refusal(
        'IA-CLI-EDIT-STALE',
        message,
        1,
        { path: target.path },
        `Run "${again}" for the candidate against the file as it is now, and the digest to pass.`,
      );
  if (target.exists) {
    let now: Uint8Array;
    try {
      now = readWorkspaceBytes(run.root, target.path, SOURCE_LIMIT);
    } catch (error) {
      throw stale(`${target.path} cannot be read as the file the preview named: ${distribution(error).message}`);
    }
    if (sha256(now) !== target.digest) throw stale(`${target.path} changed while it was authored; nothing was written`);
    const mode = lstatSync(resolve(run.root, ...target.path.split('/'))).mode & 0o777;
    try {
      replace(run.root, target.path, bytes, mode);
    } catch (error) {
      const { code, message } = distribution(error);
      throw new Refusal(
        code,
        message,
        3,
        { path: target.path },
        `Make ${target.path} writable, or close what holds it open, then run "${again}" for the candidate and the digest to pass; nothing was written.`,
      );
    }
  } else {
    try {
      createFile(run.root, target.path, bytes, 0o644);
    } catch (error) {
      const { code, message } = distribution(error);
      if (code === 'IA-DIST-LOCAL-MODIFICATION')
        throw stale(`${target.path} appeared while it was authored; nothing was written`);
      throw new Refusal(
        code,
        message,
        3,
        { path: target.path },
        `Make the directory of ${target.path} writable, then run "${again}" for the candidate and the digest to pass; nothing was written.`,
      );
    }
  }
  return sha256(bytes);
}

export function authorEnvelope(view: AuthorView): unknown {
  const count = (severity: string) => view.findings.filter((finding) => finding.severity === severity).length;
  return {
    version: 1,
    mode: view.mode,
    root: view.root,
    path: view.path,
    created: view.created,
    previousDigest: view.previousDigest,
    digest: view.digest,
    identity: view.identity,
    attribution: view.attribution,
    record: view.record,
    authoredRevision: view.authoredRevision,
    revision: view.revision,
    counts: { errors: count('error'), warnings: count('warning') },
    findings: view.findings,
    records: view.records,
    profile: {
      actor: view.profile.actor ?? null,
      by: view.profile.by ?? null,
      mandates: view.profile.mandates,
      grantedBy: view.profile.grantedBy ?? null,
      ...(view.profile.notice === undefined ? {} : { notice: view.profile.notice }),
    },
    next: view.next,
  };
}
export function renderAuthor(view: AuthorView, caps: Capabilities): string {
  const warnings = view.findings.filter((finding) => finding.severity === 'warning').length;
  const blocks: (readonly string[])[] = [
    headerLine(
      'Authored',
      terminalText(view.path),
      [{ text: view.created ? 'new file' : 'existing file', column: 50 }],
      caps,
    ),
    entry(
      [words(`Wrote ${view.identity}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'} in what it changed.`)],
      { depth: 1, symbol: 'success' },
      caps,
    ),
    fieldRows(
      [
        { label: 'sha256', value: [atom(view.digest, null, 0)], note: words(`was ${view.previousDigest}`, 'dim') },
        {
          label: 'revision',
          value: words(
            `authored ${truncateDigest(view.authoredRevision, caps.ascii)}, now ${truncateDigest(view.revision, caps.ascii)}`,
          ),
        },
        {
          label: 'actor',
          value: words(
            view.profile.actor === undefined
              ? `none named${view.profile.notice === undefined ? '' : `; ${view.profile.notice}`}`
              : `${view.profile.actor}${view.profile.grantedBy === undefined ? '' : `, under ${view.profile.grantedBy}`}`,
          ),
        },
      ],
      { depth: 1 },
      caps,
    ),
    [
      sectionLabel('Record', caps),
      ...view.record.split('\n').map((line) => (line === '' ? '' : `  ${terminalText(line)}`)),
    ],
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
  blocks.push(entry([words(terminalText(view.next))], { depth: 0, symbol: 'step' }, caps));
  return document(blocks, { leadingBlank: true });
}

export function runAuthor(context: Context): Result {
  const { args, caps, json } = context;
  const request = previewRequest(args);
  if (request.mode === 'word')
    throw new UsageError(
      `ia author writes a new record, one relationship row or one field; it needs <name>, --relate or --set after ${request.word}`,
    );
  const digest = args.value('digest');
  const root = requireRoot(context);
  const editor = openEditor(root);
  let view: AuthorView;
  try {
    const run = invocationOf(context, root, editor),
      again = previewOf(context);
    const candidate = candidateOf(run, request, 'author'),
      { target } = candidate,
      preview = candidate.view;
    // Review C2-R4: the profile is judged first (candidateOf), so a missing or malformed digest is refused only for an
    // actor the author mode allows, and the preview it names is judged by that profile (gatedNext) before it is printed.
    if (digest !== undefined && !DIGEST.test(digest))
      throw new Refusal(
        'IA-CLI-USAGE',
        `--digest takes the 64 lowercase hex digits of the target file's sha256; got ${digest}`,
        2,
        null,
        `Run "${again}" for the candidate and the digest to pass.`,
      );
    if (digest === undefined)
      throw new Refusal(
        'IA-CLI-USAGE',
        'ia author requires --digest <sha256>, the target file digest ia preview prints for the same form',
        2,
        null,
        `Run "${again}" for the candidate and the digest to pass.`,
      );
    if (digest !== undefined && digest !== target.digest)
      throw new Refusal(
        'IA-CLI-EDIT-STALE',
        `${target.path} is not the file the preview named: its sha256 is ${target.digest}, not ${digest}`,
        1,
        { path: target.path },
        `Run "${again}" for the candidate against the file as it is now, and the digest to pass.`,
      );
    if (!preview.clean) {
      const errors = preview.findings.filter((finding) => finding.severity === 'error'),
        first = errors[0]!,
        at = `${first.path}:${first.line}`;
      // Review C2-N12: a located finding's message already opens with its location, which is stated once.
      const message = first.message.startsWith(`${at}: `) ? first.message.slice(at.length + 2) : first.message;
      throw new Refusal(
        'IA-CLI-EDIT-UNCLEAN',
        `The candidate has ${errors.length} ${errors.length === 1 ? 'error' : 'errors'} in what it changes, so nothing was written; the first is ${first.code} at ${at}: ${message}`,
        1,
        { path: target.path, identity: preview.identity },
        `Run "${again}" for the candidate's findings.`,
      );
    }
    const attribution = attributionOf(run, preview.profile);
    let text: string;
    try {
      text = annotateRecord(candidate.text, candidate.reference, attribution);
    } catch (error) {
      if (!(error instanceof SourceEditError)) throw error;
      throw new Refusal(
        'IA-CLI-EDIT-INVALID',
        error.message,
        1,
        { path: target.path },
        `Run "${again}" for the candidate.`,
      );
    }
    // The revision of what is written, the attribution included: the candidate's own revision has no comment in it.
    const revision = run.snapshot.preview([{ path: target.path, text }]).revision,
      written = write(run, candidate, text, again);
    view = {
      mode: preview.mode,
      root,
      path: target.path,
      created: !target.exists,
      previousDigest: target.digest,
      digest: written,
      identity: preview.identity,
      attribution,
      record: `${attribution}\n${preview.after}`,
      authoredRevision: run.snapshot.authoredRevision,
      revision,
      records: preview.records,
      findings: preview.findings,
      profile: preview.profile,
      // Review C2-N11: the next command is judged by the profile that allowed the author, as a refusal's would be.
      next: judgedNext(
        `Run "ia validate${run.rooted}" to confirm the workspace admits what was written.`,
        context.gate,
      ),
    };
  } finally {
    editor.close();
  }
  return json
    ? { exitCode: 0, stdout: JSON.stringify(authorEnvelope(view)) + '\n', stderr: '' }
    : { exitCode: 0, stdout: renderAuthor(view, caps), stderr: '' };
}
