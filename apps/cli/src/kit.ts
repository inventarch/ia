/**
 * `ia kit check [<folder>...]`: the one checker for kit folders (ia-kb design/kit-lifecycle dec-006).
 *
 * Each folder is a kit folder (it holds `releases.json` or `.ia/release.json`) or a folder of them; with none, the
 * current directory. Every kit named is checked in one run, so ids are unique across the folders and a private kit's
 * dependencies are held to the public kits named beside it. The rules and the two finding levels are
 * `@inventarch/runtime/method`'s `checkKits`: an integrity finding always fails; a spec finding fails a kit at 1.0.0 or
 * above and is reported for a kit on 0.x, which reaches 1.0.0 with the first release that has none (dec-004).
 *
 * Read-only, and it opens no workspace, so `--root` is refused. Exit 0 when no kit fails, 1 when one does, 3 when a
 * folder names no kit.
 */
import { isAbsolute, resolve } from 'node:path';
import { checkKits, kitFolders } from '@inventarch/runtime/method';
import type { KitReport } from '@inventarch/runtime/method';
import { UsageError } from './args.js';
import type { Context, Result } from './consumer.js';
import { Refusal } from './consumer.js';
import type { Capabilities } from './render.js';
import { document, entry, headerLine, words } from './render.js';

/** What this command does not check yet; printed so a pass is not read as more than it is. */
export const KIT_CHECK_NOT_CHECKED = [
  "the steward's name",
  'the paired authoring agents',
  'the kit-contract cases',
  'a runner for every contract and check record',
  'that every version a plugin names is published',
] as const;

export interface KitCheckEnvelope {
  readonly version: 1;
  readonly ok: boolean;
  readonly kits: readonly KitReport[];
  readonly notChecked: readonly string[];
}
export const kitCheckEnvelope = (kits: readonly KitReport[]): KitCheckEnvelope => ({
  version: 1,
  ok: kits.every((kit) => kit.ok),
  kits,
  notChecked: KIT_CHECK_NOT_CHECKED,
});

const verdict = (kit: KitReport): string =>
  !kit.ok
    ? 'fails'
    : kit.ready
      ? 'passes the spec: its next release may be 1.0.0'
      : kit.findings.length
        ? `passes; ${kit.findings.length} to settle before 1.0.0`
        : 'passes';

export function renderKitCheck(kits: readonly KitReport[], caps: Capabilities): string {
  const failed = kits.filter((kit) => !kit.ok).length;
  return document([
    ...kits.map((kit) => [
      ...headerLine(
        'Kit',
        `${kit.id ?? kit.folder} ${kit.version ?? ''}`.trim(),
        [{ text: kit.class ?? 'no class', column: 50 }],
        caps,
      ),
      ...entry(
        [words(verdict(kit))],
        { depth: 1, symbol: kit.ok ? (kit.findings.length ? 'warning' : 'success') : 'error' },
        caps,
      ),
      ...kit.findings.flatMap((finding) =>
        entry(
          [words(`${finding.rule}: ${finding.message}`)],
          { depth: 1, symbol: finding.fails ? 'error' : 'info' },
          caps,
        ),
      ),
    ]),
    entry(
      [
        words(
          `${kits.length} kit${kits.length === 1 ? '' : 's'} checked, ${failed} failing. Not checked: ${KIT_CHECK_NOT_CHECKED.join('; ')}.`,
        ),
      ],
      { depth: 0, symbol: failed ? 'error' : 'success' },
      caps,
    ),
  ]);
}

export function runKit(context: Context): Result {
  const { args, caps, json, host } = context;
  const [action, ...folders] = args.positionals;
  if (action !== 'check') throw new UsageError('Kit action must be check');
  const paths = (folders.length ? folders : ['.']).map((folder) =>
    isAbsolute(folder) ? resolve(folder) : resolve(host.cwd, folder),
  );
  for (const path of paths)
    if (kitFolders(path).length === 0)
      throw new Refusal(
        'IA-CLI-KIT-NOT-FOUND',
        `${path} is not a kit folder and none of its immediate subfolders is: a kit folder has a releases.json or a .ia/release.json`,
        3,
        { path },
        'Run "ia kit check <folder>" naming a kit folder or the folder that holds your kits.',
      );
  const kits = checkKits(paths);
  const exitCode = kits.every((kit) => kit.ok) ? 0 : 1;
  return json
    ? { exitCode, stdout: JSON.stringify(kitCheckEnvelope(kits)) + '\n', stderr: '' }
    : { exitCode, stdout: renderKitCheck(kits, caps), stderr: '' };
}
