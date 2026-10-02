/**
 * `ia format`: docs/specs/consumer-cli-contract/README.md §2.3.
 *
 * `--check` is the default and writes nothing; `--write` is the new in-place mode `decisions.md:65` requires be
 * specified rather than inherited, and it is never implied. Every rewrite goes through the replace-by-rename
 * primitive, so a file is whole or untouched; there is no cross-file atomicity and none is claimed. The two
 * phases below are what keeps a refusal from leaving a mixture: nothing is written until every selected file has
 * a verified draft, and the formatter's own staleness recheck runs inside each of those drafts.
 */
import { readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { formatSource, readWorkspaceFile, replace } from '@ia/distribution/services';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import { codeOf, openSession } from './session.js';
import type { Session } from './session.js';
import type { Capabilities } from './render.js';
import { atom, document, entry, headerLine, sectionLabel, truncateDigest, words } from './render.js';

export type FormatStatus = 'unchanged' | 'differs' | 'rewritten' | 'refused' | 'unsupported';
export interface FormatFile {
  readonly path: string;
  readonly status: FormatStatus;
  /** The formatter's own diagnostics: its findings on a draft, its refusal diagnostics on a refused document. */
  readonly findings: readonly unknown[];
}
export interface FormatView {
  readonly root: string;
  readonly mode: 'check' | 'write';
  readonly baseRevision: string;
  readonly files: readonly FormatFile[];
  readonly changed: number;
}

/** §2.3 names IA-DIST-PATH-UNSAFE for a path resolving outside --root; a directory never reaches a service. */
const contain = (supplied: string): string => {
  const path = supplied.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (path === '' || isAbsolute(supplied) || path.split('/').includes('..'))
    throw new Refusal(
      'IA-DIST-PATH-UNSAFE',
      `Unsafe relative path: ${supplied}`,
      3,
      { path: supplied },
      'Name a path inside the workspace root, relative to it.',
    );
  return path;
};
/** Directories are walked for `*.ia` files only; a link is never followed, matching the reader's own rule. */
function walk(root: string, path: string): readonly string[] {
  try {
    return readdirSync(resolve(root, path), { withFileTypes: true })
      .filter((dirent) => !dirent.isSymbolicLink())
      .flatMap((dirent) =>
        dirent.isDirectory()
          ? walk(root, `${path}/${dirent.name}`)
          : dirent.name.endsWith('.ia')
            ? [`${path}/${dirent.name}`]
            : [],
      )
      .sort();
  } catch {
    return [];
  }
}
/** §2.3: the default selection is `.ia/src`; a positional is a file or a directory relative to the root. */
export function selectSources(root: string, filters: readonly string[]): readonly string[] {
  const selected = (filters.length === 0 ? ['.ia/src'] : filters).flatMap((supplied) => {
    const path = contain(supplied);
    return path.endsWith('.ia') ? [path] : walk(root, path);
  });
  return [...new Set(selected)].sort();
}

const text = (root: string, path: string): string => readWorkspaceFile({ root, path }).toString('utf8');

interface Draft {
  readonly path: string;
  readonly text: string;
}
export function collectFormat(root: string, filters: readonly string[], write: boolean): FormatView {
  const paths = selectSources(root, filters);
  let session: Session | undefined;
  try {
    session = openSession(root);
    const files: FormatFile[] = [],
      drafts: Draft[] = [];
    const baseRevision = session.reader.revision;
    for (const path of paths) {
      const current = text(root, path);
      // The formatter's domain is narrower than `*.ia`: it declines a system declaration, a schema and anything
      // outside an admitted authored system, all with IA-DIST-PATH-UNSAFE. Traversal was already refused by
      // contain() and the read above, so that code here means "outside the formatter's domain" and is reported
      // per file rather than ending the run — a whole-tree check must not stop at the packaged floor.
      let outcome: ReturnType<typeof formatSource>;
      try {
        outcome = formatSource({ session, path, text: current, reread: () => text(root, path) });
      } catch (error) {
        if (codeOf(error, '') !== 'IA-DIST-PATH-UNSAFE') throw error;
        files.push({
          path,
          status: 'unsupported',
          findings: [{ code: 'IA-DIST-PATH-UNSAFE', message: error instanceof Error ? error.message : String(error) }],
        });
        continue;
      }
      if (outcome.status === 'refused') {
        files.push({ path, status: 'refused', findings: outcome.diagnostics });
        continue;
      }
      if (outcome.text === current) {
        files.push({ path, status: 'unchanged', findings: outcome.findings });
        continue;
      }
      files.push({ path, status: write ? 'rewritten' : 'differs', findings: outcome.findings });
      drafts.push({ path, text: outcome.text });
    }
    // Phase two. Every draft was produced and rechecked before the first byte is written, so a refusal in the
    // middle of the selection cannot leave half the files rewritten and half stale.
    if (write) for (const draft of drafts) replace(root, draft.path, Buffer.from(draft.text, 'utf8'));
    return { root, mode: write ? 'write' : 'check', baseRevision, files, changed: drafts.length };
  } finally {
    session?.close();
  }
}

const refused = (view: FormatView): readonly FormatFile[] => view.files.filter((file) => file.status === 'refused');
/** §2.3: 1 when a file differs under --check or the formatter refused a document; --write rewrote them, so 0. */
export const formatExit = (view: FormatView): 0 | 1 =>
  refused(view).length > 0 || (view.mode === 'check' && view.changed > 0) ? 1 : 0;

export function formatEnvelope(view: FormatView): unknown {
  return {
    version: 1,
    root: view.root,
    mode: view.mode,
    baseRevision: view.baseRevision,
    files: view.files.map((file) => ({ path: file.path, status: file.status, findings: file.findings })),
    changed: view.changed,
  };
}

const diagnostic = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return String(value);
  const row = value as { code?: unknown; message?: unknown; path?: unknown; line?: unknown };
  const where =
    typeof row.path === 'string' && row.path !== ''
      ? `${row.path}${typeof row.line === 'number' ? `:${row.line}` : ''}  `
      : '';
  return typeof row.message === 'string'
    ? `${where}${typeof row.code === 'string' ? `${row.code}  ` : ''}${row.message}`
    : JSON.stringify(value);
};

