/**
 * `ia floor`: the minimum `inventarch/language` base a kit's or workspace's records need, the feature that sets it, and
 * how the range it declares compares with it (ia-kb design/language-base-floor: "every floor names the feature that set
 * it").
 *
 * The minimum is computed statically: `languageFloor` reads the `.ia/src` record trees against the compatibility index
 * this package ships, and its gaps name what the base below the minimum cannot read. The declared range is the
 * `inventarch/language` dependency of `.ia/release.json`, else the range the lock requests, else `^<locked version>` (an
 * old kit with neither is held to its locked base, never to "anything"); null only when there is no lock either.
 *
 * `--verify` proves the minimum: each carried base from it to the newest is restored offline from the bytes this
 * package carries into a scratch copy whose lock names that base, and validated there with `ia validate`'s own
 * collection; only error findings count. Nothing is written to the root. When a base reports errors the minimum is
 * raised to the lowest base from which every later base has none (null when the newest has errors), and the report says
 * so. Exit 0 for `ok` or `range-too-high`; 1 for `range-too-low`, `no-floor`, or any verified base with errors.
 *
 * `ia pack` holds a release to the same rule (`requireFloor`, called from pack.ts): a descriptor declaring a range that
 * admits a base below the minimum, or records no base reads, refuse; a range higher than needed is reported.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  compareVersions,
  INSTALL_PATHS,
  languageFloor,
  rangeFloor,
  satisfies,
  usageOf,
} from '@inventarch/db/distribution';
import type { CompatIndex, Gap, ReleaseDescriptor } from '@inventarch/db/distribution';
import { ARCHIVE_CACHE, applyInstallation, cacheArchive, planInstallation } from '@inventarch/distribution/install';
import { readWorkspaceJson } from '@inventarch/distribution/services';
import { declaredAssets, lockOnBase } from '@inventarch/runtime/method';
import type { Base } from './bundled-base.js';
import { readBases, readCompatIndex } from './bundled-base.js';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot, respell } from './consumer.js';
import { gapText, recordSources } from './record-sources.js';
import { codeOf } from './session.js';
import type { Capabilities } from './render.js';
import { atom, document, entry, headerLine, quote, sectionLabel, words } from './render.js';
import { collectValidation } from './validate.js';

export type FloorStatus = 'ok' | 'range-too-high' | 'range-too-low' | 'no-floor';
export interface Verified {
  readonly base: string;
  readonly errors: number;
}
export interface FloorView {
  readonly root: string;
  readonly id: string;
  /** The minimum: the static one, or under `--verify` the proven one. */
  readonly floor: string | null;
  /** The static minimum, before any verification raised it. */
  readonly computed: string | null;
  readonly newest: string;
  readonly declared: string | null;
  readonly status: FloorStatus;
  readonly suggested?: string;
  readonly gaps: readonly Gap[];
  readonly verified?: readonly Verified[];
}

const RELEASE = '.ia/release.json';
/** Gaps the human report lists; the rest are counted. */
const LISTED_GAPS = 20;
const majorOf = (value: string): number => Number(value.split('.')[0]);
/** Whether version `a` is at or above `b` (`compareVersions` orders the highest first). */
const atLeast = (a: string, b: string): boolean => compareVersions(a, b) <= 0;

const rows = (value: unknown, key: string): readonly Record<string, unknown>[] => {
  const list = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list)
    ? list.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    : [];
};
/** The range a list of `{id, range}` rows (a descriptor's `dependencies`, a lock's `requests`) gives `id`. */
const rangeOf = (value: unknown, key: string, id: string): string | undefined => {
  const range = rows(value, key).find((row) => row['id'] === id)?.['range'];
  return typeof range === 'string' ? range : undefined;
};
/** The committed lock as written, or undefined when there is none. */
const readLock = (root: string): unknown =>
  existsSync(join(root, INSTALL_PATHS.lock)) ? readWorkspaceJson({ root, path: INSTALL_PATHS.lock }) : undefined;
