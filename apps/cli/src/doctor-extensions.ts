/**
 * `Extension.console`: consumer CLI contract §2.12 and host-plugin-distribution §7.3. A private build contributes to the
 * console as data only: areas that group check ids, offers whose steps are the extension's own commands, and doctor
 * checks it leaves in a state file under the IA home. Nothing here runs an extension or reads a network.
 *
 * The state file is `{"format": "ia-extension-checks", "formatVersion": 1, "checks": [{id, title, status, detail, remedy, fix?}]}`. Its
 * checks join doctor's Environment section after the user rows. Every id must start with `<token>-` and name no core
 * row; a row that does not is dropped and named in one `unknown` row, `<token>-state`, which also stands for a file
 * that cannot be read. A fix must run the extension's own token through `ia`; any other is dropped. A fix takes its flow
 * and target from the console's declared step with the same argv; a fix no step declares is always `confirm` and writes
 * `machine`.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { Extension } from './consumer.js';
import type { Check, CheckStatus } from './doctor.js';
import type { Fix, Flow, WritesTo } from './fix.js';

export interface ConsoleArea {
  readonly id: string;
  readonly title: string;
  /** The check ids the area groups; an id doctor does not report is shown as not checked. */
  readonly checks: readonly string[];
}
export interface ConsoleStep {
  /** `argv[0]` is the extension's token: a step runs only the extension's own commands. */
  readonly argv: readonly string[];
  readonly flow: Flow;
  readonly writesTo: WritesTo;
}
export interface ConsoleOffer {
  readonly id: string;
  /** The check ids this offer answers. */
  readonly answers: readonly string[];
  readonly title: string;
  readonly explain: string;
  readonly steps: readonly ConsoleStep[];
}
export interface ExtensionConsole {
  readonly areas: readonly ConsoleArea[];
  readonly offers: readonly ConsoleOffer[];
  /** The state file, relative to the IA home. */
  readonly state: string;
}

export const EXTENSION_CHECKS_FORMAT = 'ia-extension-checks';
export const EXTENSION_CHECKS_FORMAT_VERSION = 1;
/** The literal state files carried before `formatVersion` existed; still read. */
const LEGACY_EXTENSION_CHECKS_FORMATS: readonly string[] = ['ia-extension-checks-1'];
const STATUSES: readonly CheckStatus[] = ['ok', 'warn', 'fail', 'unknown', 'info'];
const FLOWS: readonly Flow[] = ['preview-apply', 'preview-flag', 'confirm', 'immediate'];
const WRITES: readonly WritesTo[] = ['none', 'repo', 'user', 'machine'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The fix as given, when it runs `ia <token> …` with a known flow and target; null otherwise. The state file is data an
 * extension writes at run time, so its flow and target are a claim, not a grant: the flow and target come from the
 * console's own declared step with the same argv, and a fix no declared step names always asks first (`confirm`) and
 * claims the widest target (`machine`): never batched across repos, run once by the running copy, and described as
 * writing this machine.
 */
function ownFix(value: unknown, token: string, declared: readonly ConsoleStep[]): Fix | null {
  if (!isRecord(value)) return null;
  const { program, argv, flow, writesTo } = value;
  if (
    program !== 'ia' ||
    !Array.isArray(argv) ||
    !argv.every((part) => typeof part === 'string') ||
    argv[0] !== token ||
    !FLOWS.includes(flow as Flow) ||
    !WRITES.includes(writesTo as WritesTo)
  )
    return null;
  const step = declared.find((candidate) => JSON.stringify(candidate.argv) === JSON.stringify(argv));
  return step === undefined
    ? { program, argv: [...(argv as string[])], flow: 'confirm', writesTo: 'machine' }
    : { program, argv: [...(argv as string[])], flow: step.flow, writesTo: step.writesTo };
}
type Row = Omit<Check, 'section' | 'fix'> & { readonly fix: unknown };
function decodeRows(text: string): readonly Row[] {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    (value['format'] === EXTENSION_CHECKS_FORMAT
      ? value['formatVersion'] !== EXTENSION_CHECKS_FORMAT_VERSION
      : !LEGACY_EXTENSION_CHECKS_FORMATS.includes(value['format'] as string) || Object.hasOwn(value, 'formatVersion')) ||
    !Array.isArray(value['checks'])
  )
    throw new Error(`not an ${EXTENSION_CHECKS_FORMAT} file`);
  return value['checks'].map((row): Row => {
    if (
      !isRecord(row) ||
      typeof row['id'] !== 'string' ||
      typeof row['title'] !== 'string' ||
      !STATUSES.includes(row['status'] as CheckStatus) ||
      typeof row['detail'] !== 'string' ||
      (row['remedy'] !== null && typeof row['remedy'] !== 'string')
    )
      throw new Error('a check needs its id, title, status, detail and remedy');
    return {
      id: row['id'],
      title: row['title'],
      status: row['status'] as CheckStatus,
      detail: row['detail'],
      remedy: row['remedy'] as string | null,
      fix: row['fix'],
    };
  });
}

/**
 * The checks each extension's console state contributes, in extension order. `reserved` holds the ids doctor already
 * reports, which an extension row never replaces. Never throws.
 */
export function extensionChecks(
  extensions: readonly Extension[],
  home: string | null,
  reserved: ReadonlySet<string> = new Set(),
): readonly Check[] {
  if (home === null) return [];
  return extensions.flatMap((extension): Check[] => {
    const console = extension.console;
    if (console === undefined) return [];
    const token = extension.token,
      stateId = `${token}-state`;
    const state = (detail: string): Check => ({
      id: stateId,
      section: 'Environment',
      title: `${token} state`,
      status: 'unknown',
      detail,
      remedy: null,
      fix: null,
    });
    const relative = normalize(console.state);
    if (isAbsolute(relative) || relative === '..' || relative.startsWith(`..${sep}`))
      return [state(`state unreadable: ${console.state} is outside the IA home`)];
    let text: string;
    try {
      text = readFileSync(join(home, relative), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [state(`state unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)];
    }
    let rows: readonly Row[];
    try {
      rows = decodeRows(text);
    } catch (error) {
      return [state(`state unreadable: ${error instanceof Error ? error.message : String(error)}`)];
    }
    const kept: Check[] = [],
      dropped: string[] = [];
    const steps = console.offers.flatMap((offer) => offer.steps);
    for (const row of rows) {
      if (!row.id.startsWith(`${token}-`) || row.id === stateId || reserved.has(row.id)) dropped.push(row.id);
      else kept.push({ ...row, section: 'Environment', fix: ownFix(row.fix, token, steps) });
    }
    return dropped.length === 0
      ? kept
      : [...kept, state(`dropped rows outside ${token}- or naming a core check: ${dropped.join(', ')}`)];
  });
}
