/**
 * The console's offer table (consumer CLI contract §1.2 and §2.12). Every command an offer runs is a doctor check's `fix` or
 * one of the package-manager argv builders, never text: one offer per reported check with a fix (warn or fail: attention; info:
 * set up), the set-up offers doctor has no fix for (register a host, add a kit, track this workspace), the upgrade
 * recipe, the More entries, and the offers an extension declares as data. Check ids are an open set: a row this table
 * does not know still gets its offer, titled by its check. Pure: everything it reads is in the state.
 */
import { compareVersions } from '@inventarch/distribution/updates';
import { REQUEST } from '../distribute.js';
import type { ExtensionConsole } from '../doctor-extensions.js';
import type { Fix, WritesTo } from '../fix.js';
import { externalFix, iaFix } from '../fix.js';
import { installArgv, pinArgv } from '../package-manager.js';
import type { ConsoleCheck, ConsoleState } from './state.js';
import { AREA_TABLE, areaOf, DEFAULT_AREA } from './state.js';

export interface Step extends Fix {
  /** Stop the recipe with "the repo copy is not installed" when no repo copy resolves at this step. */
  readonly requires?: 'repo-copy';
}
export type Group = 'attention' | 'setup' | 'more';
export interface Offer {
  readonly id: string;
  readonly answers: readonly string[];
  readonly title: string;
  readonly explain: string;
  readonly steps: readonly Step[];
  readonly changes: readonly string[];
  readonly group: Group;
  readonly area: string | null;
  readonly writesTo: readonly WritesTo[];
  readonly batchable: boolean;
  /** One line of input taken before the steps are built; `accept` returns a refusal message, or null. */
  readonly input?: {
    readonly label: string;
    readonly accept: (value: string) => string | null;
    readonly build: (value: string) => readonly Step[];
  };
  /** Why the offer cannot run; enter shows it. */
  readonly disabled?: string;
  /** An offer that opens a view rather than running steps. */
  readonly view?: 'diagnostics';
}

/** Offer titles by check id; an id missing here is titled by its check. */
const TITLES: Readonly<Record<string, string>> = {
  'plugin-claude': 'Refresh Claude plugin',
  records: 'Fix record errors',
  generation: 'Re-lock',
  pending: 'Resume interrupted install',
  'install-lock': 'Resume interrupted install',
  marketplace: 'Install the Claude plugin',
  root: 'Initialise a workspace here',
};
function titleOf(row: ConsoleCheck): string {
  if (row.id.startsWith('kit-update:')) return `Update kit ${row.id.slice('kit-update:'.length)}`;
  if (row.id === 'cli-version') return row.status === 'info' ? 'Pin the CLI in this repo' : 'Install dependencies';
  return TITLES[row.id] ?? row.title;
}
/** One sentence on what running the steps does, by the first step's flow. */
function sentence(steps: readonly Step[]): string {
  const first = steps[0];
  if (first === undefined) return '';
  const recipe = steps.length > 1 ? ` It runs ${steps.length} steps in order and stops at the first that fails.` : '';
  switch (first.flow) {
    case 'preview-apply':
      return `It previews the change first and applies it when you confirm.${recipe}`;
    case 'preview-flag':
      return `It runs a preview first and the command when you confirm.${recipe}`;
    case 'confirm':
      return `It shows the command and runs it when you confirm.${recipe}`;
    case 'immediate':
      return `It runs straight away.${recipe}`;
  }
}
const explainOf = (detail: string, steps: readonly Step[]): string =>
  [detail.endsWith('.') ? detail : `${detail}.`, sentence(steps)].filter((part) => part !== '').join(' ');

/** What a step writes, as the right pane names it. */
function change(step: Step): string {
  if (step.writesTo === 'none') return 'writes nothing';
  if (step.writesTo === 'machine') return 'this machine';
  if (step.writesTo === 'repo')
    return step.program === 'external' ? 'this repo (package.json, lockfile)' : 'this repo (.ia/)';
  if (step.program === 'ia' && step.argv[0] === 'workspaces') return 'your IA home (tracked-workspaces.json)';
  if (step.program === 'ia' && step.argv[0] === 'host' && step.argv.includes('--user'))
    return '~/.claude plugin and your IA home';
  if (step.program === 'external' && step.argv.includes('refresh-updates')) return 'your IA home (update cache)';
  return 'your IA home';
}
function changesOf(steps: readonly Step[]): readonly string[] {
  const writes = [...new Set(steps.filter((step) => step.writesTo !== 'none').map(change))];
  return writes.length === 0 ? ['writes nothing'] : writes;
}
/** At least one step writes the repo; every other writes nothing, the user's home or the machine. */
export const batchable = (steps: readonly Step[]): boolean => steps.some((step) => step.writesTo === 'repo');

