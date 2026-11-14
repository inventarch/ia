// Runs each probe command once per run on a fresh copy of a tree, and records its normalised output's digest and
// its time and memory. Usage:
//   node tools/scale-probe/capture.mjs --cli <bin.js> --label <label> --tree <dir> [--name <name>] [--runs <n>]
//     [--commands <a,b>] [--keep <dir>] [--no-measure] --out <file>
import '../temp/physical-temp.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitEnvironment } from './generate.mjs';
import { normalise } from './normalise.mjs';

const MEASURE = fileURLToPath(new URL('./measure.mjs', import.meta.url));
export const FORMAT = 'ia.scale-probe.capture.v1';

/**
 * The probe's commands. `needs` names what the tree must have for the command to run. Every file a command adds,
 * changes or removes in its copy is digested after it runs, whatever the command.
 */
export const COMMANDS = {
  validate: { args: () => ['validate', '--json'] },
  'capture-preview': { args: () => ['capture', '--preview', '--json'] },
  capture: { args: () => ['capture', '--json'] },
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

/** The digest of a symbolic link: `link:` and the SHA-256 of its target text, which no file's digest can equal. */
const LINK = 'link:';

/**
 * Every file under a tree but its `.git` folder, as workspace-relative path to the SHA-256 of its bytes. A symbolic
 * link is digested by its target text and never followed, so a link to a folder is not walked.
 */
export function treeFiles(root) {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!prefix && entry.name === '.git') continue;
      const path = join(dir, entry.name),
        rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isSymbolicLink()) files.set(rel, `${LINK}${sha256(readlinkSync(path, { encoding: 'buffer' }))}`);
      else files.set(rel, sha256(readFileSync(path)));
    }
  };
  walk(root, '');
  return files;
}

/**
 * The files a run added, changed or removed, as path to the digest of the normalised content (`removed` for a
 * file that is gone). Binary content is digested as it is, and a symbolic link by its target text.
 */
