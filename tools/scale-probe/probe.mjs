// Builds each probe tree once and captures it under each CLI. Usage:
//   node tools/scale-probe/probe.mjs --init-cli <bin.js> --cli <label>=<bin.js> [--cli <label>=<bin.js>]...
//     [--trees <trees.json>] [--only <name,name>] [--synthetic <n,n>] [--runs <n>] [--no-measure] [--work <dir>] --out <dir>
// Writes <out>/<label>/<tree>.json for every CLI and tree. Run it from the repository root: git trees are archived
// from this repository's history.
import '../temp/physical-temp.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { capture } from './capture.mjs';
import { generate } from './generate.mjs';

const TREES = fileURLToPath(new URL('./trees.json', import.meta.url));

/** Builds one tree from its recipe under `work`, and returns its root. */
export function build(tree, { initCli, work, repository = process.cwd() }) {
  const root = join(work, tree.name);
  if (tree.kind === 'synthetic') {
    generate({ cli: initCli, out: root, records: tree.records, seed: tree.seed, git: true });
    return root;
  }
  if (tree.kind !== 'git') throw new Error(`unknown tree kind ${tree.kind}`);
  mkdirSync(root, { recursive: true });
  const prefix = tree.path === '.' ? '' : `${tree.path}/`;
  const paths = (tree.include ?? ['']).map((p) => `${prefix}${p}`.replace(/\/$/, '') || '.');
  const archive = execFileSync('git', ['-C', repository, 'archive', '--format=tar', tree.commit, ...paths], {
    maxBuffer: 1 << 30,
    windowsHide: true,
  });
  const strip = prefix ? prefix.split('/').filter(Boolean).length : 0;
  execFileSync('tar', ['-x', '-C', root, ...(strip ? [`--strip-components=${strip}`] : [])], {
    input: archive,
    windowsHide: true,
  });
  return root;
}

function main(argv) {
  const o = { clis: [], runs: 1, measure: true, trees: TREES, synthetic: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--init-cli') o.initCli = argv[++i];
    else if (arg === '--cli') {
      const [label, ...bin] = argv[++i].split('=');
      o.clis.push({ label, bin: bin.join('=') });
    } else if (arg === '--trees') o.trees = argv[++i];
    else if (arg === '--only') o.only = new Set(argv[++i].split(','));
    else if (arg === '--synthetic') o.synthetic = argv[++i].split(',').map(Number);
    else if (arg === '--runs') o.runs = Number(argv[++i]);
    else if (arg === '--no-measure') o.measure = false;
    else if (arg === '--work') o.work = argv[++i];
    else if (arg === '--out') o.out = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!o.initCli || !o.clis.length || o.clis.some((c) => !c.label || !c.bin) || !o.out || !(o.runs >= 1))
    throw new Error(
      'usage: probe.mjs --init-cli <bin.js> --cli <label>=<bin.js>... [--only <names>] [--synthetic <n,n>] [--runs <n>] --out <dir>',
    );
  const listed = JSON.parse(readFileSync(o.trees, 'utf8')).trees;
  const trees = [
    ...listed.filter((t) => !o.only || o.only.has(t.name)),
    ...o.synthetic.map((records) => ({ name: `synthetic-${records}`, kind: 'synthetic', records, seed: 1 })),
  ];
  const work = o.work ? resolve(o.work) : mkdtempSync(join(tmpdir(), 'ia-scale-probe-trees-'));
  mkdirSync(work, { recursive: true });
  try {
    for (const tree of trees) {
      const root = build(tree, { initCli: o.initCli, work });
      try {
        for (const cli of o.clis) {
          const { name, ...recipe } = tree;
          const result = capture({
            cli: cli.bin,
            label: cli.label,
            root,
            name,
            recipe,
            runs: o.runs,
            measure: o.measure,
          });
          const dir = join(o.out, cli.label);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
          const unstable = Object.entries(result.outputs)
            .filter(([, v]) => !v.stable)
            .map(([k]) => k);
          process.stdout.write(
            `${JSON.stringify({ tree: name, cli: cli.label, commands: Object.keys(result.outputs).length, skipped: result.skipped, unstable })}\n`,
          );
          if (unstable.length) process.exitCode = 1;
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    if (!o.work) rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
