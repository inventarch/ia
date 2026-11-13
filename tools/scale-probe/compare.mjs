// Compares two sets of captures, tree by tree and command by command: whether the normalised outputs are equal,
// and, when both carry measurements, the median wall time and peak memory before and after. Usage:
//   node tools/scale-probe/compare.mjs <before> <after> [--outputs-only] [--slower <ratio>] [--larger <ratio>] [--json <file>]
// <before> and <after> are capture files or folders of them, matched by file name. Exit 1 when an output differs,
// a command is missing, or (unless --outputs-only) a command is slower or larger past the given ratios.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Below these, a difference is noise whatever its ratio. */
const NOISE = { wallMs: 150, maxRssMB: 16 };

/** A capture file, or a folder of them. The path is read as a folder first, with no separate check beforehand. */
const load = (path) => {
  let files;
  try {
    files = readdirSync(path);
  } catch (error) {
    if (error?.code !== 'ENOTDIR') throw error;
    return new Map([[basename(path), JSON.parse(readFileSync(path, 'utf8'))]]);
  }
  return new Map(
    files
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => [f, JSON.parse(readFileSync(join(path, f), 'utf8'))]),
  );
};

const median = (values) => {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/** One row per tree and command. Refuses two empty sides: a comparison of nothing is no evidence. */
export function compare(before, after, { outputsOnly = false, slower = 1.1, larger = 1.1 } = {}) {
  if (before.size === 0 && after.size === 0) throw new Error('nothing to compare: neither side holds a capture');
  const rows = [];
  for (const [file, a] of before) {
    const b = after.get(file);
    const tree = a.tree?.name ?? file.replace(/\.json$/, '');
    // Two captures under one name must be of one tree, or their outputs say nothing about each other.
    const of = (c) => JSON.stringify({ recipe: c?.tree?.recipe ?? null, commit: c?.tree?.commit ?? null });
    if (b && of(a) !== of(b)) {
      rows.push({ tree, command: '*', outputs: 'tree differs' });
      continue;
    }
    const commands = new Set([...Object.keys(a.outputs), ...Object.keys(b?.outputs ?? {})]);
    for (const command of commands) {
      const x = a.outputs[command],
        y = b?.outputs?.[command];
      const same =
        x &&
        y &&
        x.exit === y.exit &&
        x.digest === y.digest &&
        x.stderr === y.stderr &&
        JSON.stringify(x.files) === JSON.stringify(y.files);
      const row = { tree, command, outputs: !x || !y ? 'missing' : same ? 'equal' : 'differ' };
      if (!outputsOnly && a.measurements?.[command] && b?.measurements?.[command]) {
        for (const key of ['wallMs', 'maxRssMB']) {
          row[`${key}Before`] = median(a.measurements[command].map((m) => m?.[key]));
          row[`${key}After`] = median(b.measurements[command].map((m) => m?.[key]));
        }
        const over = (key, ratio) =>
          row[`${key}Before`] !== null &&
          row[`${key}After`] !== null &&
          row[`${key}After`] > row[`${key}Before`] * ratio &&
          row[`${key}After`] - row[`${key}Before`] > NOISE[key];
        row.slower = over('wallMs', slower);
        row.larger = over('maxRssMB', larger);
      }
      rows.push(row);
    }
  }
  for (const file of after.keys())
    if (!before.has(file)) rows.push({ tree: file.replace(/\.json$/, ''), command: '*', outputs: 'missing' });
  const failed = rows.filter((r) => r.outputs !== 'equal' || r.slower || r.larger);
  return { rows, failed: failed.length };
}

const ratio = (b, a) => (b && a !== null && b !== null ? `${(a / b).toFixed(2)}x` : '');
export function markdown({ rows }, { outputsOnly = false } = {}) {
  const head = outputsOnly
    ? ['tree', 'command', 'outputs']
    : [
        'tree',
        'command',
        'outputs',
        'wall before',
        'wall after',
        'ratio',
        'peak before',
        'peak after',
        'ratio',
        'flag',
      ];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) {
    const cells = [r.tree, r.command, r.outputs];
    if (!outputsOnly)
      cells.push(
        r.wallMsBefore == null ? '' : `${r.wallMsBefore} ms`,
        r.wallMsAfter == null ? '' : `${r.wallMsAfter} ms`,
        ratio(r.wallMsBefore, r.wallMsAfter),
        r.maxRssMBBefore == null ? '' : `${r.maxRssMBBefore} MB`,
        r.maxRssMBAfter == null ? '' : `${r.maxRssMBAfter} MB`,
        ratio(r.maxRssMBBefore, r.maxRssMBAfter),
        [r.slower && 'slower', r.larger && 'larger'].filter(Boolean).join(', '),
      );
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const paths = [],
    o = { outputsOnly: false, slower: 1.1, larger: 1.1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--outputs-only') o.outputsOnly = true;
    else if (arg === '--slower') o.slower = Number(argv[++i]);
    else if (arg === '--larger') o.larger = Number(argv[++i]);
    else if (arg === '--json') o.json = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else paths.push(arg);
  }
  if (paths.length !== 2)
    throw new Error(
      'usage: compare.mjs <before> <after> [--outputs-only] [--slower <ratio>] [--larger <ratio>] [--json <file>]',
    );
  const result = compare(load(paths[0]), load(paths[1]), o);
  if (o.json) writeFileSync(o.json, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(markdown(result, o));
  process.stdout.write(
    `\n${result.failed ? `${result.failed} row(s) differ, are missing, or are past the ratios` : 'every output is equal'}${result.failed || o.outputsOnly ? '' : ', and no command is slower or larger past the ratios'}\n`,
  );
  if (result.failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
