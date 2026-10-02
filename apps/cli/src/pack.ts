/**
 * `ia pack`: docs/specs/consumer-cli-contract/README.md §2.7.
 *
 * The consumer form renames the native `--source-root` to the common `--root` and defaults the output directory
 * the native form requires. The packer itself is unchanged, including its recheck that the descriptor did not
 * change while the archive was being built, which is the only reason `IA-DIST-SOURCE-CHANGED` can appear here.
 *
 * The digests are the integrity output: they are what a consumer checks an acquired artifact against. The archive
 * name is its own digest, so re-packing unchanged sources on the same zlib build targets a path that already exists — refused by
 * default with a next action naming --force, exactly as §2.4 refuses a compiled artifact.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DISTRIBUTION_LIMITS } from '@ia/db/distribution';
import { packToDirectory, readWorkspaceFile, replace } from '@ia/distribution/services';
import type { PackedArchive } from '@ia/distribution/services';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import { codeOf } from './session.js';
import type { Capabilities } from './render.js';
import { atom, document, entry, fieldRows, headerLine, sectionLabel, truncateDigest, words } from './render.js';

export const DEFAULT_OUT = '.ia/work/dist';
/** §2.7: the rendered form lists the first 20 members and names the rest rather than printing them. */
export const LISTED_MEMBERS = 20;

export interface PackView {
  readonly root: string;
  readonly out: string;
  readonly packed: PackedArchive;
}

export const expandedBytes = (packed: PackedArchive): number =>
  packed.manifest.files.reduce((total, file) => total + file.bytes, 0);

export function packEnvelope(view: PackView): unknown {
  return { version: 1, ...view.packed };
}

export function renderPack(view: PackView, caps: Capabilities): string {
  const { packed } = view,
    members = packed.manifest.files.map((file) => file.path);
  return document(
    [
      headerLine('Pack', `${packed.manifest.id} ${packed.manifest.version}`, [{ text: view.out, column: 50 }], caps),
      entry(
        [
          words(
            `${members.length} ${members.length === 1 ? 'file' : 'files'}, ${expandedBytes(packed)} bytes expanded.`,
          ),
        ],
        { depth: 1, symbol: 'success' },
        caps,
      ),
      [
        sectionLabel('Integrity', caps),
        ...fieldRows(
          [
            { label: 'Archive', value: [atom(`sha256 ${truncateDigest(packed.archive, caps.ascii)}`, null, 0)] },
            {
              label: 'Manifest',
              value: [atom(`sha256 ${truncateDigest(packed.manifestDigest, caps.ascii)}`, null, 0)],
            },
            {
              label: 'Source',
              value: [atom(`sha256 ${truncateDigest(packed.sourceFingerprint, caps.ascii)}`, null, 0)],
            },
            // The file name carries the archive digest whole: §6.4 never truncates a digest inside an identifier.
            { label: 'File', value: [atom(packed.path, 'cyan', 0)] },
          ],
          { depth: 1 },
          caps,
        ),
      ],
      [
        sectionLabel('Members', caps),
        ...members
          .slice(0, LISTED_MEMBERS)
          .flatMap((path) => entry([[atom(path, 'cyan', 0)]], { depth: 1, symbol: 'info' }, caps)),
        ...(members.length > LISTED_MEMBERS
          ? entry(
              [words(`${caps.ascii ? '...' : '…'} and ${members.length - LISTED_MEMBERS} more`, 'dim')],
              { depth: 1 },
              caps,
            )
          : []),
      ],
      entry(
        [
          words(
            'Verify an acquired copy against the archive digest above before installing it: the file name is that digest.',
          ),
        ],
        { depth: 0, symbol: 'step' },
        caps,
      ),
    ],
    { leadingBlank: true },
  );
}

/** §2.7: the default directory is created by this command; a supplied one that is absent is a refusal. */
const destination = (root: string, cwd: string, supplied: string | undefined): string => {
  if (supplied === undefined) {
    const path = resolve(root, DEFAULT_OUT);
    mkdirSync(path, { recursive: true });
    return path;
  }
  return isAbsolute(supplied) ? resolve(supplied) : resolve(cwd, supplied);
};

export function collectPack(
  root: string,
  cwd: string,
  descriptorPath: string,
  out: string | undefined,
  force: boolean,
): PackView {
  // outputRoot is a thunk: a pack that refuses never selects or creates a destination for an archive that does
  // not exist. With --force the archive lands in a private directory first, because the packer's own publish
  // step refuses an existing entry and carries no bytes back for a second attempt.
  let selected: string | undefined;
  const select = (): string => {
    selected ??= destination(root, cwd, out);
    return selected;
  };
  if (!force) {
    const packed = attempt(() => packToDirectory({ sourceRoot: root, descriptorPath, outputRoot: select }));
    return { root, out: select(), packed };
  }
  let staging: string | undefined;
  const stage = (): string => {
    staging = mkdtempSync(resolve(select(), '.pack-'));
    return staging;
  };
  try {
    const packed = attempt(() => packToDirectory({ sourceRoot: root, descriptorPath, outputRoot: stage }));
    const content = readWorkspaceFile({ root: staging!, path: packed.path, limit: DISTRIBUTION_LIMITS.compressed });
    replace(select(), packed.path, content);
    return { root, out: select(), packed };
  } finally {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
  }
}

/** The existing-archive refusal is the service's own code; only the next action naming --force is the CLI's. */
function attempt(run: () => PackedArchive): PackedArchive {
  try {
    return run();
  } catch (error) {
    if (codeOf(error, '') !== 'IA-DIST-LOCAL-MODIFICATION') throw error;
    throw new Refusal(
      'IA-DIST-LOCAL-MODIFICATION',
      'An archive with this content digest is already in the output directory',
      3,
      null,
      'Pass --force to overwrite it, or pack into another --out directory.',
    );
  }
}

export function runPack(context: Context): Result {
  const { args, caps, json } = context;
  const root = requireRoot(context);
  const view = collectPack(root, context.host.cwd, args.value('descriptor')!, args.value('out'), args.flag('force'));
  // §2.7: packing has no "ran correctly, bad result" state, so this verb never returns 1.
  return json
    ? { exitCode: 0, stdout: JSON.stringify(packEnvelope(view)) + '\n', stderr: '' }
    : { exitCode: 0, stdout: renderPack(view, caps), stderr: '' };
}
