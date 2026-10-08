/**
 * `ia read`: position-and-projection §5's body reader, design row 23.
 *
 * The one verb that returns a body rather than structure. The runtime's `readBody` resolves the locator against the
 * admitted workspace and returns the body behind it: a cell's or requirement's text for a fragment, else the document a
 * record's source locator names (`work.source`, `reference.document`, `template.resource`), or the section under a
 * markdown heading when the locator carries an anchor, else the record's own `meaning.says`. This verb supplies the
 * workspace file reader the capture already uses, so a link, a missing or irregular file and an unsafe path refuse as
 * they do there, and prints the body with its digest. A read certifies nothing (IM-43), and sections, fields and
 * relationships stay in `ia inspect`.
 *
 * The workspace opens as every read verb opens it, without the db cache, so a read writes nothing. The document of an
 * adopted record is read from the directory `.ia/workspace.json` binds its mount to.
 */
import { isAbsolute, relative, sep } from 'node:path';
import { adoptedBindings } from '@inventarch/db';
import { readWorkspaceFile } from '@inventarch/distribution/services';
import { parseLocator, readBody } from '@inventarch/runtime';
import type { ReadBody, ReadBodyOptions, ReadRefusal } from '@inventarch/runtime';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import type { Capabilities } from './render.js';
import { atom, document, entry, headerLine, quote, truncateDigest, words } from './render.js';
import { identityNext, openSession } from './session.js';
import type { Session } from './session.js';

/** The line every human read prints beside the digest (IM-43). */
export const NOT_CERTIFIED = 'body not certified by this read';

export function readEnvelope(body: ReadBody): unknown {
  return {
    version: 1,
    locator: body.locator,
    identity: body.identity,
    kind: body.kind,
    ...(body.path === undefined ? {} : { path: body.path }),
    digest: body.digest,
    body: body.body,
    certified: body.certified,
  };
}

/** What was read, its digest and the not-certified line, then the body exactly as read. */
export function renderRead(body: ReadBody, caps: Capabilities): string {
  const header = document(
    [
      // The identity alone is often wider than the effective width, so nothing shares its header line.
      headerLine('Read', body.identity, [], caps),
      entry(
        [
          body.path === undefined
            ? words(body.locator === body.identity ? 'record' : `record, ${body.locator}`)
            : [atom('document', null, 0), atom(body.path, 'cyan', 2)],
          [
            atom(`sha256 ${truncateDigest(body.digest, caps.ascii)}`, null, 0),
            ...words(`${Buffer.byteLength(body.body)} bytes`, 'dim', 2),
          ],
          words(NOT_CERTIFIED, 'dim'),
        ],
        { depth: 1, symbol: 'info' },
        caps,
      ),
    ],
    { leadingBlank: true },
  );
  return body.body === '' ? header : `${header}\n${body.body}${body.body.endsWith('\n') ? '' : '\n'}`;
}

/**
 * Design row 27: the one command after each read refusal. A source whose records admission refused, the identity's
 * own included, names the validation that says why; a line of a source whose admitted records span other lines names
 * the inspection that lists them; an identity no source holds names what `ia inspect` names for it (`identityNext`)
 * when the open workspace `reader` is supplied; anything else the overview. A missing fragment or an unreachable
 * locator names the record, which `ia inspect` locates; a runtime-placed record names the read that includes it.
 */
function readNext(refusal: ReadRefusal, locator: string, rooted: string, reader?: Session['reader']): string {
  switch (refusal.code) {
    case 'IA-RUNTIME-READ-UNADMITTED':
      if (refusal.file === 'refused')
        return `Run "ia validate${rooted}" to see why admission refused the records of that source.`;
      if (refusal.file === 'admitted')
        return `Run "ia inspect --path ${quote(refusal.path!)}${rooted}" to see the admitted records of that source.`;
      if (reader !== undefined && refusal.identity !== undefined && refusal.path === undefined)
        return identityNext(reader, refusal.identity, 'read', rooted);
      return `Run "ia inspect${rooted}" for the overview of what the workspace admits.`;
    case 'IA-RUNTIME-READ-FRAGMENT':
      return `Run "ia inspect ${refusal.identity!}${rooted}" to see the record the locator names.`;
    case 'IA-RUNTIME-READ-UNREACHABLE':
      // A URL, or a path outside the workspace, names no file to restore.
      return refusal.path === undefined
        ? `Correct the record's locator, which "ia inspect ${refusal.identity!}${rooted}" locates at its source line.`
        : `Restore ${refusal.path} or correct the record's locator, which "ia inspect ${refusal.identity!}${rooted}" locates at its source line.`;
    case 'IA-RUNTIME-READ-PLACEMENT':
      return `Run "ia read ${quote(locator)} --include-runtime${rooted}" to read a record at runtime placement.`;
  }
}
/**
 * §4.1: the runtime's read refusal with its code and message unchanged. A locator that answers no record, or no part of
 * one, is exit 1, as `ia inspect` refuses an identity it does not admit; a document the read cannot reach and a
 * placement it does not include are exit 3. An identity no admitted record answers is located at the workspace, as
 * `ia inspect` locates it.
 */
