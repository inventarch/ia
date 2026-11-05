/**
 * Planning a batch (consumer CLI contract §1.2): one batchable offer applied to the selected workspaces, each in a new
 * git worktree on a new branch. A plan names, per repository, the worktree path, the branch and the exact steps, so the
 * preview shows what will run before anything does.
 *
 * Steps that write the user's home or the machine are left out of every repository's run: a worktree isolates only
 * repository writes. They are collected, de-duplicated by their display text and offered once afterwards.
 *
 * A step does not run in the user's checkout, and `cwd` alone does not keep it out: a fix may carry `--root <the
 * original>`, a package-manager step `--prefix <dir>`, and a relative `../x` can lead anywhere. So every path-bearing
 * argument is resolved against the step's destination (the workspace inside the worktree), an absolute path inside the
 * original repository is moved to the same place in the worktree, and anything that resolves outside the worktree
 * refuses the repository. Each path is rewritten as its absolute destination, so the preview shows where a step acts.
 * Symbolic links are judged when the batch runs (batch-run.ts), once the files exist. Pure: no filesystem, no git.
 */
import { basename, dirname, isAbsolute, join, posix, relative, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OptionSpec } from '../args.js';
import { COMMANDS } from '../commands.js';
import { installsDependencies } from '../package-manager.js';
import { displayFix } from '../fix.js';
import type { Offer, Step } from './offers.js';
import type { RepoRow } from './workspaces-state.js';

export interface BatchChoice {
  readonly offerId: string;
  readonly title: string;
  readonly repos: number;
}
/** An offer that fires and can be batched: it answers a check, writes the repository, needs no input and is enabled. */
export const fires = (offer: Offer): boolean =>
  offer.batchable &&
  offer.group !== 'more' &&
  offer.input === undefined &&
  offer.disabled === undefined &&
  offer.view === undefined;

/** The batchable offers that fire on the selected rows, in the order first found, each with its repository count. */
export function batchChoices(rows: readonly RepoRow[], selected: ReadonlySet<number>): readonly BatchChoice[] {
  const choices = new Map<string, { title: string; repos: number }>();
  rows.forEach((row, index) => {
    if (!selected.has(index)) return;
    for (const offer of row.offers.filter(fires)) {
      const seen = choices.get(offer.id);
      if (seen === undefined) choices.set(offer.id, { title: offer.title, repos: 1 });
      else seen.repos += 1;
    }
  });
  return [...choices].map(([offerId, { title, repos }]) => ({ offerId, title, repos }));
}
/** The rows where a batchable offer fires. */
export function selectNeeding(rows: readonly RepoRow[]): ReadonlySet<number> {
  return new Set(rows.flatMap((row, index) => (row.offers.some(fires) ? [index] : [])));
}

/**
 * The manager whose own install or pin is the offer's first step (doctor's `cli-version` remedy, the upgrade recipe),
 * or null. The batch's frozen install is then left out: on the lockfile drift those steps exist to repair, a frozen
 * install would fail first. The preview reads it as the run does (batch-run.ts), the run then holding it to the
 * manager the base declares or locks.
 */
export const installsFirst = (steps: readonly Step[]): string | null => {
  const first = steps[0];
  return first?.program === 'external' && installsDependencies(first.argv) ? first.argv[0] : null;
};

/** `chore/<slug>`: `ia-<version>` for the upgrade, with dots as dashes; otherwise the offer id, prefixed `ia-` once. */
export function branchFor(offer: Offer): string {
  const slug = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  if (offer.id === 'upgrade') {
    const pinned = offer.steps.flatMap((step) => step.argv).find((token) => token.startsWith('@inventarch/cli@'));
    if (pinned !== undefined) return `chore/ia-${slug(pinned.slice('@inventarch/cli@'.length))}`;
  }
  const id = slug(offer.id);
  return `chore/${id.startsWith('ia-') ? id : `ia-${id}`}`;
}

export interface RepoPlan {
  /** The tracked root. */
  readonly root: string;
  /** The repository's top level, or the root when it is in none (then `refused` says so). */
  readonly top: string;
  readonly worktree: string;
  /** The workspace inside the worktree: `<worktree>/<root relative to top>`; every step runs here. */
  readonly workspace: string;
  readonly branch: string;
  /** The steps rebuilt for the worktree. */
  readonly steps: readonly Step[];
  /** The user and machine steps left out of this repository's run, as the offer had them. */
  readonly deferred: readonly Step[];
  readonly refused: string | null;
  /** The IA home, which the worktree must not lead into once links are followed (batch-run.ts checks it). */
  readonly iaHome?: string;
}
export interface BatchConfig {
  /** `worktreeRoot` from the IA home's config.json; an absolute directory outside the IA home. */
  readonly worktreeRoot?: string;
  readonly iaHome: string;
}

