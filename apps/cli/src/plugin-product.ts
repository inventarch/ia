/** `ia project <host> --product plugin`: renders a lowered workspace back into a plugin directory, create-only. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginFile, StandalonePluginHost } from '@inventarch/workspace-runtime/internal/generate';
import {
  comparePlugin,
  HostPluginError,
  inventoryOf,
  lowerPlugin,
  readEntries,
  RESOURCE_ROOT,
  ASSET_ROOT,
} from '@inventarch/workspace-runtime/internal/host-plugin';
import type { Context, Result } from './consumer.js';
import { confirm, Refusal, requireRoot } from './consumer.js';
import { renderPluginFor, renderPluginProductFor } from './host-projection.js';
import { checkPluginOut, writeFreshPlugin } from './plugin-sources.js';
import { quote } from './render.js';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface PluginView {
  out: string;
  files: { path: string; sha256: string }[];
}

const renderPluginPlan = (view: PluginView): string =>
  [`Would write ${view.files.length} files to ${view.out}:`, ...view.files.map((file) => `  ${file.path}`), ''].join(
    '\n',
  );

const REFUSED = new Set(['drift', 'missing', 'extra']);

/** Every regular file below `directory` (relative to `root`), as sorted POSIX paths; absent is empty. */
function filesBelow(root: string, directory: string): string[] {
  const base = resolve(root, directory);
  if (!existsSync(base)) return [];
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(resolve(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(directory);
  return found.sort();
}

/** Renders in memory, lowers the result again and proves content-exact plus fixed point; writes nothing. */
function checkPluginProduct(context: Context, root: string): Result {
  const { args, json } = context;
  const systemsRoot = resolve(root, '.ia/src/systems');
  const systems = existsSync(systemsRoot)
    ? readdirSync(systemsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  if (systems.length !== 1)
    throw new Refusal(
      'IA-PLUGIN-PRODUCT',
      `A lowered workspace holds one system under .ia/src/systems; found ${systems.length}`,
      1,
      { path: root },
      'Run "ia init --help" to lower the plugin into a kit workspace first.',
    );
  const system = systems[0]!;
  const files: readonly PluginFile[] = renderPluginFor(root);
  const given = args.value('compare');
  const compare = given === undefined ? undefined : resolve(context.host.cwd, given);
  if (compare !== undefined && statSync(compare, { throwIfNoEntry: false })?.isDirectory() !== true)
    throw new Refusal(
      'IA-PLUGIN-INPUT',
      `${compare} is not a plugin directory to compare with`,
      1,
      { path: compare },
      `Choose an existing plugin directory to compare with, then run "ia project ${args.positionals[0] ?? 'claude'} --product plugin --check --compare ${quote(compare)} --root ${quote(root)}".`,
    );
  const diffs = compare === undefined ? [] : comparePlugin(readEntries(compare), files);
  const drift = diffs.filter((d) => REFUSED.has(d.status));
  const again = lowerPlugin(inventoryOf(files.map((f) => ({ path: f.path, bytes: f.bytes }))), system);
  const lowered = new Map(again.files.map((f) => [f.path, f.bytes]));
  // Both directions: a lowered file the workspace lacks or holds differently, and a workspace file lowering does not write.
  const stray = [...filesBelow(root, RESOURCE_ROOT(system)), ...filesBelow(root, ASSET_ROOT)].filter(
    (path) => !lowered.has(path),
  );
  const fixedPoint = [
    ...[...lowered]
      .filter(([path, bytes]) => !existsSync(resolve(root, path)) || !readFileSync(resolve(root, path)).equals(bytes))
      .map(([path]) => path),
    ...stray,
  ].sort();
  const report = { compared: compare !== undefined, diffs, drift, fixedPoint, unresolved: again.unresolved };
  if (drift.length > 0 || fixedPoint.length > 0 || again.unresolved.length > 0) {
    const listed = (label: string, items: readonly string[]): string[] =>
      items.length === 0 ? [] : [`${label}: ${items.slice(0, 20).join('; ')}${items.length > 20 ? '; ...' : ''}.`];
    const message = [
      `${drift.length} drifted, ${fixedPoint.length} fixed-point mismatches, ${again.unresolved.length} unresolved.`,
      ...listed('Files', [
        ...drift.map((d) => `${d.path} (${d.status}${d.reason === null ? '' : `: ${d.reason}`})`),
        ...fixedPoint.map((path) => `${path} (fixed point)`),
      ]),
      ...listed('Unresolved', again.unresolved),
    ].join(' ');
    const rerun = `ia project ${args.positionals[0] ?? 'claude'} --product plugin --check${compare === undefined ? '' : ` --compare ${quote(compare)}`} --root ${quote(root)}`;
    throw new Refusal(
      'IA-ROUNDTRIP-DRIFT',
      message,
      1,
      { path: root },
      // With --json the full report is already the refusal's details.
      json
        ? `The full report is in details; correct each file it names, then run "${rerun}" again.`
        : `Run "${rerun} --json" for the full report.`,
      null,
      undefined,
      report,
    );
  }
  return { exitCode: 0, stdout: json ? `${JSON.stringify(report)}\n` : renderCheck(report), stderr: '' };
}

const renderCheck = (report: {
  compared: boolean;
  diffs: { path: string; status: string; rules: readonly string[]; reason: string | null }[];
}): string =>
  [
    report.compared
      ? 'Round trip: content-exact and a fixed point.'
      : 'Round trip: a fixed point (not compared with an original).',
    ...report.diffs
      .filter((d) => d.status !== 'identical')
      .map(
        (d) =>
          `  ${d.path}: ${d.status}${d.rules.length > 0 ? ` (${d.rules.join(', ')})` : ''}${d.reason === null ? '' : ` ${d.reason}`}`,
      ),
    '',
  ].join('\n');

const PLUGIN_HOSTS: ReadonlySet<string> = new Set<StandalonePluginHost>(['claude', 'codex', 'gemini', 'antigravity']);

/** The plugin form's usage, judged before the workspace is read: its host, and `--compare` only with `--check`. */
function pluginUsage(context: Context): StandalonePluginHost {
  const { args } = context;
  const given = args.value('root'),
    option = given === undefined ? '' : ` --root ${quote(given)}`;
  const host = args.positionals[0] ?? '';
  if (!PLUGIN_HOSTS.has(host))
    throw new Refusal(
      'IA-CLI-USAGE',
      `ia project --product plugin takes claude, codex, gemini or antigravity; got ${host}`,
      2,
      null,
      `Run "ia project claude --product plugin --check${option}" to check a lowered plugin.`,
    );
  if (args.flag('check') && host !== 'claude' && host !== 'codex')
    throw new Refusal(
      'IA-CLI-USAGE',
      `ia project --product plugin --check takes claude or codex; got ${host}`,
      2,
      null,
      `Run "ia project claude --product plugin --check${option}" to check a lowered plugin.`,
    );
  const compare = args.value('compare');
  if (compare !== undefined && !args.flag('check'))
    throw new Refusal(
      'IA-CLI-USAGE',
      '--compare needs --check: only the check compares the rendered plugin with an original',
      2,
      null,
      `Run "ia project ${host} --product plugin --check --compare ${quote(compare)}${option}" to compare without writing.`,
    );
  return host as StandalonePluginHost;
}

export async function runPluginProduct(context: Context): Promise<Result> {
  const { args, json } = context;
  const host = pluginUsage(context);
  const root = requireRoot(context);
  const next =
    host === 'claude' || host === 'codex'
      ? `Run "ia project ${host} --product plugin --check --root ${quote(root)}" to compare without writing.`
      : 'Run "ia project --help" for the options, and choose an absent or empty output directory outside the workspace.';
  try {
    if (args.flag('check')) return checkPluginProduct(context, root);
    const given = args.value('out');
    if (given === undefined)
      throw new Refusal('IA-CLI-USAGE', '--product plugin needs --out <directory> or --check', 2, null, next);
    const out = checkPluginOut(root, resolve(context.host.cwd, given));
    const files: readonly PluginFile[] = renderPluginProductFor(root, host);
    const view: PluginView = {
      out,
      files: files.map((file) => ({
        path: file.path,
        sha256: sha(file.bytes),
      })),
    };
    if (!args.flag('apply'))
      return {
        exitCode: 0,
        stdout: json ? `${JSON.stringify({ plan: view })}\n` : renderPluginPlan(view),
        stderr: '',
      };
    if (
      !args.flag('yes') &&
      !(await confirm(context.host.interaction, renderPluginPlan(view), 'Write this plugin? [y/N] '))
    )
      return { exitCode: 0, stdout: `Nothing was applied.${'\n'}`, stderr: '' };
    writeFreshPlugin(view.out, files);
    return {
      exitCode: 0,
      stdout: json ? `${JSON.stringify({ applied: view })}\n` : `Wrote ${files.length} files to ${view.out}.\n`,
      stderr: '',
    };
  } catch (error) {
    if (error instanceof HostPluginError) {
      // A rerun keeps the comparison the invocation asked for.
      const compared = args.value('compare');
      const compareOption = compared === undefined ? '' : ` --compare ${quote(resolve(context.host.cwd, compared))}`;
      const fix =
        error.code === 'IA-PLUGIN-OUT'
          ? 'Run "ia project --help" for the options, and choose an absent or empty output directory outside the workspace.'
          : error.code === 'IA-RESOURCE-DIGEST' || error.code === 'IA-PLUGIN-PRODUCT'
            ? 'Run "ia init --help" to lower the plugin again from its source, then project it.'
            : error.code === 'IA-PLUGIN-INPUT'
              ? `Remove the entry the message names, or replace the link it names with real files, then run "ia project ${args.positionals[0] ?? 'claude'} --product plugin --check${compareOption} --root ${quote(root)}".`
              : next;
      throw new Refusal(error.code, error.message, 1, { path: root }, fix);
    }
    throw error;
  }
}