export function readRefusal(
  refusal: ReadRefusal,
  context: Pick<Context, 'args'>,
  root: string,
  /** The workspace, still open, so an identity no source holds is answered as `ia inspect` answers it. */
  reader?: Session['reader'],
): Refusal {
  const locator = context.args.positionals[0]!,
    supplied = context.args.value('root'),
    rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`;
  return new Refusal(
    refusal.code,
    refusal.message,
    refusal.code === 'IA-RUNTIME-READ-UNREACHABLE' || refusal.code === 'IA-RUNTIME-READ-PLACEMENT' ? 3 : 1,
    {
      path: refusal.path ?? root,
      ...(refusal.line === undefined ? {} : { line: refusal.line }),
      ...(refusal.identity === undefined ? {} : { identity: refusal.identity }),
    },
    readNext(refusal, locator, rooted, reader),
  );
}

/**
 * A `<path>:<line>` locator's path is relative to the workspace root, as every source path the toolchain names is; an
 * absolute path inside the root, which an editor hands over, is read as the root-relative path it names. Any other
 * locator is read as given.
 */
function workspaceLocator(locator: string, root: string): string {
  const parsed = parseLocator(locator);
  if (parsed?.form !== 'line' || !isAbsolute(parsed.path)) return locator;
  const local = relative(root, parsed.path);
  return local === '' || local.startsWith('..') || isAbsolute(local)
    ? locator
    : `${local.split(sep).join('/')}:${parsed.line}`;
}

/**
 * What `ia read` hands the runtime: the workspace file reader the capture already uses, and the directory
 * `.ia/workspace.json` binds each adopted mount to. The runtime Door reads through db `readWorkspaceBytes` and the same
 * bindings, and tests/read.test.ts holds the two to the same bodies, digests and refusals.
 */
export function readOptions(root: string, reader: Session['reader'], includeRuntime: boolean): ReadBodyOptions {
  return {
    read: (path) => readWorkspaceFile({ root, path }),
    mounts: new Map(adoptedBindings(reader.root).map((binding) => [binding.tree, binding.path])),
    includeRuntime,
  };
}

export function runRead(context: Context): Result {
  const { args, caps, json } = context;
  const locator = args.positionals[0]!;
  // A malformed locator is a usage error, refused before the workspace is read.
  if (parseLocator(locator) === undefined)
    throw new Refusal(
      'IA-CLI-USAGE',
      `Malformed locator ${locator}; a locator is <identity>, <identity>#<phase>/<Primitive>, <identity>#<REQ-ID> or <path>:<line>`,
      2,
      null,
      'Run "ia read --help" for the locator forms it accepts.',
    );
  const root = requireRoot(context);
  const target = workspaceLocator(locator, root);
  const session = openSession(root);
  let got: ReturnType<typeof readBody>;
  try {
    got = readBody(session.reader, target, readOptions(root, session.reader, args.flag('include-runtime')));
    // Refused while the workspace is open, so an identity no source holds is answered from what it admits.
    if (!got.ok) throw readRefusal(got, context, root, session.reader);
  } finally {
    session.close();
  }
  // The locator is echoed as the invocation gave it, not as rewritten relative to the root.
  const body: ReadBody = { ...got.body, locator };
  return json
    ? { exitCode: 0, stdout: JSON.stringify(readEnvelope(body)) + '\n', stderr: '' }
    : { exitCode: 0, stdout: renderRead(body, caps), stderr: '' };
}