/** What the lock declares for `id` when no descriptor does: the range it requests, else `^<locked version>`. */
function lockRange(root: string, id: string): string | null {
  const lock = readLock(root);
  const requested = rangeOf(lock, 'requests', id);
  if (requested !== undefined) return requested;
  const locked = rows(lock, 'packages').find((row) => row['id'] === id)?.['version'];
  return typeof locked === 'string' ? `^${locked}` : null;
}
/** The declared range of a root: `.ia/release.json`'s dependency on `id`, else the lock's (`lockRange`). */
export function declaredRange(root: string, id: string): string | null {
  const descriptor = existsSync(join(root, RELEASE)) ? readWorkspaceJson({ root, path: RELEASE }) : undefined;
  return rangeOf(descriptor, 'dependencies', id) ?? lockRange(root, id);
}

/** How a declared range compares with a minimum, and the range to declare instead when it differs. */
export function floorStatus(
  declared: string | null,
  floor: string | null,
): { readonly status: FloorStatus; readonly suggested?: string } {
  if (floor === null) return { status: 'no-floor' };
  if (declared === null) return { status: 'ok' };
  const lowest = rangeFloor(declared);
  if (lowest === floor) return { status: 'ok' };
  return { status: atLeast(lowest, floor) ? 'range-too-high' : 'range-too-low', suggested: `^${floor}` };
}

/**
 * The copy of `root` a base is verified in: `.ia/` without its installation state or work folder, the archive cache
 * (the other locked releases), the release's declared assets, and LF record sources, as the door's read roots hold them.
 */
function scratchCopy(root: string, scratch: string): void {
  const ia = join(root, '.ia');
  cpSync(ia, join(scratch, '.ia'), {
    recursive: true,
    filter: (source) => {
      const path = relative(ia, source).replace(/\\/g, '/');
      return path !== 'work' && path !== 'distributions' && path !== 'distributions.lock.json';
    },
  });
  if (existsSync(join(root, ARCHIVE_CACHE)))
    cpSync(join(root, ARCHIVE_CACHE), join(scratch, ARCHIVE_CACHE), { recursive: true });
  for (const { rel, abs } of declaredAssets(root)) {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    copyFileSync(abs, join(scratch, rel));
  }
  for (const { path, text } of recordSources(scratch))
    if (text.includes('\r\n')) writeFileSync(join(scratch, path), text.replace(/\r\n/g, '\n'));
}
/**
 * The lock a base is verified on: `lockOnBase` moves only the language row to it, and a language request that does not
 * admit it is widened to `^<base>`, or the lock would not satisfy its own request.
 */
function lockFor(lock: unknown, base: Base): unknown {
  const moved = lockOnBase(lock, base.pin) as { requests?: { id?: unknown; range?: unknown }[] };
  for (const request of moved.requests ?? []) {
    if (request.id !== base.pin.id || typeof request.range !== 'string') continue;
    let admitted = false;
    try {
      admitted = satisfies(base.pin.version, request.range);
    } catch {
      // A range the codec refuses is replaced as well.
    }
    if (!admitted) request.range = `^${base.pin.version}`;
  }
  return moved;
}
/**
 * The installer's own admission (apps/distribution `IA-DIST-ADMISSION-FAILED`) refuses a restore whose records have
 * errors on the base (every error but a canon finding, compliance `refusesInstallation`), so `ia validate` never runs
 * there: those errors are the base's count. The message lists them as JSON when it can; otherwise the refused records
 * or blocked systems it names count as one. Undefined for any other refusal.
 */
function admissionErrors(error: unknown): number | undefined {
  if (codeOf(error, '') !== 'IA-DIST-ADMISSION-FAILED') return undefined;
  try {
    const findings = JSON.parse(error instanceof Error ? error.message : '') as unknown;
    if (Array.isArray(findings) && findings.length > 0) return findings.length;
  } catch {
    // Not a list of findings: one refusal.
  }
  return 1;
}
/**
 * The error findings `ia validate` reports for `root` restored offline on `base`, in a scratch copy removed after, or
 * the errors the restore's own admission refused it for.
 */
