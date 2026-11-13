// Builds a synthetic IA workspace from public IA only: a fresh `ia init` workspace, then seeded work records.
// Usage: node tools/scale-probe/generate.mjs --cli <bin.js> --records <n> [--seed <n>] [--git] <out>
import '../temp/physical-temp.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The workspace name every generated tree carries, whatever its folder is called. */
export const WORKSPACE = 'synthetic';
/** Records in one group: one spec, one plan, three milestones of five tasks, then decisions. */
const GROUP = { specs: 1, plans: 1, milestones: 3, tasks: 15, decisions: 30 };
const GROUP_SIZE = Object.values(GROUP).reduce((a, b) => a + b, 0);
const PER_FILE = 15;
const GROUPS_PER_FOLDER = 5;
const WORDS =
  'admission boundary cadence catalogue citation closure contract digest edge evidence fixture graph handle identity index journal kernel lane ledger membership notice order owner packet phase posting probe queue record reference revision rule scope seat snapshot source stage steward store system token tray unit walk window'.split(
    ' ',
  );

/** mulberry32: a small seeded generator, so a seed always gives the same tree. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, width) => String(n).padStart(width, '0');

/**
 * The files of the synthetic records, as a map from workspace-relative path to text. Pure: the same size and
 * seed give the same map. Every reference points to a record written earlier, so admission never needs a later
 * file to resolve an earlier one.
 * @param {{ records: number, seed: number }} options
 * @returns {Record<string, string>}
 */
export function syntheticFiles({ records, seed }) {
  if (!Number.isInteger(records) || records < 1)
    throw new RangeError(`records must be a positive whole number: ${records}`);
  const next = random(seed);
  const pick = (n) => Math.floor(next() * n);
  const phrase = (min, max) => {
    const length = min + pick(max - min + 1);
    return Array.from({ length }, () => WORDS[pick(WORDS.length)]).join(' ');
  };
  const files = {};
  let left = records;
  for (let g = 0; left > 0; g++) {
    const id = pad(g, 6),
      folder = `.ia/src/${WORKSPACE}/b${pad(Math.floor(g / GROUPS_PER_FOLDER), 5)}`;
    const blocks = [];
    const add = (text) => {
      if (left > 0) {
        blocks.push(text);
        left--;
      }
    };
    const spec = `syn-spec-${id}`,
      plan = `syn-plan-${id}`,
      doc = `docs/${WORKSPACE}/${spec}.md`;
    add(
      `@spec ${spec}\n  meaning\n    says "Specification ${g}: ${phrase(4, 12)}."\n  work\n    title "Specification ${g}"\n    status draft\n    source "${doc}"\n`,
    );
    if (blocks.length) files[doc] = `# Specification ${g}\n\n${phrase(20, 60)}.\n`;
    add(
      `@plan ${plan}\n  meaning\n    says "Plan ${g}: ${phrase(4, 12)}."\n    answers "Which outcomes does plan ${g} establish?"\n  work\n    title "Plan ${g}"\n    status open\n    owner "Synthetic"\n`,
    );
    for (let m = 0; m < GROUP.milestones; m++) {
      const milestone = `syn-milestone-${id}-${m}`;
      add(
        `@milestone ${milestone}\n  meaning\n    says "Milestone ${g}.${m}: ${phrase(4, 10)}."\n  work\n    title "Milestone ${g}.${m}"\n    status open\n    plan @plan ${plan}\n    exit "${phrase(6, 14)}."\n`,
      );
      for (let t = 0; t < GROUP.tasks / GROUP.milestones; t++) {
        const before = t > 0 ? `\n  relationships\n    requires @task syn-task-${id}-${m}-${t - 1}\n` : '\n';
        add(
          `@task syn-task-${id}-${m}-${t}\n  meaning\n    says "Task ${g}.${m}.${t}: ${phrase(4, 10)}."\n  work\n    title "Task ${g}.${m}.${t}"\n    status open\n    milestone @milestone ${milestone}\n    owner "Synthetic"\n    action "${phrase(6, 16)}."${before}`,
        );
      }
    }
    for (let d = 0; d < GROUP.decisions; d++) {
      const options = Array.from({ length: 2 + pick(3) }, (_, i) => `"${String.fromCharCode(65 + i)}"`).join(', ');
      const earlier = d > 0 ? `\n    cites @decision syn-decision-${id}-${pad(pick(d), 2)}` : '';
      add(
        `@decision syn-decision-${id}-${pad(d, 2)}\n  meaning\n    says "Decision ${g}.${d}: ${phrase(4, 12)}?"\n    answers "Open."\n  work\n    title "Decision ${g}.${d}?"\n    status open\n    owner "Synthetic"\n  decision\n    question "${phrase(4, 10)}?"\n    options [${options}]\n  relationships\n    cites @spec ${spec}${earlier}\n`,
      );
    }
    for (let f = 0; f * PER_FILE < blocks.length; f++)
      files[`${folder}/g${id}-${f}.ia`] = `#! ia 1.0\n\n${blocks.slice(f * PER_FILE, (f + 1) * PER_FILE).join('\n')}`;
  }
  return files;
}