type PathApi = typeof posix;
const api = (platform: NodeJS.Platform): PathApi => (platform === 'win32' ? win32 : posix);
/** `child` is `parent` or inside it, lexically; Windows compares without case and reads both separators alike. */
function inside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = api(platform);
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/** The worktree for one repository, or why none may be made there. */
function worktreeFor(top: string, branch: string, config: BatchConfig): { path: string } | { refused: string } {
  const slug = branch.replace(/^chore\//, '');
  const root = config.worktreeRoot;
  if (root !== undefined && !isAbsolute(root))
    return { refused: `the configured worktreeRoot must be an absolute path: ${root}` };
  if (root !== undefined && inside(config.iaHome, root))
    return { refused: `the configured worktreeRoot ${root} is inside the IA home` };
  const path = join(root ?? join(dirname(top), '.ia-worktrees'), `${basename(top)}-${slug}`);
  if (inside(config.iaHome, path)) return { refused: `the worktree path ${path} is inside the IA home` };
  if (inside(top, path)) return { refused: `the worktree path ${path} is inside the repository ${top}` };
  return { path };
}

/**
 * One batch: every selected row that offers `offerId`, in table order. A row whose root is in no git repository, or
 * whose worktree may not be made, or one of whose steps names a path outside its worktree, is refused, never skipped.
 */
export function planBatch(
  offerId: string,
  rows: readonly RepoRow[],
  selected: ReadonlySet<number>,
  config: BatchConfig,
  /** The top level holding a root; null when it is in none; a refusal when its probe may not run. */
  git: { readonly top: (root: string) => string | null | { readonly refused: string } },
): { readonly repos: readonly RepoPlan[]; readonly deferred: readonly Step[] } {
  const repos: RepoPlan[] = [];
  const deferred = new Map<string, Step>();
  rows.forEach((row, index) => {
    if (!selected.has(index)) return;
    const offer = row.offers.find((entry) => entry.id === offerId && fires(entry));
    if (offer === undefined) return;
    const root = row.tracked.root;
    const branch = branchFor(offer);
    const left = offer.steps.filter((step) => step.writesTo === 'user' || step.writesTo === 'machine');
    for (const step of left) if (!deferred.has(displayFix(step))) deferred.set(displayFix(step), step);
    const kept = offer.steps.filter((step) => !left.includes(step));
    const refuse = (why: string, top = root, worktree = '', workspace = ''): void => {
      repos.push({
        root,
        top,
        worktree,
        workspace,
        branch,
        steps: kept,
        deferred: left,
        refused: why,
        iaHome: config.iaHome,
      });
    };
    const found = git.top(root);
    if (found === null) return refuse(`${root} is not inside a git repository`);
    if (typeof found !== 'string') return refuse(found.refused);
    const top = found;
    const made = worktreeFor(top, branch, config);
    if ('refused' in made) return refuse(made.refused, top);
    const workspace = join(made.path, relative(top, root));
    const steps: Step[] = [];
    for (const step of kept) {
      const rebased = rebaseStep(step, { from: top, to: made.path, cwd: workspace });
      if ('refused' in rebased) return refuse(rebased.refused, top, made.path, workspace);
      steps.push(rebased.step);
    }
    repos.push({
      root,
      top,
      worktree: made.path,
      workspace,
      branch,
      steps,
      deferred: left,
      refused: null,
      iaHome: config.iaHome,
    });
  });
  return { repos, deferred: [...deferred.values()] };
}

export type PathKind = 'path' | 'file-url' | 'name';
export interface PathArgument {
  /** The argv index of the token that holds the value. */
  readonly index: number;
  readonly value: string;
  /** `separate`: the token is the value; `inline`: the token is `--name=value`. */
  readonly form: 'separate' | 'inline';
  /** `path` and `file-url` are rebuilt; `name`, a mixed-domain value not spelled as a path, is kept as written. */
  readonly kind: PathKind;
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;
const FILE_URL = /^file:/i;
/** A POSIX root, a drive path or a UNC path, whichever platform reads it. */
const ABSOLUTE = /^(?:\/|\\\\|[A-Za-z]:)/;
const hasParent = (value: string): boolean => value.split(/[\\/]/).includes('..');
const spelledAsPath = (value: string): boolean =>
  ABSOLUTE.test(value) || value === '.' || value === '..' || /^\.\.?[\\/]/.test(value);
/** How a value is read: `null` when it is not a path (a URL with another scheme, or an unmarked plain token). */
function kindOf(value: string, mark: OptionSpec['path'] | 'generic'): PathKind | null {
  if (mark === 'always') return 'path';
  if (FILE_URL.test(value)) return 'file-url';
  if (SCHEME.test(value) && !ABSOLUTE.test(value)) return null;
  if (mark === 'maybe') return spelledAsPath(value) ? 'path' : 'name';
  return ABSOLUTE.test(value) || hasParent(value) ? 'path' : null;
}
/** The package managers' own directory options. */
const MANAGER_PATHS: ReadonlySet<string> = new Set(['--prefix', '--dir', '--cwd', '-C']);

/**
 * The path-bearing tokens of a step. For `ia`, the values of the options its grammar marks `path` and the positionals
 * it marks; for an external package manager, `--prefix`, `--dir` and `--cwd`. Any other token that is an absolute path
 * or holds a `..` segment, or is a `file:` URL, is path-bearing too, so no unmarked path passes unexamined; a URL with
 * another scheme never is.
 */
export function pathArguments(step: Step): readonly PathArgument[] {
  const argv = step.argv;
  const out: PathArgument[] = [];
  const spec = step.program === 'ia' ? COMMANDS.find((command) => command.name === argv[0]) : undefined;
  const optionOf = (key: string): OptionSpec | undefined => {
    if (step.program !== 'ia')
      return MANAGER_PATHS.has(key) ? { name: key, kind: 'value', path: 'always', summary: '' } : undefined;
    return spec?.grammar.options.find((entry) => `--${entry.name}` === key || `-${entry.short}` === key);
  };
  const add = (index: number, value: string, form: PathArgument['form'], mark: OptionSpec['path'] | 'generic') => {
    const kind = kindOf(value, mark);
    if (kind !== null) out.push({ index, value, form, kind });
  };
  let separated = false,
    positional = 0;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!separated && token === '--') {
      separated = true;
      continue;
    }
    if (!separated && token.startsWith('-') && token !== '-') {
      const split = token.indexOf('=');
      const option = optionOf(split === -1 ? token : token.slice(0, split));
      if (option !== undefined && option.kind === 'value') {
        if (split !== -1) add(index, token.slice(split + 1), 'inline', option.path ?? 'generic');
        else if (index + 1 < argv.length) {
          add(index + 1, argv[index + 1]!, 'separate', option.path ?? 'generic');
          index += 1;
        }
      } else if (split !== -1) add(index, token.slice(split + 1), 'inline', 'generic');
      continue;
    }
    const from = spec?.grammar.positionals.path?.from;
    add(index, token, 'separate', from !== undefined && positional >= from ? 'always' : 'generic');
    positional += 1;
  }
  return out;
}

