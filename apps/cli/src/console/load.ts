/**
 * Loading the console's state: the only effectful part of the model. Doctor collection reads the filesystem and the
 * clock, so it is injected (`collect`, `collectDoctor` in production), as is the run of the workspace's own copy's
 * `doctor --json` (`spawnDoctor`). Everything they feed is state.ts and offers.ts, which are pure.
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sameFile } from '@inventarch/db/internal/paths';
import { INSTALL_PATHS } from '@inventarch/db/distribution';
import type { Extension } from '../consumer.js';
import { discoverRoot, iaHomeOf } from '../discovery.js';
import type { DoctorRequest, DoctorView } from '../doctor.js';
import { doctorRequest } from '../doctor.js';
import { cliVersionRow } from '../doctor-user.js';
import { NO_HANDOFF, runnableCopy } from '../handoff.js';
import { readCliDependency } from '../local-cli.js';
import { readMarketplaceRecord } from '../marketplace-record.js';
import { detectPackageManager } from '../package-manager.js';
import type { Env } from '../program.js';
import { readTracked, trackedRow } from '../tracked.js';
import { setupIds } from './offers.js';
import type { ConsoleFacts, ConsoleState, DoctorReport, DoctorRun } from './state.js';
import { areaOf, areasOf, assembleRows, DOCTOR_TIMEOUT_MS, readDoctorReport, runningOwner } from './state.js';

export type SpawnDoctor = (entry: string, root: string, signal?: AbortSignal) => Promise<DoctorRun>;
/** What decides which `info` rows count as "not set up": the ids a set-up offer answers. */
export type SetupIds = (state: Omit<ConsoleState, 'areas'>) => ReadonlySet<string>;

/** `<entry> doctor --json --root <root>` under `IA_NO_HANDOFF=1`, bounded at 20 s; never throws. */
export function doctorProcess(env: Env): SpawnDoctor {
  return (entry, root, signal) =>
    new Promise((settle) => {
      execFile(
        process.execPath,
        [entry, 'doctor', '--json', '--root', root],
        {
          cwd: root,
          env: { ...env, [NO_HANDOFF]: '1' },
          timeout: DOCTOR_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
          ...(signal === undefined ? {} : { signal }),
        },
        (error, stdout) => {
          if (error === null) settle({ status: 0, stdout });
          else if (typeof error.code === 'number') settle({ status: error.code, stdout });
          else settle({ status: null, stdout, timedOut: error.killed === true });
        },
      );
    });
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
/** Areas the console shows outside a workspace: the running copy's own. */
const OUTSIDE: ReadonlySet<string> = new Set(['cli', 'updates', 'plugin']);

export async function loadState(input: {
  readonly cwd: string;
  readonly env: Env;
  readonly packageRoot: string;
  readonly version: string;
  readonly collect: (request: DoctorRequest) => DoctorView;
  readonly spawnDoctor?: SpawnDoctor;
  readonly extensions?: readonly Extension[];
  readonly setupIds?: SetupIds;
  /** Aborts the repo copy's doctor run: the console aborts it when it finishes during a load. */
  readonly signal?: AbortSignal;
}): Promise<ConsoleState> {
  const { env, packageRoot, version } = input;
  const extensions = input.extensions ?? [];
  const consoles = extensions.flatMap((extension) => (extension.console === undefined ? [] : [extension.console]));
  const owned = runningOwner(extensions);
  const view = input.collect(doctorRequest({ cwd: input.cwd, packageRoot, env, version, extensions }));
  const found = discoverRoot(input.cwd, iaHomeOf(env));
  const root = found === undefined ? null : real(found);
  const dependency = root === null ? null : readCliDependency(root);
  const manifestDir = dependency === null ? null : dirname(dependency.manifest);
  // The copy hand-off would run (handoff.ts): found up to the workspaces root that hoists it, and none when the
  // repository commits it or the user set IA_NO_HANDOFF=1. Without one, the rows come from this process and every step
  // runs on the running copy, as when no copy is installed.
  const copy = root === null ? null : runnableCopy(root, { env, running: packageRoot });
  // The running copy answers for itself; only another copy is run.
  const other = copy !== null && !sameFile(copy.packageRoot, packageRoot) ? copy : null;
  let report: DoctorReport | null = null;
  if (other !== null && root !== null)
    report = readDoctorReport(await (input.spawnDoctor ?? doctorProcess(env))(other.entry, root, input.signal));
  const running = view.checks.filter((row) => owned(row.id));
  const inProcess = view.checks.filter((row) => !owned(row.id));
  const assembled = assembleRows({
    running,
    inProcess,
    repo: report,
    repoCopy: other,
    owned,
    cliVersion: (from) =>
      cliVersionRow({ root: root!, packageRoot: from.packageRoot, version: from.version, env, host: false }),
  });
  // Outside a workspace the view is the running copy's areas and the root row, which offers `ia init`.
  const checks =
    root === null
      ? assembled.checks.filter(
          (row) => owned(row.id) || row.id === 'root' || OUTSIDE.has(areaOf(row.id, consoles) ?? ''),
        )
      : assembled.checks;
  const home = view.facts?.home ?? iaHomeOf(env) ?? null;
  let tracked = true;
  if (root !== null && home !== null)
    try {
      tracked = trackedRow(readTracked(home), root) !== undefined;
    } catch {
      // A tracked list that cannot be read is not offered a row it would refuse; `ia workspaces` names the problem.
      tracked = true;
    }
  const managed = manifestDir === null ? null : detectPackageManager(manifestDir);
  const facts: ConsoleFacts = {
    home,
    latest: view.facts?.cachedLatest ?? null,
    manifestDir,
    manager: managed?.manager ?? null,
    managerConflict: managed?.conflict ?? [],
    generation: root !== null && existsSync(join(root, INSTALL_PATHS.active)),
    marketplace: home !== null && readMarketplaceRecord(home).state === 'present',
  };
  const state: Omit<ConsoleState, 'areas'> = {
    root,
    running: { packageRoot, version },
    repo: copy,
    checks,
    repoFailure: assembled.repoFailure,
    tracked,
    refreshNow: view.facts?.refreshNow ?? null,
    refreshNowWhy: view.facts?.refreshNowWhy ?? (view.facts === undefined ? 'doctor reported no update facts' : null),
    facts,
  };
  const setup = (input.setupIds ?? ((loaded) => setupIds(loaded, consoles)))(state);
  return { ...state, areas: areasOf(checks, setup, consoles) };
}
