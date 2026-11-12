// Runs each probe command once per run on a fresh copy of a tree, and records its normalised output's digest and
// its time and memory. Usage:
//   node tools/scale-probe/capture.mjs --cli <bin.js> --label <label> --tree <dir> [--name <name>] [--runs <n>]
//     [--commands <a,b>] [--keep <dir>] [--no-measure] --out <file>
import '../temp/physical-temp.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalise } from './normalise.mjs';

const MEASURE = fileURLToPath(new URL('./measure.mjs', import.meta.url));
export const FORMAT = 'ia.scale-probe.capture.v1';

/**
 * The probe's commands. `files` are outputs the command writes, digested after normalisation; `needs` names what
 * the tree must have for the command to run.
 */
export const COMMANDS = {
  validate: { args: () => ['validate', '--json'] },
  'capture-preview': { args: () => ['capture', '--preview', '--json'] },
  capture: { args: () => ['capture', '--json'], files: ['.ia/work/snapshot/current.json'] },
  inspect: { args: () => ['inspect', '--json'] },
  records: { args: () => ['records'] },
  'format-check': { args: () => ['format', '--check', '--json'] },
  'kb-check': { args: () => ['kb', 'check', '--json'] },
  'kb-pack': {
    needs: 'commit',
    args: (tree, copy) => [
      'kb',
      'pack',
      '--commit',
      tree.commit,
      '--selection',
      'selection.json',
      '--out',
      join(copy, 'probe-pack.json'),
      '--apply',
      '--yes',
      '--json',
    ],
    files: ['probe-pack.json'],
  },
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
/** The digest and size of an output: normalised JSON when it parses, otherwise its text with the root folded. */
function digestOf(command, text, root) {
  const json = parse(text.trim());
  const body =
    json === undefined ? String(normalise(command, text, root)) : JSON.stringify(normalise(command, json, root));
  return {
    digest: sha256(body),
    bytes: Buffer.byteLength(body),
    json: json === undefined ? undefined : normalise(command, json, root),
  };
}
/** The few fields of an envelope worth reading in a report. */
function summary(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const out = {};
  for (const key of [
    'ok',
    'code',
    'status',
    'reportOutcome',
    'revision',
    'authoredRevision',
    'digest',
    'counts',
    'records',
    'exit',
  ])
    if (key in json && (typeof json[key] !== 'object' || key === 'counts')) out[key] = json[key];
  if (Array.isArray(json.records)) out.records = json.records.length;
  return out;
}

/**
 * Runs one command on a fresh copy of the tree.
 * @returns {{ exit: number | null, digest: string, bytes: number, summary: unknown, files: Record<string, string>, measure: unknown, kept?: unknown }}
 */
function runOnce({ cli, tree, name, work, measure }) {
  const parent = mkdtempSync(join(work, `${name}-`));
  const copy = join(parent, 'tree');
  try {
    cpSync(tree.root, copy, { recursive: true });
    const args = [...COMMANDS[name].args(tree, copy), '--root', copy];
    const run = spawnSync(process.execPath, ['--max-old-space-size=8192', MEASURE, ...args], {
      cwd: copy,
      env: { ...process.env, IA_PROBE_CLI: resolve(cli), NO_COLOR: '1' },
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      windowsHide: true,
    });
    const probe = (run.stderr ?? '').match(/^@@PROBE (\{.*\})$/m);
    const out = digestOf(name, run.stdout ?? '', copy);
    const files = {};
    for (const file of COMMANDS[name].files ?? []) {
      const path = join(copy, file);
      files[file] = existsSync(path) ? digestOf(name, readFileSync(path, 'utf8'), copy).digest : null;
    }
    return {
      exit: run.status,
      digest: out.digest,
      bytes: out.bytes,
      summary: summary(out.json),
      files,
      measure: measure && probe ? JSON.parse(probe[1]) : null,
      kept: out.json,
    };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

/**
 * Captures every applicable command on one tree.
 * @param {{ cli: string, label: string, root: string, name?: string, recipe?: unknown, runs?: number,
 *   commands?: string[], keep?: string, measure?: boolean, work?: string }} options
 */
export function capture({
  cli,
  label,
  root,
  name,
  recipe = null,
  runs = 1,
  commands = Object.keys(COMMANDS),
  keep,
  measure = true,
  work,
}) {
  const tree = { root: resolve(root), commit: null };
  if (existsSync(join(tree.root, '.git')))
    tree.commit = execFileSync('git', ['-C', tree.root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const scratch = work ?? mkdtempSync(join(tmpdir(), 'ia-scale-probe-'));
  const outputs = {},
    measurements = {},
    skipped = [];
  try {
    for (const command of commands) {
      if (!COMMANDS[command]) throw new Error(`unknown command ${command}`);
      if (COMMANDS[command].needs === 'commit' && !tree.commit) {
        skipped.push(command);
        continue;
      }
      const results = [];
      for (let i = 0; i < runs; i++) results.push(runOnce({ cli, tree, name: command, work: scratch, measure }));
      const [first] = results;
      const stable = results.every(
        (r) =>
          r.exit === first.exit && r.digest === first.digest && JSON.stringify(r.files) === JSON.stringify(first.files),
      );
      outputs[command] = {
        exit: first.exit,
        digest: first.digest,
        bytes: first.bytes,
        summary: first.summary,
        files: first.files,
        stable,
      };
      if (measure) measurements[command] = results.map((r) => r.measure);
      if (keep) {
        mkdirSync(keep, { recursive: true });
        writeFileSync(join(keep, `${command}.json`), `${JSON.stringify(first.kept ?? null, null, 2)}\n`);
      }
    }
  } finally {
    if (!work) rmSync(scratch, { recursive: true, force: true });
  }
  return {
    format: FORMAT,
    label,
    platform: process.platform,
    node: process.version,
    tree: { name: name ?? null, recipe, commit: tree.commit },
    outputs,
    skipped,
    ...(measure ? { measurements } : {}),
  };
}

function main(argv) {
  const o = { runs: 1, measure: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cli') o.cli = argv[++i];
    else if (arg === '--label') o.label = argv[++i];
    else if (arg === '--tree') o.root = argv[++i];
    else if (arg === '--name') o.name = argv[++i];
    else if (arg === '--runs') o.runs = Number(argv[++i]);
    else if (arg === '--commands') o.commands = argv[++i].split(',');
    else if (arg === '--keep') o.keep = argv[++i];
    else if (arg === '--no-measure') o.measure = false;
    else if (arg === '--out') o.out = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!o.cli || !o.label || !o.root || !o.out || !(o.runs >= 1))
    throw new Error(
      'usage: capture.mjs --cli <bin.js> --label <label> --tree <dir> [--runs <n>] [--commands <a,b>] [--keep <dir>] [--no-measure] --out <file>',
    );
  const result = capture(o);
  mkdirSync(dirname(resolve(o.out)), { recursive: true });
  writeFileSync(o.out, `${JSON.stringify(result, null, 2)}\n`);
  const unstable = Object.entries(result.outputs)
    .filter(([, v]) => !v.stable)
    .map(([k]) => k);
  process.stdout.write(
    `${JSON.stringify({ out: o.out, commands: Object.keys(result.outputs).length, skipped: result.skipped, unstable })}\n`,
  );
  if (unstable.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