/**
 * The step rebuilt for its worktree: every path-bearing value resolved against `cwd` (the destination), a path inside
 * `from` (the original top level) moved to the same place under `to` (the worktree), and the token rewritten as that
 * absolute path (a `file:` URL as a native directory path, the one local form every reader takes). A value that
 * resolves outside `to`, or a result that still names a path inside `from`, refuses the repository. Lexical only.
 */
export function rebaseStep(
  step: Step,
  map: { readonly from: string; readonly to: string; readonly cwd: string },
  platform: NodeJS.Platform = process.platform,
): { readonly step: Step } | { readonly refused: string } {
  const path = api(platform);
  const outside = (value: string) => ({ refused: `step names a path outside the worktree: ${value}` });
  const argv = [...step.argv];
  for (const entry of pathArguments(step)) {
    if (entry.kind === 'name') continue;
    let value = entry.value;
    if (entry.kind === 'file-url')
      try {
        value = fileURLToPath(value, { windows: platform === 'win32' });
      } catch {
        return outside(entry.value);
      }
    let target = path.resolve(map.cwd, value);
    if (inside(map.from, target, platform) && !inside(map.to, target, platform))
      target = path.join(map.to, path.relative(path.resolve(map.from), target));
    if (!inside(map.to, target, platform)) return outside(entry.value);
    const token = argv[entry.index]!;
    argv[entry.index] = entry.form === 'inline' ? `${token.slice(0, token.indexOf('=') + 1)}${target}` : target;
  }
  const rebuilt: Step = { ...step, argv };
  // Checked once more on the result: nothing names the original, and every path-bearing value is in the worktree.
  for (const token of argv) {
    const values = [token, ...(token.includes('=') ? [token.slice(token.indexOf('=') + 1)] : [])];
    for (const value of values)
      if (ABSOLUTE.test(value) && inside(map.from, value, platform) && !inside(map.to, value, platform))
        return { refused: `step still names the original checkout: ${value}` };
  }
  for (const entry of pathArguments(rebuilt))
    if (entry.kind !== 'name' && !inside(map.to, path.resolve(map.cwd, entry.value), platform))
      return outside(entry.value);
  return { step: rebuilt };
}