/** Which copy runs a step (consumer CLI contract §1.2): its program, the running copy for user or machine writes, else the repo's. */
export function runsOn(step: Step, state: Pick<ConsoleState, 'running' | 'repo'>): 'external' | 'running' | 'repo' {
  if (step.program === 'external') return 'external';
  if (step.writesTo === 'user' || step.writesTo === 'machine') return 'running';
  return state.repo === null ? 'running' : 'repo';
}

interface Draft {
  readonly id: string;
  readonly answers: readonly string[];
  readonly title: string;
  readonly explain: string;
  readonly steps: readonly Step[];
  readonly group: Group;
  readonly input?: NonNullable<Offer['input']>;
  readonly disabled?: string;
  readonly view?: 'diagnostics';
}

/** The kit request line: the CLI's own request grammar, never an option. */
function acceptKit(value: string): string | null {
  if (value.startsWith('-')) return 'A kit id cannot start with a dash.';
  if (value === '' || /\s/.test(value) || !REQUEST.test(value))
    return 'Enter a kit id as scope/name, optionally with @range, such as acme/kit@^1.2.';
  return null;
}
const buildKit = (value: string): readonly Step[] => [iaFix(['install', value], 'repo').fix!];

/** Install and pin for a copy that reports `cli-version` without a fix, with the manifest's directory named. */
function cliFallback(row: ConsoleCheck, state: ConsoleState): Fix | null {
  const { manager, managerConflict, manifestDir } = state.facts;
  if (manager === null || managerConflict.length > 0 || state.root === null) return null;
  if (row.status === 'warn' && manifestDir !== null)
    return externalFix(installArgv(manager, manifestDir, state.root), 'repo').fix;
  if (row.status === 'info')
    return externalFix(pinArgv(manager, state.running.version, manifestDir ?? state.root, state.root), 'repo').fix;
  return null;
}

/** The upgrade recipe, each step included only when it applies; none without a manager the repo agrees on. */
function upgrade(state: ConsoleState): Draft | null {
  const { latest, manager, managerConflict, manifestDir, generation, marketplace } = state.facts;
  if (latest === null || state.repo === null || state.root === null || manifestDir === null) return null;
  if (manager === null || managerConflict.length > 0) return null;
  if (compareVersions(latest, state.repo.version) <= 0) return null;
  const steps: Step[] = [externalFix(pinArgv(manager, latest, manifestDir, state.root), 'repo').fix];
  if (generation) steps.push({ ...iaFix(['restore', '--apply'], 'repo').fix!, requires: 'repo-copy' });
  steps.push({ ...iaFix(['validate'], 'none').fix!, requires: 'repo-copy' });
  if (marketplace) steps.push(iaFix(['host', 'claude', '--user', '--apply'], 'user').fix!);
  return {
    id: 'upgrade',
    answers: ['cli-version', 'updates'],
    title: `Upgrade CLI to ${latest}`,
    explain: explainOf(`ia ${latest} is available; this workspace pins ${state.repo.version}`, steps),
    steps,
    group: 'attention',
  };
}

const ORDER: readonly Group[] = ['attention', 'setup', 'more'];
const sameSteps = (a: readonly Step[], b: readonly Step[]): boolean =>
  a.length === b.length &&
  a.every(
    (step, index) =>
      step.program === b[index]!.program &&
      step.argv.length === b[index]!.argv.length &&
      step.argv.every((part, at) => part === b[index]!.argv[at]),
  );