function written(command, copy, before) {
  const after = treeFiles(copy),
    out = {};
  for (const [path, hash] of after) {
    if (before.get(path) === hash) continue;
    if (hash.startsWith(LINK)) {
      out[path] = hash;
      continue;
    }
    const bytes = readFileSync(join(copy, path));
    out[path] = bytes.includes(0) ? sha256(bytes) : digestOf(command, bytes.toString('utf8'), copy).digest;
  }
  for (const path of before.keys()) if (!after.has(path)) out[path] = 'removed';
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Runs one command on a fresh copy of the tree. A run that cannot start, overflows its buffer or is killed throws:
 * it has no output to compare.
 * @returns {{ exit: number, digest: string, bytes: number, stderr: string, summary: unknown, files: Record<string, string>, measure: unknown, kept?: unknown }}
 */
function runOnce({ cli, tree, name, work, measure }) {
  // At its real path: IA reports the root it runs on by its real path, and the normaliser folds only the spelling
  // it is given. A `work` reached through a link, as /tmp is on macOS, would leave the copy's random name in outputs.
  const parent = realpathSync.native(mkdtempSync(join(work, `${name}-`)));
  const copy = join(parent, 'tree');
  try {
    // A link is copied as it is: resolved, a relative link would point back into the tree, and a write through it
    // would change the tree every later run copies.
    cpSync(tree.root, copy, { recursive: true, verbatimSymlinks: true });
    const args = [...COMMANDS[name].args(tree, copy), '--root', copy];
    const run = spawnSync(process.execPath, ['--max-old-space-size=8192', MEASURE, ...args], {
      cwd: copy,
      env: { ...process.env, IA_PROBE_CLI: resolve(cli), NO_COLOR: '1' },
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      windowsHide: true,
    });
    if (run.error || run.status === null)
      throw new Error(`${name} did not finish: ${run.error?.message ?? `signal ${run.signal}`}`);
    const probe = (run.stderr ?? '').match(/^@@PROBE (\{.*\})$/m);
    const out = digestOf(name, run.stdout ?? '', copy);
    const stderr = String(normalise(name, (run.stderr ?? '').replace(/^\n?@@PROBE \{.*\}\n?$/m, ''), copy));
    return {
      exit: run.status,
      digest: out.digest,
      bytes: out.bytes,
      stderr: sha256(stderr),
      summary: summary(out.json),
      files: written(name, copy, tree.files),
      measure: measure && probe ? JSON.parse(probe[1]) : null,
      kept: out.json,
    };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

/**
 * Captures every applicable command on one tree under each CLI. Within each command the runs alternate between
 * the CLIs (A, B, A, B, ...), so a burst of load on the machine falls on both sides rather than on one side's runs.
 * @param {{ clis: { bin: string, label: string }[], root: string, name?: string, recipe?: unknown, runs?: number,
 *   commands?: string[], keep?: string, measure?: boolean, work?: string }} options
 * @returns {Record<string, object>} one capture per CLI label
 */
export function captureAll({
  clis,
  root,
  name,
  recipe = null,
  runs = 1,
  commands = Object.keys(COMMANDS),
  keep,
  measure = true,
  work,
}) {
  // The real path: a copy of a link to the tree would be a link to it, and a run would write into the tree.
  const tree = { root: realpathSync.native(resolve(root)), commit: null };
  if (existsSync(join(tree.root, '.git')))
    tree.commit = execFileSync('git', ['-C', tree.root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: gitEnvironment(),
      windowsHide: true,
    }).trim();
  tree.files = treeFiles(tree.root);
  const scratch = work ?? mkdtempSync(join(tmpdir(), 'ia-scale-probe-'));
  const captures = Object.fromEntries(
    clis.map(({ label }) => [
      label,
      {
        format: FORMAT,
        label,
        platform: process.platform,
        node: process.version,
        tree: { name: name ?? null, recipe, commit: tree.commit },
        outputs: {},
        skipped: [],
        ...(measure ? { measurements: {} } : {}),
      },
    ]),
  );
  try {
    for (const command of commands) {
      if (!COMMANDS[command]) throw new Error(`unknown command ${command}`);
      if (COMMANDS[command].needs === 'commit' && !tree.commit) {
        for (const c of Object.values(captures)) c.skipped.push(command);
        continue;
      }
      const results = Object.fromEntries(clis.map(({ label }) => [label, []]));
      for (let i = 0; i < runs; i++)
        for (const { bin, label } of clis)
          results[label].push(runOnce({ cli: bin, tree, name: command, work: scratch, measure }));
      for (const { label } of clis) {
        const [first] = results[label];
        const stable = results[label].every(
          (r) =>
            r.exit === first.exit &&
            r.digest === first.digest &&
            r.stderr === first.stderr &&
            JSON.stringify(r.files) === JSON.stringify(first.files),
        );
        captures[label].outputs[command] = {
          exit: first.exit,
          digest: first.digest,
          bytes: first.bytes,
          stderr: first.stderr,
          summary: first.summary,
          files: first.files,
          stable,
        };
        if (measure) captures[label].measurements[command] = results[label].map((r) => r.measure);
        if (keep) {
          const dir = clis.length > 1 ? join(keep, label) : keep;
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${command}.json`), `${JSON.stringify(first.kept ?? null, null, 2)}\n`);
        }
      }
    }
  } finally {
    if (!work) rmSync(scratch, { recursive: true, force: true });
  }
  return captures;
}

/**
 * Captures every applicable command on one tree under one CLI.
 * @param {{ cli: string, label: string, root: string, name?: string, recipe?: unknown, runs?: number,
 *   commands?: string[], keep?: string, measure?: boolean, work?: string }} options
 */
export function capture({ cli, label, ...options }) {
  return captureAll({ clis: [{ bin: cli, label }], ...options })[label];
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
      'usage: capture.mjs --cli <bin.js> --label <label> --tree <dir> [--name <name>] [--runs <n>] [--commands <a,b>] [--keep <dir>] [--no-measure] --out <file>',
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
