/**
 * A batch in the normal screen (consumer CLI contract §1.2): the preview printed in full (each repository's worktree,
 * branch, install and rebuilt commands, and the steps left for afterwards), one confirmation, the per-repository progress, the
 * results table, then the "next" list, each choice explicit and run when picked. Everything printed goes through
 * `shownArgument`, so a path or a program's output never reaches the terminal as a control sequence.
 */
import { consents } from '../consumer.js';
import { displayFix } from '../fix.js';
import type { LocalCli } from '../local-cli.js';
import type { Env } from '../program.js';
import { NOT_COMMITTED, commitPassed, ghReady, nextChoices, pushAndOpenPrs, removeWorktrees } from './batch-next.js';
import type { RepoResult, Runner } from './batch-run.js';
import { runBatch } from './batch-run.js';
import { BATCH_BASE, installLine } from './batch-plan.js';
import type { BatchPreview } from './layout-all.js';
import type { Step } from './offers.js';
import { shownArgument } from './run.js';
import type { ConsoleState } from './state.js';

export interface BatchScreenIO {
  readonly print: (text: string) => void;
  /** One line typed in the normal screen; null when cancelled. */
  readonly line: (question: string) => Promise<string | null>;
  readonly run: Runner;
  readonly resolveRepo: (root: string) => LocalCli | null;
  readonly env: Env;
  /** The run's signal, which Ctrl-C aborts. */
  readonly signal: AbortSignal;
  /** A fresh signal for one choice after the run, which Ctrl-C aborts; by default the run's own. */
  readonly nextSignal?: () => AbortSignal;
}
/** What the console does once the batch screen ends. */
export type BatchOutcome =
  | { readonly next: 'return' }
  | { readonly next: 'open'; readonly root: string }
  | { readonly next: 'deferred'; readonly steps: readonly Step[] };

const shown = (text: string): string => shownArgument(text);

/** Why the base matters: the offers were read from the local checkout, which the worktree does not start from. */
export const BASE_NOTE =
  'The offers were read from each local checkout, but each worktree starts from that base: a change the checkout has and the base lacks is not in it, and a repository whose workspace the base does not hold is refused.';
/** How the batch's install runs (package-manager.ts `batchInstallArgv`), said once under the repositories. */
export const INSTALL_NOTE =
  'The install runs no lifecycle script and, for pnpm, no pnpmfile hook (Yarn 2 and later yarnPath and plugins, and .npmrc settings, still apply) and, where git tracks the lockfile, is frozen to it: npm ci --ignore-scripts, pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile, yarn install --frozen-lockfile --ignore-scripts (Yarn 2 and later: --immutable --mode=skip-build) or bun install --frozen-lockfile --ignore-scripts. A step listed under it may still run scripts: a package-manager step such as npm install -D runs as shown. A commit afterwards holds what it and the steps write.';

/** The preview as the confirmation shows it: nothing cut, the install included, since its output is committed too. */
export function previewLines(preview: BatchPreview): readonly string[] {
  const out = [`Batch: ${shown(preview.choice.title)}, each repository in a new worktree on a new branch.`];
  for (const plan of preview.repos) {
    out.push('', shown(plan.root));
    if (plan.refused !== null) {
      out.push(`  refused: ${shown(plan.refused)}`);
      continue;
    }
    out.push(
      `  worktree ${shown(plan.worktree)}`,
      `  branch   ${shown(plan.branch)}`,
      `  base     ${BATCH_BASE}`,
      `  install  ${installLine(plan.steps)}`,
    );
    plan.steps.forEach((step, index) => out.push(`  ${index + 1}. ${shown(displayFix(step))}`));
  }
  if (preview.repos.some((plan) => plan.refused === null)) out.push('', BASE_NOTE, INSTALL_NOTE);
  if (preview.deferred.length > 0) {
    out.push('', 'Left out of every repository, offered once afterwards:');
    for (const step of preview.deferred) out.push(`  ${shown(displayFix(step))}`);
  }
  out.push('', 'Nothing is pushed unless you choose to afterwards.');
  return out;
}

function table(results: readonly RepoResult[]): readonly string[] {
  return results.map(
    (result) =>
      `${result.ok ? 'ok    ' : result.stopped === true ? 'stopped' : result.refused !== null ? 'refused' : 'failed'} ${shown(result.branch)}  ${shown(result.worktree || result.root)}  ${result.base === undefined ? '' : `from ${shown(result.base)}  `}${shown(result.last)}`,
  );
}

export async function batchScreen(
  preview: BatchPreview,
  running: ConsoleState['running'],
  io: BatchScreenIO,
): Promise<BatchOutcome> {
  for (const text of previewLines(preview)) io.print(text);
  if (!consents(await io.line('Run this batch? [y/N] '))) {
    io.print('Declined; nothing ran.');
    return { next: 'return' };
  }
  const total = preview.repos.length;
  let results = await runBatch(
    preview,
    { running },
    {
      run: io.run,
      resolveRepo: io.resolveRepo,
      env: io.env,
      signal: io.signal,
      progress: (index, line) => io.print(`[${index + 1}/${total}] ${shown(line)}`),
    },
  );
  io.print('');
  for (const text of table(results)) io.print(text);
  const gh = await ghReady(
    io.run,
    io.env,
    preview.repos.map((repo) => repo.top),
  );
  const done = new Set<string>();
  const nextSignal = io.nextSignal ?? (() => io.signal);
  for (;;) {
    const choices = nextChoices(results, preview.deferred, gh).filter((choice) => !done.has(choice.id));
    if (choices.length === 0) return { next: 'return' };
    io.print('');
    io.print('Next:');
    choices.forEach((choice, index) => io.print(`  ${index + 1}. ${shown(choice.title)}`));
    const answer = (await io.line('Choose a number, or press enter to return: '))?.trim() ?? '';
    if (answer === '') return { next: 'return' };
    const choice = choices[Number(answer) - 1];
    if (!/^\d+$/.test(answer) || choice === undefined) {
      io.print(`No choice ${shown(answer)}.`);
      continue;
    }
    switch (choice.id) {
      case 'commit':
      case 'pr': {
        const signal = nextSignal();
        results = await commitPassed(results, preview.choice.title, io.run, io.env, signal);
        for (const text of table(results)) io.print(text);
        // A Ctrl-C that stopped a commit leaves it, and the pull requests that follow it, to choose again.
        if (!results.some((result) => result.last === NOT_COMMITTED)) done.add('commit');
        if (choice.id === 'pr') {
          for (const opened of await pushAndOpenPrs(results, io.run, io.env, signal))
            io.print(`${shown(opened.root)}: ${shown(opened.url ?? `not opened: ${opened.error ?? ''}`)}`);
          if (!signal.aborted) done.add('pr');
        }
        break;
      }
      case 'open': {
        const failed = results.find((result) => !result.ok && result.created);
        if (failed !== undefined) return { next: 'open', root: failed.workspace };
        break;
      }
      case 'remove': {
        const removed = await removeWorktrees(results, io.run, io.env, nextSignal());
        for (const entry of removed)
          io.print(
            `${shown(entry.root)}: ${entry.error === null ? 'worktree removed, branch kept' : shown(entry.error)}`,
          );
        const gone = new Set(removed.filter((entry) => entry.error === null).map((entry) => entry.root));
        results = results.map((result) =>
          gone.has(result.root) ? { ...result, ok: false, created: false, last: 'worktree removed' } : result,
        );
        break;
      }
      case 'deferred':
        return { next: 'deferred', steps: preview.deferred };
    }
  }
}
