/**
 * Reads the parts of a GitHub Actions workflow that the tools tests hold to the plan: its job names, the gate job's
 * `needs`, and the gate's matrix rows. It reads lines, not YAML, because `yaml` is only Vite's optional peer here and
 * not a declared dependency. It accepts LF or CRLF, full-line and trailing comments, single- or double-quoted
 * scalars, and a row's keys in either order. It reads block-style mappings only: a flow-style row such as
 * `- { os: …, platform: … }` yields a row without values, so the caller's comparison fails instead of passing.
 */

export interface GateRow {
  readonly os: string | undefined;
  readonly platform: string | undefined;
}

interface Line {
  readonly indent: number;
  readonly text: string;
}

/** The job every platform's gate row belongs to. */
export const GATE_JOB = 'qualify';

/** Drops a comment that starts at a `#` outside quotes and after whitespace, then trailing whitespace. */
function uncomment(line: string): string {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index).trimEnd();
  }
  return line.trimEnd();
}

function lines(text: string): readonly Line[] {
  return text
    .split(/\r?\n/)
    .map(uncomment)
    .filter((line) => line.trim() !== '')
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
}

const scalar = (value: string): string => value.replace(/^(['"])(.*)\1$/, '$2');

/** `key: value` or `key:`, with the value unquoted; undefined for anything else. */
function entry(text: string): { readonly key: string; readonly value: string } | undefined {
  const match = /^(['"]?)([\w-]+)\1:(?:\s+(.*))?$/.exec(text);
  return match ? { key: match[2]!, value: scalar(match[3] ?? '') } : undefined;
}

/** The lines indented under `lines[at]`, up to the first line at or above its indentation. */
function childrenOf(all: readonly Line[], at: number): readonly Line[] {
  const children: Line[] = [];
  for (let index = at + 1; index < all.length && all[index]!.indent > all[at]!.indent; index += 1)
    children.push(all[index]!);
  return children;
}

/** The direct `key:` children of a block, each with the lines indented under it. */
function mapping(
  block: readonly Line[],
): ReadonlyMap<string, { readonly value: string; readonly children: readonly Line[] }> {
  const result = new Map<string, { value: string; children: readonly Line[] }>();
  const indent = Math.min(...block.map((line) => line.indent));
  block.forEach((line, index) => {
    const found = line.indent === indent ? entry(line.text) : undefined;
    if (found) result.set(found.key, { value: found.value, children: childrenOf(block, index) });
  });
  return result;
}

function jobBlocks(text: string): ReadonlyMap<string, readonly Line[]> {
  const all = lines(text);
  const jobs = all.findIndex((line) => line.indent === 0 && line.text === 'jobs:');
  if (jobs < 0) return new Map();
  const block = childrenOf(all, jobs);
  if (!block.length) return new Map();
  return new Map([...mapping(block)].map(([name, job]) => [name, job.children]));
}

/** Each job's name mapped to its body, comments removed; the refusal loop is read from this text. */
export function workflowJobs(text: string): ReadonlyMap<string, string> {
  return new Map([...jobBlocks(text)].map(([name, body]) => [name, body.map((line) => line.text).join('\n')]));
}

/** The jobs the gate job waits for, from `needs: [a, b]`, `needs: a` or a block list. */
export function qualifyNeeds(text: string): readonly string[] {
  const gate = jobBlocks(text).get(GATE_JOB);
  const needs = gate?.length ? mapping(gate).get('needs') : undefined;
  if (!needs) return [];
  if (needs.value) {
    const flow = /^\[(.*)\]$/.exec(needs.value);
    return (flow ? flow[1]!.split(',') : [needs.value]).map((name) => scalar(name.trim())).filter(Boolean);
  }
  return needs.children.filter((line) => line.text.startsWith('- ')).map((line) => scalar(line.text.slice(2).trim()));
}

/** The gate job's `strategy.matrix.include` rows. */
export function qualifyRows(text: string): readonly GateRow[] {
  const gate = jobBlocks(text).get(GATE_JOB);
  const strategy = gate?.length ? mapping(gate).get('strategy') : undefined;
  const matrix = strategy?.children.length ? mapping(strategy.children).get('matrix') : undefined;
  const include = matrix?.children.length ? mapping(matrix.children).get('include') : undefined;
  if (!include?.children.length) return [];
  const items = include.children;
  const indent = Math.min(...items.map((line) => line.indent));
  const rows: GateRow[] = [];
  items.forEach((line, index) => {
    if (line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) return;
    // A row's own keys: the one after the dash, then those at the first level under it.
    const rest = childrenOf(items, index);
    const level = Math.min(...rest.map((child) => child.indent));
    const fields = [
      line.text.slice(1).trim(),
      ...rest.filter((child) => child.indent === level).map((child) => child.text),
    ];
    const values = new Map<string, string>();
    for (const field of fields) {
      const found = entry(field);
      if (found) values.set(found.key, found.value);
    }
    rows.push({ os: values.get('os'), platform: values.get('platform') });
  });
  return rows;
}

/**
 * Every key of every `env:` mapping in a workflow, at the workflow, job and step levels, in file order. A flow-style
 * or expression-valued `env:` (`env: { A: 1 }`, `env: ${{ … }}`) is refused rather than read as no keys, so a caller
 * holding the keys to a list cannot pass by finding none. Lines inside a block scalar are read like any other line.
 */
export function workflowEnvKeys(text: string): readonly string[] {
  const all = lines(text),
    keys: string[] = [];
  all.forEach((line, index) => {
    const found = entry(line.text);
    if (found?.key !== 'env') return;
    if (found.value) throw new Error(`env: ${found.value} is not a block mapping, so its keys cannot be read`);
    const children = childrenOf(all, index);
    if (children.length) keys.push(...mapping(children).keys());
  });
  return keys;
}