export function renderFormat(view: FormatView, caps: Capabilities): string {
  const blocks: (readonly string[])[] = [headerLine('Format', view.mode, [{ text: view.root, column: 50 }], caps)];
  const outside = view.files.filter((file) => file.status === 'unsupported').length,
    total = view.files.length - outside,
    bad = refused(view);
  const summary =
    total === 0
      ? 'No formattable .ia files were selected.'
      : view.mode === 'write'
        ? `Rewrote ${view.changed} of ${total} ${total === 1 ? 'file' : 'files'}.`
        : view.changed === 0
          ? `${total} ${total === 1 ? 'file matches' : 'files match'} the formatter.`
          : `${view.changed} of ${total} files differ from the formatter.`;
  const skipped =
    outside === 0
      ? ''
      : ` ${outside} ${outside === 1 ? 'file is' : 'files are'} outside the formatter's domain: system declarations, schemas and the packaged floor.`;
  blocks.push(
    entry(
      [words(`${summary} Revision ${truncateDigest(view.baseRevision, caps.ascii)}.${skipped}`)],
      {
        depth: 1,
        symbol: bad.length > 0 ? 'error' : view.mode === 'check' && view.changed > 0 ? 'warning' : 'success',
      },
      caps,
    ),
  );
  const listed = view.files.filter((file) => file.status === 'differs' || file.status === 'rewritten');
  if (listed.length > 0)
    blocks.push([
      sectionLabel(view.mode === 'write' ? 'Rewritten' : 'Differs', caps),
      ...listed.flatMap((file) =>
        entry(
          [[atom(file.path, 'cyan', 0)]],
          { depth: 1, symbol: view.mode === 'write' ? 'success' : 'warning' },
          caps,
        ),
      ),
    ]);
  if (bad.length > 0)
    blocks.push([
      sectionLabel('Refused', caps),
      ...bad.flatMap((file) =>
        entry(
          [[atom(file.path, 'cyan', 0)], ...file.findings.map((value) => words(diagnostic(value)))],
          { depth: 1, symbol: 'error' },
          caps,
        ),
      ),
    ]);
  blocks.push(
    entry(
      [
        words(
          bad.length > 0
            ? 'Correct the refused documents above, then run "ia format" again.'
            : view.mode === 'write'
              ? 'Review the rewritten files before committing them.'
              : view.changed > 0
                ? 'Run "ia format --write" to rewrite the differing files in place.'
                : 'Every selected file is already formatted at this revision.',
        ),
      ],
      { depth: 0, symbol: 'step' },
      caps,
    ),
  );
  return document(blocks, { leadingBlank: true });
}

export function runFormat(context: Context): Result {
  const { args, caps, json } = context;
  const view = collectFormat(requireRoot(context), args.positionals, args.flag('write'));
  const exitCode = formatExit(view);
  return json
    ? { exitCode, stdout: JSON.stringify(formatEnvelope(view)) + '\n', stderr: '' }
    : { exitCode, stdout: renderFormat(view, caps), stderr: '' };
}