/**
 * The kb pack selection over the first group: every record in its files, since a pack refuses a file it selects
 * only in part, and the document its spec names.
 * @param {{ records: number }} options
 */
export function selection({ records }) {
  const files = syntheticFiles({ records: Math.min(records, GROUP_SIZE), seed: 0 });
  const identities = Object.values(files).flatMap((text) =>
    [...text.matchAll(/^@(\w+) ([\w-]+)$/gm)].map(
      ([, word, name]) => `work-system/${word === 'spec' ? 'contract' : 'definition'}/${word}/${name}`,
    ),
  );
  return {
    format: 'ia.kb.selection.v1',
    sourceId: WORKSPACE,
    records: identities.sort(),
    resources: [`docs/${WORKSPACE}/syn-spec-${pad(0, 6)}.md`],
  };
}

/** What `ia init` is given beside the folder: the workspace's identity, and no host. */
const INIT = ['--id', `local/${WORKSPACE}`, '--host', 'none'];

/** A fixed author and date, so the same files always give the same commit. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Scale probe',
  GIT_AUTHOR_EMAIL: 'probe@example.invalid',
  GIT_COMMITTER_NAME: 'Scale probe',
  GIT_COMMITTER_EMAIL: 'probe@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

/**
 * Variables that point git at another repository than the tree's. Git hands its hooks such variables, so a run
 * started from a hook would write into the hook's repository; they are dropped, and the rest of the environment kept.
 */
const ELSEWHERE = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
];

/**
 * What the generator gives a tree beside what `ia init` writes: the arguments it passes `ia init`, the synthetic
 * files and, with `git`, the text of the `kb pack` selection and the commit's message, author and date. Pure: the
 * same options give the same value. Tests pin this value, and the commit generate() makes from it around a stand-in
 * `ia init`, which also pins the file names, how it calls `ia init`, and the message it commits with.
 * @param {{ records: number, seed: number, git?: boolean }} options
 */
export function contents({ records, seed, git = false }) {
  return {
    init: INIT,
    files: syntheticFiles({ records, seed }),
    selection: git ? `${JSON.stringify(selection({ records }), null, 2)}\n` : null,
    commit: git ? { message: `Synthetic tree: ${records} records, seed ${seed}`, env: GIT_ENV } : null,
  };
}

/**
 * Initialises `out` with the given CLI, writes the synthetic files, and optionally commits them.
 * @param {{ cli: string, out: string, records: number, seed: number, git?: boolean }} options
 * @returns {{ out: string, files: number, commit: string | null }}
 */
export function generate({ cli, out, records, seed, git = false }) {
  const target = resolve(out);
  if (existsSync(target) && readdirSync(target).length > 0)
    throw new Error(`refusing a folder that is not empty: ${target}`);
  const content = contents({ records, seed, git });
  // The workspace is named after the folder ia init is given, so init runs in a folder named WORKSPACE.
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), `.${basename(target)}-`));
  try {
    const tree = join(stage, WORKSPACE);
    mkdirSync(tree);
    execFileSync(process.execPath, [resolve(cli), 'init', tree, ...content.init, '--apply', '--yes', '--json'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    for (const [path, text] of Object.entries(content.files)) {
      mkdirSync(dirname(join(tree, path)), { recursive: true });
      writeFileSync(join(tree, path), text);
    }
    if (content.selection !== null) writeFileSync(join(tree, 'selection.json'), content.selection);
    let commit = null;
    if (content.commit) {
      const env = { ...process.env, ...content.commit.env };
      for (const name of ELSEWHERE) delete env[name];
      const run = (...args) =>
        execFileSync(
          'git',
          [
            '-c',
            `core.hooksPath=${join(tree, '.git', 'no-hooks')}`,
            '-c',
            'commit.gpgsign=false',
            '-c',
            'core.autocrlf=false',
            // A global ignore file would change what is committed, and so the commit; so would a template (see init).
            '-c',
            `core.excludesFile=${join(tree, '.git', 'no-excludes')}`,
            '-C',
            tree,
            ...args,
          ],
          {
            encoding: 'utf8',
            env,
            windowsHide: true,
          },
        ).trim();
      // An empty --template uses no template, and outranks GIT_TEMPLATE_DIR and init.templateDir alike.
      run('init', '--quiet', '--initial-branch=main', '--template=');
      run('add', '--all');
      run('commit', '--quiet', '--no-verify', '-m', content.commit.message);
      commit = run('rev-parse', 'HEAD');
    }
    if (existsSync(target)) rmSync(target, { recursive: true });
    renameSync(tree, target);
    return { out: target, files: Object.keys(content.files).length, commit };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function main(argv) {
  const options = { seed: 1, git: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cli') options.cli = argv[++i];
    else if (arg === '--records') options.records = Number(argv[++i]);
    else if (arg === '--seed') options.seed = Number(argv[++i]);
    else if (arg === '--git') options.git = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  if (!options.cli || options.records === undefined || rest.length !== 1)
    throw new Error('usage: generate.mjs --cli <bin.js> --records <n> [--seed <n>] [--git] <out>');
  process.stdout.write(`${JSON.stringify(generate({ ...options, out: rest[0] }))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