function errorsOn(root: string, lock: unknown, base: Base): number {
  const scratch = mkdtempSync(join(tmpdir(), 'ia-floor-'));
  try {
    scratchCopy(root, scratch);
    cacheArchive(scratch, base.bytes, base.pin.archive);
    const moved = lockFor(lock, base);
    writeFileSync(join(scratch, INSTALL_PATHS.lock), JSON.stringify(moved) + '\n');
    try {
      applyInstallation(planInstallation(scratch, moved, 'restore'));
    } catch (error) {
      const refused = admissionErrors(error);
      if (refused === undefined) throw error;
      return refused;
    }
    return collectValidation(scratch, null).findings.filter((finding) => finding.severity === 'error').length;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
/** The lowest verified base from which every later one has no error, or null when the newest has errors. */
export function provenFloor(verified: readonly Verified[]): string | null {
  let floor: string | null = null;
  for (const row of [...verified].reverse()) {
    if (row.errors > 0) break;
    floor = row.base;
  }
  return floor;
}

export function collectFloor(root: string, packageRoot: string, verify: false | { readonly rerun: string }): FloorView {
  const index: CompatIndex = readCompatIndex(packageRoot);
  const declared = declaredRange(root, index.id);
  const { floor: computed, newest, gaps } = languageFloor(usageOf(recordSources(root)), index);
  let floor = computed,
    verified: Verified[] | undefined;
  if (verify !== false) {
    const lock = readLock(root);
    if (!rows(lock, 'packages').some((row) => row['id'] === index.id))
      throw new Refusal(
        'IA-CLI-CONFLICT',
        `--verify restores the workspace's lock on each base, and ${lock === undefined ? `${root} has no ${INSTALL_PATHS.lock}` : `its lock holds no ${index.id} row`}`,
        3,
        { path: INSTALL_PATHS.lock },
        `Run "${verify.rerun}" for the minimum its records need without the proof.`,
      );
    const bases =
      computed === null
        ? []
        : readBases(packageRoot).filter(
            (base) => majorOf(base.pin.version) === index.major && atLeast(base.pin.version, computed),
          );
    verified = bases.map((base) => ({ base: base.pin.version, errors: errorsOn(root, lock, base) }));
    if (computed !== null) floor = provenFloor(verified);
  }
  return {
    root,
    id: index.id,
    floor,
    computed,
    newest,
    declared,
    ...floorStatus(declared, floor),
    gaps,
    ...(verified === undefined ? {} : { verified }),
  };
}

export const floorExit = (view: FloorView): 0 | 1 =>
  (view.status === 'ok' || view.status === 'range-too-high') && (view.verified ?? []).every((row) => row.errors === 0)
    ? 0
    : 1;

export function floorEnvelope(view: FloorView): unknown {
  return {
    version: 1,
    floor: view.floor,
    newest: view.newest,
    declared: view.declared,
    status: view.status,
    ...(view.suggested === undefined ? {} : { suggested: view.suggested }),
    gaps: view.gaps,
    ...(view.verified === undefined ? {} : { verified: view.verified }),
  };
}

/** The one line that says how the declared range compares with the minimum. */
function verdict(view: FloorView): string {
  const { declared, floor, newest } = view;
  switch (view.status) {
    case 'no-floor':
      return `No ${view.id} base reads these records, the newest (${newest}) included.`;
    case 'range-too-high':
      return `The declared range ${declared} is higher than these records need: ${view.suggested} is enough.`;
    case 'range-too-low':
      return `The declared range ${declared} admits a base below the minimum ${floor}: declare ${view.suggested}.`;
    case 'ok':
      return declared === null
        ? `Nothing declares a ${view.id} range; ${floor} is the lowest base these records allow.`
        : `The declared range ${declared} starts at the minimum ${floor}.`;
  }
}

export function renderFloor(view: FloorView, caps: Capabilities): string {
  const { gaps, verified } = view;
  const raised = verified !== undefined && view.computed !== null && view.floor !== view.computed;
  const reason =
    gaps.length === 0
      ? [
          entry(
            [words(`Every base this CLI knows, ${view.computed} to ${view.newest}, reads these records.`)],
            { depth: 1, symbol: 'info' },
            caps,
          ),
        ]
      : [
          ...gaps.slice(0, LISTED_GAPS).map((gap) => entry([words(gapText(gap))], { depth: 1, symbol: 'info' }, caps)),
          ...(gaps.length > LISTED_GAPS
            ? [
                entry(
                  [words(`${caps.ascii ? '...' : '…'} and ${gaps.length - LISTED_GAPS} more`, 'dim')],
                  { depth: 1 },
                  caps,
                ),
              ]
            : []),
        ];
  const failing = (verified ?? []).filter((row) => row.errors > 0);
  return document(
    [
      headerLine('Floor', `${view.id} ${view.floor ?? 'none'}`, [{ text: view.root, column: 50 }], caps),
      entry(
        [words(verdict(view))],
        { depth: 1, symbol: floorExit(view) === 0 ? (view.status === 'ok' ? 'success' : 'warning') : 'error' },
        caps,
      ),
      [
        sectionLabel(view.computed === null ? 'Why no base reads them' : `Why ${view.computed}`, caps),
        ...reason.flat(),
      ],
      verified === undefined
        ? []
        : [
            sectionLabel('Verified', caps),
            ...(verified.length === 0
              ? entry([words('No base to verify: the records have no minimum.')], { depth: 1, symbol: 'info' }, caps)
              : verified.flatMap((row) =>
                  entry(
                    [
                      [
                        atom(row.base, 'cyan', 0),
                        ...words(`${row.errors} ${row.errors === 1 ? 'error' : 'errors'} on validation`, null, 2),
                      ],
                    ],
                    { depth: 1, symbol: row.errors === 0 ? 'success' : 'error' },
                    caps,
                  ),
                )),
            ...(raised || (failing.length > 0 && view.floor === null)
              ? entry(
                  [
                    words(
                      view.floor === null
                        ? `The newest base reports errors, so no base is proven: the static minimum was ${view.computed}.`
                        : `The minimum is raised from ${view.computed} to ${view.floor}: ${failing.map((row) => row.base).join(', ')} ${failing.length === 1 ? 'reports' : 'report'} errors.`,
                    ),
                  ],
                  { depth: 1, symbol: 'warning' },
                  caps,
                )
              : []),
          ],
    ],
    { leadingBlank: true },
  );
}

export function runFloor(context: Context): Result {
  const { args, caps, json } = context;
  const root = requireRoot(context);
  const supplied = args.value('root');
  const view = collectFloor(
    root,
    context.host.packageRoot,
    args.flag('verify')
      ? { rerun: ['ia floor', ...(supplied === undefined ? [] : ['--root', quote(supplied)])].join(' ') }
      : false,
  );
  const exitCode = floorExit(view);
  return json
    ? { exitCode, stdout: JSON.stringify(floorEnvelope(view)) + '\n', stderr: '' }
    : { exitCode, stdout: renderFloor(view, caps), stderr: '' };
}

/**
 * `ia pack`'s check, before anything is packed: the descriptor's `inventarch/language` range (else the lock's, as
 * `declaredRange` reads a root) against the static minimum. Records no base reads, and a range admitting a base below
 * the minimum, refuse with `IA-CLI-CONFLICT`; a range higher than needed returns the minimum, which pack reports. A root
 * that declares no range is not checked.
 */
export function requireFloor(
  context: Pick<Context, 'command' | 'args' | 'host'>,
  root: string,
  path: string,
  descriptor: ReleaseDescriptor,
): { readonly minimum: string; readonly declared: string } | undefined {
  const index = readCompatIndex(context.host.packageRoot);
  const named = rangeOf(descriptor, 'dependencies', index.id);
  const declared = named ?? lockRange(root, index.id);
  if (declared === null) return undefined;
  const { floor, newest, gaps } = languageFloor(usageOf(recordSources(root)), index);
  const { status } = floorStatus(declared, floor);
  const why = gaps[0] === undefined ? '' : `: ${gapText(gaps[0])}`;
  if (floor === null)
    throw new Refusal(
      'IA-CLI-CONFLICT',
      `No ${index.id} base reads this workspace's records, the newest (${newest}) included${why}`,
      3,
      gaps[0] === undefined ? { path } : { path: gaps[0].source },
      `Fix the record the message names, then run "${respell(context)}".`,
    );
  if (status === 'range-too-low')
    throw new Refusal(
      'IA-CLI-CONFLICT',
      `${named === undefined ? `The workspace lock (${INSTALL_PATHS.lock}) requests` : `The release descriptor ${path} declares`} ${index.id} ${declared}, which admits a base below the minimum ${floor} its records need${why}`,
      3,
      { path: named === undefined ? INSTALL_PATHS.lock : path },
      `Declare ${index.id} ^${floor} in ${path}, then run "${respell(context)}".`,
    );
  return status === 'range-too-high' ? { minimum: floor, declared } : undefined;
}