/** Every offer for the state: attention, then set up, then More; inside a group, by area order, then as found. */
export function offersFor(state: ConsoleState, extensions: readonly ExtensionConsole[] = []): readonly Offer[] {
  const reported = state.checks.filter((row) => row.reported);
  const byId = new Map(reported.map((row) => [row.id, row]));
  const drafts: Draft[] = [];
  const add = (draft: Draft): void => {
    // Two checks with the same command make one offer that answers both.
    const same = draft.steps.length > 0 ? drafts.find((other) => sameSteps(other.steps, draft.steps)) : undefined;
    if (same === undefined) drafts.push(draft);
    else drafts[drafts.indexOf(same)] = { ...same, answers: [...same.answers, ...draft.answers] };
  };

  for (const row of reported) {
    if (row.status === 'ok' || row.status === 'unknown') continue;
    const fix = row.fix ?? (row.id === 'cli-version' ? cliFallback(row, state) : null);
    if (fix === null) continue;
    add({
      id: `fix:${row.id}`,
      answers: [row.id],
      title: titleOf(row),
      explain: explainOf(row.detail, [fix]),
      steps: [fix],
      group: row.id === 'root' || row.status === 'info' ? 'setup' : 'attention',
    });
  }
  const recipe = upgrade(state);
  if (recipe !== null) add(recipe);

  if (byId.get('host')?.status === 'info')
    for (const host of ['claude', 'codex'] as const) {
      const steps = [iaFix(['host', host], 'repo').fix!];
      add({
        id: `register-host:${host}`,
        answers: ['host'],
        title: `Register a host: ${host === 'claude' ? 'Claude' : 'Codex'}`,
        explain: explainOf(`No host is registered; this registers ${host === 'claude' ? 'Claude' : 'Codex'}`, steps),
        steps,
        group: 'setup',
      });
    }
  const kits = byId.get('kits');
  if (state.root !== null && kits !== undefined)
    add({
      id: 'add-kit',
      answers: ['kits'],
      title: 'Add a kit…',
      explain: explainOf(
        kits.status === 'info' ? 'No kits are installed' : 'Installs another kit',
        buildKit('scope/name'),
      ),
      steps: buildKit('<kit>'),
      group: kits.status === 'info' ? 'setup' : 'more',
      input: { label: 'Kit id', accept: acceptKit, build: buildKit },
    });
  if (state.root !== null && !state.tracked) {
    const steps = [iaFix(['workspaces', 'add', state.root], 'user').fix!];
    add({
      id: 'track',
      answers: [],
      title: 'Track this workspace',
      explain: explainOf('This workspace is not in your tracked list, which the all-workspaces view reads', steps),
      steps,
      group: 'setup',
    });
  }

  for (const extension of extensions)
    for (const declared of extension.offers) {
      const statuses = declared.answers.flatMap((id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [row.status];
      });
      const group: Group | null =
        declared.answers.length === 0
          ? 'more'
          : statuses.some((status) => status === 'warn' || status === 'fail')
            ? 'attention'
            : statuses.includes('info')
              ? 'setup'
              : null;
      if (group === null) continue;
      const steps = declared.steps.map((step): Step => ({ program: 'ia', ...step, argv: [...step.argv] }));
      add({
        id: declared.id,
        answers: declared.answers,
        title: declared.title,
        explain: declared.explain,
        steps,
        group,
      });
    }

  add({
    id: 'diagnostics',
    answers: [],
    title: 'Diagnostics',
    explain: 'Every doctor check for this workspace, with the copy that reported it.',
    steps: [],
    group: 'more',
    view: 'diagnostics',
  });
  if (state.refreshNow !== null) {
    const steps: Step[] = [{ program: 'external', argv: [...state.refreshNow], flow: 'immediate', writesTo: 'user' }];
    add({
      id: 'check-updates',
      answers: [],
      title: 'Check for updates now',
      explain: explainOf(
        'Asks the update source for the newest ia and every installed kit, even if checked today',
        steps,
      ),
      steps,
      group: 'more',
    });
  } else
    add({
      id: 'check-updates',
      answers: [],
      title: 'Check for updates now',
      explain: `Not available: ${state.refreshNowWhy ?? 'the update mechanism could not be found'}.`,
      steps: [],
      group: 'more',
      disabled: state.refreshNowWhy ?? 'the update mechanism could not be found',
    });

  // Area order: the table's areas, Other, then the extension areas; an offer with no area comes last in its group.
  const areaOrder = [
    ...AREA_TABLE.flatMap((row) => (row.area === null ? [] : [row.area])),
    DEFAULT_AREA,
    ...extensions.flatMap((extension) => extension.areas.map((area) => area.id)),
  ];
  const rank = (area: string | null): number => {
    const at = area === null ? -1 : areaOrder.indexOf(area);
    return at === -1 ? areaOrder.length : at;
  };
  return drafts
    .map((draft, index): { offer: Offer; index: number } => {
      const area = draft.answers.length === 0 ? null : areaOf(draft.answers[0]!, extensions);
      return {
        index,
        offer: {
          ...draft,
          area,
          changes: changesOf(draft.steps),
          writesTo: [...new Set(draft.steps.map((step) => step.writesTo))],
          batchable: batchable(draft.steps),
        },
      };
    })
    .sort(
      (a, b) =>
        ORDER.indexOf(a.offer.group) - ORDER.indexOf(b.offer.group) ||
        rank(a.offer.area) - rank(b.offer.area) ||
        a.index - b.index,
    )
    .map((entry) => entry.offer);
}

/** The ids whose `info` rows count as "not set up" (○): those a set-up offer answers. */
export function setupIds(
  state: Omit<ConsoleState, 'areas'>,
  extensions: readonly ExtensionConsole[] = [],
): ReadonlySet<string> {
  const info = new Set(state.checks.filter((row) => row.reported && row.status === 'info').map((row) => row.id));
  return new Set(
    offersFor({ ...state, areas: [] }, extensions)
      .filter((offer) => offer.group === 'setup')
      .flatMap((offer) => offer.answers)
      .filter((id) => info.has(id)),
  );
}
