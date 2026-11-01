import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serialize } from '@inventarch/graph';
import { KERNEL_SOURCES, WORK_COST, WorkBudget, parse } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { runBounded } from '@tools/testing/subprocess.js';
import { open, readInputs } from '../src/index.js';
import { CACHE_BOUNDS, SOURCE_BOUNDS, WORK_BOUNDS, pastBound } from '../src/inputs.js';
import { EditorDatabase } from '../src/editor/index.js';
import { refusedWhole, viewBuilder } from '../src/view.js';

// The parse the views call, wrapped but unchanged, so a test can make it throw for one path and see what it was given.
const parsing = vi.hoisted(() => ({
  throwsAt: undefined as string | undefined,
  seen: new Set<string>(),
  compiled: [] as string[],
}));
vi.mock('@inventarch/language', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/language')>();
  return {
    ...actual,
    parse: (...args: Parameters<typeof actual.parse>) => {
      parsing.seen.add(args[1]);
      if (args[1] === parsing.throwsAt) throw new RangeError('Maximum call stack size exceeded');
      return actual.parse(...args);
    },
    compile: (...args: Parameters<typeof actual.compile>) => {
      parsing.compiled.push(args[0].path);
      return actual.compile(...args);
    },
  };
});

// Every language diagnostic a build makes, and what it was about when no budget was in force.
const saying = vi.hoisted(() => ({ said: 0, free: [] as string[] }));
vi.mock('../../language/src/diagnostics.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../language/src/diagnostics.js')>(),
    { meter } = await import('../../language/src/bounded.js');
  return {
    ...actual,
    diag: (...args: Parameters<typeof actual.diag>) => {
      saying.said += 1;
      if (meter() === undefined) saying.free.push(`${args[0]} ${args[1]}`);
      return actual.diag(...args);
    },
  };
});

// Count the view's diagnostic location reads after graph loading has copied and frozen them.
const diagnosticReads = vi.hoisted(() => ({ enabled: false, reads: 0 }));
vi.mock('@inventarch/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inventarch/graph')>();
  return {
    ...actual,
    load: (...args: Parameters<typeof actual.load>) => {
      const graph = actual.load(...args);
      if (!diagnosticReads.enabled) return graph;
      return Object.create(graph, {
        diagnostics: {
          value: graph.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            get path() {
              diagnosticReads.reads++;
              return diagnostic.path;
            },
            get line() {
              diagnosticReads.reads++;
              return diagnostic.line;
            },
          })),
        },
      });
    },
  };
});

// What admission may spend, lowered for a test: a chain long enough to pass the real one takes minutes.
const limits = vi.hoisted(() => ({
  view: undefined as number | undefined,
  admission: undefined as number | undefined,
  size: undefined as number | undefined,
}));
vi.mock('../src/inputs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/inputs.js')>();
  return {
    ...actual,
    WORK_BOUNDS: {
      ...actual.WORK_BOUNDS,
      get view() {
        return limits.view ?? actual.WORK_BOUNDS.view;
      },
      get admission() {
        return limits.admission ?? actual.WORK_BOUNDS.admission;
      },
    },
    CACHE_BOUNDS: {
      get size() {
        return limits.size ?? actual.CACHE_BOUNDS.size;
      },
    },
  };
});

const repository = resolve(import.meta.dirname, '../../..'),
  temporary: string[] = [];
function workspace(native = true) {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-db-view-'));
  temporary.push(root);
  if (native)
    cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), {
      recursive: true,
      filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
    });
  return root;
}
function put(root: string, path: string, text: string) {
  mkdirSync(resolve(root, path, '..'), { recursive: true });
  writeFileSync(resolve(root, path), text, 'utf8');
}
const methodPath = '.ia/src/systems/governance-system/records/sample-procedure.ia';
const lawPath = '.ia/src/systems/governance-system/records/sample-rule.ia';
const contractPath = '.ia/src/systems/compliance-system/contracts/foundation-authoring-contract.ia';
const methodId = 'governance-system/definition/procedure/sample-procedure';
it('admits package-local instances under the sole root owner without changing logical identity', () => {
  const root = workspace(),
    packageRoot = 'packages/example';
  const before = open(root, { cache: false });
  const original = before.records().find((record) => record.source.path === lawPath)!;
  before.close();
  const localPath = `${packageRoot}/${lawPath}`;
  put(root, localPath, readFileSync(resolve(root, lawPath), 'utf8'));
  const duplicate = open(root, { cache: false, authoredRoots: [packageRoot] });
  try {
    expect(duplicate.report.findings.some((finding) => finding.severity === 'error')).toBe(true);
  } finally {
    duplicate.close();
  }
  rmSync(resolve(root, lawPath));
  const db = open(root, { cache: false, authoredRoots: [packageRoot] });
  try {
    expect(db.get(original.identity)?.source.path).toBe(localPath);
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const scope = db.resolveScope({ identities: [original.identity] });
    expect(db.records({ within: scope.token }).map((record) => record.identity)).toEqual([original.identity]);
    put(root, localPath, `${readFileSync(resolve(root, localPath), 'utf8')}\n# source changed\n`);
    db.refresh();
    expect(() => db.records({ within: scope.token })).toThrow(/STALE/);
  } finally {
    db.close();
  }
  const standalone = open(resolve(root, packageRoot), { cache: false });
  try {
    expect(standalone.records().some((record) => record.identity === original.identity)).toBe(false);
    expect(standalone.report.findings.some((finding) => finding.severity === 'error')).toBe(true);
  } finally {
    standalone.close();
  }
});
const heldBack = '.ia/src/systems/governance-system/records/held-back.ia';
const pastBudget = (path: string) => pastBound(path, `is past ${WORK_BOUNDS.view} units of work in all`);
const refusal = (message: string) => ({
  code: 'IA-DB-SOURCE-UNAVAILABLE',
  severity: 'error',
  path: heldBack,
  line: 1,
  message,
});
it('refuses the one source whose parse throws, naming it, and keeps every other source', () => {
  const root = workspace();
  put(root, heldBack, '#! ia 1.0\n@law held-back\n');
  parsing.throwsAt = heldBack;
  const message = `Cannot parse source ${heldBack}: RangeError: Maximum call stack size exceeded`;
  const db = open(root, { cache: false });
  try {
    expect(db.get(methodId)?.source.path).toBe(methodPath);
    expect(db.report.findings.filter((finding) => finding.path === heldBack)).toEqual([refusal(message)]);
    expect(db.report.outcome).toBe('fail');
    // Whatever it declares, a reader that gates on a word counts it (D15): no word, no name, no identity.
    expect(db.unadmitted.filter((entry) => entry.path === heldBack)).toEqual([
      {
        band: 100,
        path: heldBack,
        line: 1,
        endLine: 1,
        finding: { code: 'IA-DB-SOURCE-UNAVAILABLE', path: heldBack, line: 1, message },
      },
    ]);
    // Its bytes stay inputs: refusing a source moves no revision a changed source would not.
    const before = db.revision;
    put(root, heldBack, '#! ia 1.0\n@law held-back\n# changed\n');
    db.refresh();
    expect(db.revision).not.toBe(before);
  } finally {
    db.close();
  }
  const editor = new EditorDatabase(root);
  expect(editor.current.report.findings.filter((finding) => finding.path === heldBack)).toEqual([refusal(message)]);
  expect(editor.current.get(methodId)?.source.path).toBe(methodPath);
});
it('parses a source that spends all of the budget, and refuses alone the one past it', () => {
  const root = workspace(),
    held = (count: number) => `#! ia 1.0\n@law held-back\n  k [${','.repeat(count)}]\n`,
    spends = (count: number) => {
      put(root, heldBack, held(count));
      return viewBuilder(readInputs(root))().work;
    };
  const first = spends(1_000),
    each = (spends(2_000) - first) / 1_000,
    at = 1_000 + Math.floor((WORK_BOUNDS.view - first) / each);
  put(root, heldBack, held(at));
  const kept = open(root, { cache: false });
  try {
    // A line's identical diagnostics are one entry of the report.
    expect(kept.report.findings.filter((entry) => entry.path === heldBack).map((entry) => entry.code)).toEqual([
      'IA-LANG-LIST-MALFORMED',
    ]);
  } finally {
    kept.close();
  }
  put(root, heldBack, held(at + 1));
  const db = open(root, { cache: false });
  try {
    // It alone: what it gave back is what lets every other source compile.
    expect(db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE')).toEqual([
      refusal(pastBudget(heldBack)),
    ]);
    expect(db.get(methodId)?.source.path).toBe(methodPath);
    expect(db.unadmitted.filter((entry) => entry.path === heldBack)).toHaveLength(1);
    expect(db.unadmitted.find((entry) => entry.path === heldBack)?.word).toBeUndefined();
  } finally {
    db.close();
  }
}, 60_000);
it('refuses alone a source of more records than the budget pays for', () => {
  const root = workspace();
  put(root, heldBack, `#! ia 1.0\n${'@law x\n'.repeat(Math.ceil(WORK_BOUNDS.view / WORK_COST.record))}`);
  const db = open(root, { cache: false });
  try {
    expect(db.report.findings.filter((entry) => entry.path === heldBack)).toEqual([refusal(pastBudget(heldBack))]);
    expect(db.get(methodId)?.source.path).toBe(methodPath);
  } finally {
    db.close();
  }
});
it('gives back what a refused source spent, so that it costs no other source its budget', () => {
  const root = workspace(),
    file = (name: string) => `.ia/src/systems/governance-system/records/${name}.ia`,
    refusedLines = (count: number) => `#! ia 1.0\n${' x\n'.repeat(count)}`,
    // Each of the two spends about 60% of the budget, so the second is refused however the diagnostics are weighed.
    lines = Math.ceil((0.6 * WORK_BOUNDS.view) / (WORK_COST.token + WORK_COST.diagnostic + 1));
  put(root, file('a-kept'), refusedLines(lines));
  put(root, file('b-refused'), refusedLines(lines));
  // Larger, so charged after the source refused, with room only for what that source gives back.
  put(root, file('c-kept'), `${refusedLines(1_000)}# ${'c'.repeat(2 * lines)}\n`);
  const db = open(root, { cache: false });
  try {
    const refused = db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE');
    expect(refused.map((entry) => entry.path)).toEqual([file('b-refused')]);
    expect(db.report.findings.some((entry) => entry.path === file('c-kept'))).toBe(true);
  } finally {
    db.close();
  }
}, 60_000);
it('charges what a workspace builds on first, so that its own sources cannot refuse it', () => {
  // The base is the largest and sorts last, so only its band charges it first. It and one source fit what the floor
  // leaves, as do the two sources, and all three do not, so whichever is charged last is refused: the base if they went
  // first.
  const root = workspace(false),
    room = WORK_BOUNDS.view - viewBuilder(readInputs(root))().work,
    perItem = 2 * WORK_COST.token + WORK_COST.product,
    list = (share: number) => `#! ia 1.0\n@schema x\n  k [${'a,'.repeat(Math.floor((room * share) / perItem))}a]\n`,
    base = '.ia/src/b.ia';
  put(root, base, list(0.55));
  for (const name of ['a0', 'a1']) put(root, `.ia/src/${name}.ia`, list(0.3));
  const db = open(root, {
    cache: false,
    locations: { [base]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' } },
  });
  try {
    const refused = db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE');
    expect(refused.map((entry) => entry.path)).toEqual(['.ia/src/a1.ia']);
  } finally {
    db.close();
  }
});
it('charges a band smallest first, so that a declaration outlasts the largest sources that exhaust the budget', () => {
  const root = workspace(),
    file = (name: string) => `.ia/src/systems/governance-system/${name}.ia`,
    list = (count: number) => `#! ia 1.0\n@law x\n  k [${'a,'.repeat(count)}a]\n`,
    perItem = 2 * WORK_COST.token + WORK_COST.product;
  // Three sources that pass what the workspace leaves by a few items, which is less than its `system.ia` spends. They
  // sort before that declaration, so charged by path they would fit and refuse it; smallest first, they refuse the last.
  const room = WORK_BOUNDS.view - viewBuilder(readInputs(root))().work,
    count = Math.ceil(room / perItem / 3) + 8;
  for (const name of ['aa', 'ab', 'ac']) put(root, file(name), list(count));
  const db = open(root, { cache: false });
  try {
    const refused = db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE');
    expect(refused.map((entry) => entry.path)).toEqual([file('ac')]);
    expect(db.get(methodId)?.source.path).toBe(methodPath);
  } finally {
    db.close();
  }
});
it('opens seventeen valid sources of a megabyte of comment, which hold no work', () => {
  const root = workspace(false);
  for (let index = 0; index < 17; index++) put(root, `.ia/src/c${index}.ia`, `#! ia 1.0\n#${'c'.repeat(1_048_565)}`);
  const db = open(root, { cache: false });
  try {
    expect(db.report.findings.filter((entry) => entry.severity === 'error')).toEqual([]);
  } finally {
    db.close();
  }
});
it('refuses alone a draft past 1 MiB that no walk read', () => {
  const root = workspace(),
    db = open(root, { cache: false });
  try {
    parsing.seen.clear();
    const draft = db.preview([{ path: heldBack, text: `#! ia 1.0\n# ${'c'.repeat(1_048_576)}\n` }]);
    expect(parsing.seen.has(heldBack)).toBe(false);
    expect(draft.report.findings.filter((finding) => finding.path === heldBack)).toEqual([
      refusal(`Source capture limit exceeded: ${heldBack} is over 1048576 bytes`),
    ]);
    expect(draft.records.some((record) => record.identity === methodId)).toBe(true);
  } finally {
    db.close();
  }
});
it('admits thousands of failing system folders without scanning every folder per folder', () => {
  const input = readInputs(workspace(false)),
    names = Array.from({ length: 8_000 }, (_, index) => `s${index}`),
    location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
  const view = viewBuilder({
    ...input,
    folders: names,
    sources: [
      ...input.sources,
      ...names.map((name) => ({
        path: `.ia/src/systems/${name}/system.ia`,
        text: `#! ia 1.0\n@system ${name}\n  provider "p"\n  version "1.0.0"\n`,
        location,
      })),
    ],
  })();
  expect(view.report.findings.filter((finding) => finding.code === 'IA-COMP-STEWARD-MISSING')).toHaveLength(8_000);
  expect(view.blockedSystems).toHaveLength(8_000);
  expect(view.unadmitted[0]).toMatchObject({ word: 'system', finding: { code: 'IA-COMP-STEWARD-MISSING' } });
}, 60_000);
it('refuses the records of thousands of failing folders without scanning the blocked systems per record', () => {
  const input = readInputs(workspace(false)),
    names = Array.from({ length: 3_000 }, (_, index) => `s${index}`),
    location: Location = { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' };
  const view = viewBuilder({
    ...input,
    folders: names,
    sources: [
      ...input.sources,
      ...names.map((name) => ({
        path: `.ia/src/systems/${name}/system.ia`,
        text: `#! ia 1.0\n@system ${name}\n  provider "p"\n  version "1.0.0"\n  discriminators\n    w-${name} lowers to binding\n      category capability\n      facets [head]\n      schema @schema z-${name}\n@schema z-${name}\n  lowers to binding\n  sections\n    closed\n`,
        location,
      })),
    ],
  })();
  expect(view.unadmitted).toHaveLength(6_000);
  // The record's own word is the floor's, so what blocked its folder is what refused it.
  expect(view.unadmitted.find((entry) => entry.name === 'z-s7')).toMatchObject({
    path: '.ia/src/systems/s7/system.ia',
    finding: { code: 'IA-COMP-STEWARD-MISSING', path: '.ia/src/systems/s7/system.ia' },
  });
});
it('reads each error and record span of a file refused whole a bounded number of times', () => {
  const records = 20_000,
    path = '.ia/src/many.ia';
  let reads = 0;
  const counted = (line: number, endLine: number) => ({
    get line() {
      reads += 1;
      return line;
    },
    get endLine() {
      reads += 1;
      return endLine;
    },
  });
  const nodes = Array.from({ length: records }, (_, index) => ({
    discriminator: 'law',
    name: `l${index}`,
    nested: [],
    span: counted(2 * index + 2, 2 * index + 3),
  }));
  const errors = Array.from({ length: records }, (_, index) =>
    Object.defineProperties(
      { code: 'IA-LANG-LIST-MALFORMED' as const, severity: 'error' as const, path, message: 'refused', line: 0 },
      Object.getOwnPropertyDescriptors(counted(2 * index + 3, 2 * index + 3)),
    ),
  );
  const text = `#! ia 1.0\n${'@law l\n  k [,]\n'.repeat(records)}`,
    source = {
      ast: { kind: 'file', path, version: '1.0', records: nodes, trivia: [], syntaxRecordSpans: [] },
      diagnostics: [],
      location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
    } as unknown as Parameters<typeof refusedWhole>[0],
    registry = { registrations: new Map() } as unknown as Parameters<typeof refusedWhole>[3];
  const listed = refusedWhole(source, text, new Map(), registry, errors, records + 1);
  expect(listed).toHaveLength(records);
  expect(listed[records - 1]).toMatchObject({ name: `l${records - 1}`, finding: { line: 2 * records + 1 } });
  // A scan per occurrence would read about records × records; sorting and a lookup by line read tens per record.
  expect(reads).toBeLessThan(100 * records);
});
it('stops listing a file refused whole at the limit it is given', () => {
  const path = '.ia/src/many.ia',
    source = {
      ast: { kind: 'file', path, version: '1.0', records: [], trivia: [] },
      diagnostics: [],
      location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
    } as unknown as Parameters<typeof refusedWhole>[0],
    registry = { registrations: new Map() } as unknown as Parameters<typeof refusedWhole>[3],
    errors = [{ code: 'IA-LANG-TOPLEVEL-UNEXPECTED', severity: 'error', path, line: 2, message: 'refused' }] as const;
  // One line of as many `@word` tokens as a megabyte holds, then lines an at sign opens.
  const text = `#! ia 1.0\nx ${'@a '.repeat(300_000)}\n${'@ b\n'.repeat(300_000)}`;
  const listed = refusedWhole(source, text, new Map(), registry, errors, 1_025);
  expect(listed.filter((entry) => entry.word === 'a')).toHaveLength(1_025);
  // The line's own error is its one occurrence with no word; nothing past the line that filled the list is read.
  expect(listed.filter((entry) => entry.word === undefined).map((entry) => entry.line)).toEqual([2]);
});
it('opens dense malformed sources in a small heap, as nothing it refuses is held', async () => {
  const root = workspace(false),
    text = `#! ia 1.0\n@schema x\n  k [${','.repeat(1_048_000)}]\n`;
  for (let index = 0; index < 4; index++) put(root, `.ia/src/s${index}.ia`, text);
  const script = `
    import { open } from ${JSON.stringify(pathToFileURL(resolve(repository, 'packages/db/src/index.ts')).href)};
    const db = open(process.argv[1], { cache: false });
    const refused = db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE');
    console.log(JSON.stringify({ refused: refused.length, listed: db.unadmitted.length, records: db.records().length }));
    db.close();
  `;
  const run = await runBounded(
    process.execPath,
    [
      '--max-old-space-size=160',
      '--conditions=development',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
      root,
    ],
    { cwd: repository, timeoutMs: 60_000, env: { ...process.env, NODE_OPTIONS: '' } },
  );
  expect(run.status, run.stderr.slice(0, 2_000)).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ refused: 4, listed: 4 });
}, 90_000);
/** What opening `root` in a heap of `megabytes` refused and how much it listed, read in a process of its own. */
const opened = async (root: string, megabytes: number) => {
  const script = `
    import { open } from ${JSON.stringify(pathToFileURL(resolve(repository, 'packages/db/src/index.ts')).href)};
    const db = open(process.argv[1], { cache: false });
    const refused = db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE');
    const missing = db.report.findings.filter((entry) => entry.code === 'IA-LANG-SYSTEM-MISSING');
    console.log(JSON.stringify({ refused: refused.map((entry) => entry.path), listed: db.unadmitted.length, missing: missing.length }));
    db.close();
  `;
  const run = await runBounded(
    process.execPath,
    [
      `--max-old-space-size=${megabytes}`,
      '--conditions=development',
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      script,
      root,
    ],
    { cwd: repository, timeoutMs: 60_000, env: { ...process.env, NODE_OPTIONS: '' } },
  );
  expect(run.status, run.stderr.slice(0, 2_000)).toBe(0);
  return JSON.parse(run.stdout) as { refused: string[]; listed: number; missing: number };
};
it('opens sources whose compilation is what produces their diagnostics in a small heap, refusing each alone', async () => {
  const root = workspace(false);
  // Each is under 1 MiB and parses clean: only compilation finds that none of these verbs is one. 384 MiB because their
  // trees alone need 256, held until compilation refuses them, while without the charge these two abort at 768.
  for (let index = 0; index < 2; index++)
    put(
      root,
      `.ia/src/s${index}.ia`,
      `#! ia 1.0\n@schema s${index}\n  lowers to binding\n  sections\n    closed\n  relationships\n${'    x\n'.repeat(170_000)}`,
    );
  expect(await opened(root, 384)).toEqual({
    refused: [0, 1].map((index) => `.ia/src/s${index}.ia`),
    listed: 2,
    missing: 0,
  });
}, 90_000);
it('opens systems that each list a missing requirement 100,000 times in a small heap, with a line for each', async () => {
  const root = workspace(false);
  for (let index = 0; index < 3; index++)
    put(
      root,
      `.ia/src/s${index}.ia`,
      `#! ia 1.0\n@system s${index}\n  provider "p"\n  version "0.1.0"\n  requires\n${'    - x\n'.repeat(100_000)}`,
    );
  put(
    root,
    '.ia/src/visible.ia',
    `#! ia 1.0\n${Array.from({ length: 32 }, (_, index) => `@system visible${index}x${'v'.repeat(180)}\n  provider "p"\n  version "0.1.0"\n`).join('')}`,
  );
  expect(await opened(root, 256)).toMatchObject({ refused: [], missing: 3 });
}, 90_000);
it('refuses alone a record whose long name what it holds would repeat, and its neighbours stay', () => {
  const root = workspace(),
    folder = '.ia/src/systems/governance-system',
    edges = Array.from({ length: 20_000 }, (_, index) => `    cite @law missing${index}\n`).join('');
  put(
    root,
    `${folder}/long.ia`,
    `#! ia 1.0\n@law ${'n'.repeat(400_000)}\n  meaning\n    says "a"\n    answers "b"\n  governance\n    severity blocking\n  relationships\n${edges}`,
  );
  const view = viewBuilder(readInputs(root))();
  expect([...view.unparsed]).toEqual([`${folder}/long.ia`]);
  expect(view.graph.nodes.has('governance-system/governance/law/sample-rule')).toBe(true);
});
it('holds what graph and compliance say of a long name to a fixed length', () => {
  const root = workspace(),
    folder = '.ia/src/systems/governance-system',
    name = 'n'.repeat(5_000);
  // A closed schema does not admit the section; a schema no word enrolls says so of itself; a check names its runner;
  // a tie names both places.
  put(
    root,
    `${folder}/long.ia`,
    `#! ia 1.0\n@law ${name}\n  meaning\n    says "a"\n    answers "b"\n  governance\n    severity blocking\n  extra\n    a "b"\n`,
  );
  put(root, `${folder}/enrolled.ia`, `#! ia 1.0\n@schema ${name}\n  lowers to binding\n  sections\n    closed\n`);
  put(
    root,
    '.ia/src/systems/compliance-system/unknown.ia',
    `#! ia 1.0\n@check ${name}\n  meaning\n    says "a"\n    answers "b"\n  check\n    runs COMP-NOWHERE\n    scope "x"\n  governance\n    severity blocking\n`,
  );
  const tied = `#! ia 1.0\n@law t${name}\n  meaning\n    says "a"\n    answers "b"\n  governance\n    severity blocking\n`;
  put(root, '.ia/src/tied-a.ia', tied);
  put(root, '.ia/src/tied-b.ia', tied);
  const view = viewBuilder(
      readInputs(root, {
        locations: Object.fromEntries(
          ['.ia/src/tied-a.ia', '.ia/src/tied-b.ia'].map((path) => [
            path,
            { placement: { kind: 'open', band: 50, reach: '' }, provenance: 'methodology' },
          ]),
        ),
      }),
    )(),
    said = (code: string) => view.report.findings.find((entry) => entry.code === code)?.message;
  for (const code of [
    'IA-COMP-SECTION-UNKNOWN',
    'IA-COMP-SCHEMA-UNREFERENCED',
    'IA-COMP-CHECK-UNKNOWN',
    'IA-GRAPH-IDENTITY-TIE',
  ])
    expect(said(code), code).toMatch(/\.\.\. and \d+ more characters$/);
});
it('keeps its own copy of the part of a long message it holds', async () => {
  const script = `
    import { clipped } from ${JSON.stringify(pathToFileURL(resolve(repository, 'packages/language/src/index.ts')).href)};
    const held = [];
    for (let index = 0; index < 1_000; index++) held.push(clipped(String(index).padEnd(1_048_576, 'x')));
    console.log(held.length);
  `;
  const run = await runBounded(
    process.execPath,
    ['--max-old-space-size=96', '--conditions=development', '--import', 'tsx', '--input-type=module', '--eval', script],
    { cwd: repository, timeoutMs: 60_000, env: { ...process.env, NODE_OPTIONS: '' } },
  );
  expect(run.status, run.stderr.slice(0, 2_000)).toBe(0);
  expect(run.stdout.trim()).toBe('1000');
}, 90_000);
describe('which of the sources of one size the budget refuses', () => {
  const folder = '.ia/src/systems/governance-system',
    law = (name: string) =>
      `#! ia 1.0\n@law law${name}\n  meaning\n    says "a"\n    answers "b"\n  governance\n    severity blocking\n  subject\n    covers [${'a,'.repeat(180_000)}a]\n`,
    written = () => {
      const root = workspace();
      for (const name of ['Z', 'a', 'b']) put(root, `${folder}/${name}.ia`, law(name));
      return root;
    };
  it('is the same through the disk and the editor, on identical bytes', () => {
    const root = written(),
      db = open(root, { cache: false }),
      editor = new EditorDatabase(root);
    try {
      // Both hold sources in plain string order, which sorts Z before a.
      expect(editor.current.sources.map((source) => source.path)).toEqual(readInputs(root).sources.map((s) => s.path));
      const refused = db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE');
      expect(refused.map((entry) => entry.path)).toEqual([`${folder}/b.ia`]);
      expect([...editor.current.inspect().unparsed]).toEqual([`${folder}/b.ia`]);
    } finally {
      db.close();
      editor.close();
    }
  }, 60_000);
  it('does not depend on the order of the sources it is given', () => {
    const input = readInputs(written()),
      refused = viewBuilder(input)().unparsed,
      reversed = viewBuilder({ ...input, sources: [...input.sources].reverse() })().unparsed;
    expect([...reversed]).toEqual([...refused]);
    expect([...refused]).toEqual([`${folder}/b.ia`]);
  }, 60_000);
  it('follows the order it charged in when extraction exhausts it, whatever order it was given', () => {
    const root = workspace(false),
      // Parsing leaves room for all five; what extraction says of each row, which no one source can afford, does not.
      schema = (name: string) =>
        `#! ia 1.0\n@schema s${name}\n  lowers to binding\n  sections\n    closed\n  fields\n${'    may have a.b.c as text\n'.repeat(37_000)}`;
    for (const name of ['Z', 'a', 'b', 'c', 'd']) put(root, `.ia/src/${name}.ia`, schema(name));
    const input = readInputs(root),
      last = ['.ia/src/d.ia', '.ia/src/c.ia'];
    expect([...viewBuilder(input)().unparsed]).toEqual(last);
    expect([...viewBuilder({ ...input, sources: [...input.sources].reverse() })().unparsed]).toEqual(last);
  }, 60_000);
  it('lists a collision in place order, whatever order its sources were read in', () => {
    const root = workspace(false),
      paths = Array.from({ length: 3 }, (_, index) => `.ia/src/same${index}.ia`);
    for (const [index, path] of paths.entries())
      put(
        root,
        path,
        `#! ia 1.0\n${' '.repeat(2 - index)}\n@schema same\n  lowers to binding\n  sections\n    closed\n`,
      );
    const input = readInputs(root),
      messages = (view: ReturnType<ReturnType<typeof viewBuilder>>) =>
        view.report.findings
          .filter((entry) => entry.code === 'IA-LANG-IDENTITY-COLLISION')
          .map((entry) => entry.message);
    expect(messages(viewBuilder(input)())[0]).toContain('collides with .ia/src/same1.ia:3, .ia/src/same2.ia:3');
    expect(messages(viewBuilder({ ...input, sources: [...input.sources].reverse() })())).toEqual(
      messages(viewBuilder(input)()),
    );
  });
});
describe('a stage that reads every source together', () => {
  const unavailable = (view: ReturnType<ReturnType<typeof viewBuilder>>) =>
    view.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE').map((entry) => entry.path);
  it('goes without the sources that spent most when a join exhausts the budget, and the rest keep what they said', () => {
    const root = workspace(false),
      named = (index: number) => `@system a${index}${'n'.repeat(30_000)}\n  provider "p"\n  version "0.1.0"\n`;
    // Each line of a missing requirement names the systems in force, these among them, and no one of them is at fault.
    for (let index = 0; index < 32; index++) put(root, `.ia/src/named${index}.ia`, `#! ia 1.0\n${named(index)}`);
    for (let index = 0; index < 300; index++)
      put(
        root,
        `.ia/src/m${index}.ia`,
        `#! ia 1.0\n@system m${index}\n  provider "p"\n  version "0.1.0"\n  requires\n    - ghost\n`,
      );
    const view = viewBuilder(readInputs(root))(),
      gone = unavailable(view);
    // One, then one more, then twice as many as the attempt before, until what is left is said within the budget.
    expect(gone).toHaveLength(16);
    expect(gone.every((path) => path.startsWith('.ia/src/named'))).toBe(true);
    expect(view.report.findings.filter((entry) => entry.code === 'IA-LANG-SYSTEM-MISSING')).toHaveLength(300);
    expect(view.work).toBeLessThanOrEqual(WORK_BOUNDS.view);
    expect(view.report.findings.find((entry) => entry.path === gone[0])?.message).toBe(pastBudget(gone[0]!));
  }, 60_000);
  // Thirty-two long names fill what each system missing a requirement says, so that a join exhausts the budget.
  const crowded = (root: string, missing: number) => {
    for (let index = 0; index < 32; index++)
      put(
        root,
        `.ia/src/n${index}.ia`,
        `#! ia 1.0\n@system a${index}x${'n'.repeat(10_000)}\n  provider "p"\n  version "0.1.0"\n`,
      );
    for (let index = 0; index < missing; index++)
      put(
        root,
        `.ia/src/m${index}.ia`,
        `#! ia 1.0\n@system m${index}\n  provider "p"\n  version "0.1.0"\n  requires\n    - ghost\n`,
      );
  };
  /** The floor with one source that spends 100,000 units on comments, more than any authored source here. */
  const paddedFloor = () =>
    KERNEL_SOURCES.map((source) =>
      source.path.endsWith('/predicate.ia') ? { ...source, text: `${source.text}${'#\n'.repeat(100_000)}` } : source,
    );
  const spent = (text: string) => {
    const budget = new WorkBudget(Number.MAX_SAFE_INTEGER);
    parse(text, 'a.ia', budget);
    return budget.spent();
  };
  it('goes without higher bands first when a join exhausts the budget, though floor sources spent more', () => {
    const root = workspace(false);
    crowded(root, 1_500);
    const input = readInputs(root),
      authored = input.sources.filter((source) => source.location.placement.band === 100),
      floor = input.sources.filter((source) => source.location.placement.band === 10);
    expect(Math.max(...floor.map((source) => spent(source.text)))).toBeGreaterThan(
      Math.max(...authored.map((source) => spent(source.text))),
    );
    const gone = unavailable(viewBuilder(input)());
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.filter((path) => path.startsWith('.ia/src/floor/'))).toEqual([]);
  }, 60_000);
  it('goes without an authored source when a join exhausts the budget and a floor source could pay for it alone', () => {
    const root = workspace(false);
    crowded(root, 640);
    const view = viewBuilder(readInputs(root, { floor: paddedFloor() }))(),
      gone = unavailable(view);
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.every((path) => /^\.ia\/src\/[nm]\d+\.ia$/.test(path))).toBe(true);
    expect(view.work).toBeLessThanOrEqual(WORK_BOUNDS.view);
  }, 60_000);
  it('goes without higher bands first when compilation exhausts the budget, though a floor source spent more', () => {
    const root = workspace(false),
      floor = paddedFloor(),
      comments = `#! ia 1.0\n${'#\n'.repeat(50_000)}`;
    for (const name of ['a', 'b']) put(root, `.ia/src/${name}.ia`, comments);
    const input = readInputs(root, { floor });
    // Parsing fits and the first thing compiled does not, while the padded floor source has yet to compile.
    limits.view = input.sources.reduce((sum, source) => sum + spent(source.text), 0) + 1;
    expect([...viewBuilder(input)().unparsed]).toEqual(['.ia/src/b.ia']);
  });
  it('goes without the sources that collide when what it says of them exhausts the budget', () => {
    const root = workspace(),
      folder = '.ia/src/systems/compliance-system',
      lines = Array.from({ length: 2_000 }, (_, index) => `    REQ-C-X${index} "yes"\n`).join(''),
      paths = Array.from({ length: 9 }, (_, index) => `${folder}/c${index}.ia`);
    // Each names eight others, and their identities are long: each occurrence says over 80 KB.
    for (const [index, path] of paths.entries())
      put(
        root,
        path,
        `#! ia 1.0\n@contract c${index}${'n'.repeat(10_000)}\n  version "0.1.0"\n  relationships\n    governs @check instance-schema-check\n  meaning\n    says "a"\n    answers "b"\n  inputs\n${lines}`,
      );
    // It spent more than any one of them, and it collides with nothing.
    put(root, `${folder}/large.ia`, `#! ia 1.0\n# ${'c'.repeat(800_000)}\n`);
    const view = viewBuilder(readInputs(root))();
    expect(unavailable(view).sort()).toEqual([...paths].sort());
    expect(view.report.findings.filter((entry) => entry.code === 'IA-LANG-REQUIREMENT-DUPLICATE')).toEqual([]);
    expect(view.graph.nodes.has('governance-system/governance/law/sample-rule')).toBe(true);
  }, 60_000);
  it('spends a budget on everything it says of a source, whichever stage says it', () => {
    const root = workspace(),
      folder = '.ia/src/systems/compliance-system',
      contract = (name: string) =>
        `#! ia 1.0\n@contract ${name}\n  version "0.1.0"\n  relationships\n    governs @check instance-schema-check\n  meaning\n    says "a"\n    answers "b"\n  inputs\n    REQ-C-SAME "yes"\n`,
      system = (name: string, rest: string) => `#! ia 1.0\n@system ${name}\n  provider "p"\n  version "0.1.0"\n${rest}`;
    // A word of a line the scanner refuses, a list the parser refuses, a verb only the compile refuses, and a file
    // refused at its pragma, which a listing reads again.
    put(root, '.ia/src/scan.ia', '#! ia 1.0\n  bad\n@schema a\n\tb\n');
    put(root, '.ia/src/list.ia', '#! ia 1.0\n@schema b\n  k [,]\n');
    put(
      root,
      '.ia/src/verb.ia',
      '#! ia 1.0\n@schema c\n  lowers to binding\n  sections\n    closed\n  relationships\n    x\n',
    );
    put(root, '.ia/src/pragma.ia', '@law not-read\n');
    // Every join: a requirement missing, a collision of systems at one band and of schemas, one word from two systems,
    // a word with no schema and one with another kind.
    put(root, '.ia/src/missing.ia', system('missing-one', '  requires\n    - ghost\n'));
    put(root, '.ia/src/twice-a.ia', system('twice', ''));
    put(root, '.ia/src/twice-b.ia', system('twice', ''));
    put(root, '.ia/src/schema-a.ia', '#! ia 1.0\n@schema same\n  lowers to binding\n  sections\n    closed\n');
    put(root, '.ia/src/schema-b.ia', '#! ia 1.0\n@schema same\n  lowers to binding\n  sections\n    closed\n');
    for (const name of ['word-a', 'word-b'])
      put(
        root,
        `.ia/src/${name}.ia`,
        system(name, '  discriminators\n    @shared lowers to binding category Rule schema @schema same\n'),
      );
    put(
      root,
      '.ia/src/word-c.ia',
      system(
        'word-c',
        '  discriminators\n    @nowhere lowers to binding category Rule schema @schema absent\n    @other lowers to definition category Rule schema @schema same\n',
      ),
    );
    // Requirements two files declare, and a facet its word does not declare in a file refused whole.
    put(root, `${folder}/one.ia`, contract('one'));
    put(root, `${folder}/two.ia`, contract('two'));
    put(
      root,
      '.ia/src/systems/governance-system/facet.ia',
      '#! ia 1.0\n@law faceted\n  facet nowhere\n  meaning\n    says "a"\n    answers "b"\n  governance\n    severity blocking\n',
    );
    saying.said = 0;
    saying.free.length = 0;
    const build = viewBuilder(readInputs(root)),
      view = build();
    build('', 'plan');
    const codes = view.report.findings.map((entry) => entry.code);
    // The fixture says what it means to: if one of these goes the assertion below proves less.
    for (const code of [
      'IA-LANG-SYSTEM-MISSING',
      'IA-LANG-IDENTITY-COLLISION',
      'IA-LANG-REQUIREMENT-DUPLICATE',
      'IA-LANG-PRAGMA-MISSING',
      'IA-LANG-FACET-UNDECLARED',
    ])
      expect(codes).toContain(code);
    expect(saying.said).toBeGreaterThan(10);
    expect(saying.free).toEqual([]);
  });
});
/** A system of one word that must require another of its records, so that a chain of them is refused link by link. */
const chain = (root: string, links: number) => {
  const folder = '.ia/src/systems/chain-system';
  put(
    root,
    `${folder}/system.ia`,
    '#! ia 1.0\n\n@system chain-system\n  provider "p"\n  version "0.1.0"\n  describes "x"\n  steward @agent chain-steward\n  requires\n    - agent-system\n  discriminators\n    link lowers to definition\n      category thing\n      facets [link]\n      schema @schema link\n  edges\n    require * using *\n',
  );
  put(
    root,
    `${folder}/steward.ia`,
    '#! ia 1.0\n\n@agent chain-steward\n  meaning\n    says "x"\n    answers "y"\n  governance\n    applies [link]\n',
  );
  put(
    root,
    `${folder}/schema.ia`,
    '#! ia 1.0\n\n@schema link\n  lowers to definition\n  sections\n    may have meaning\n    may have relationships\n    closed\n  fields\n    may have meaning.says as text\n  edges\n    must require link one-or-more\n',
  );
  let records = '#! ia 1.0\n';
  for (let index = 0; index < links; index++)
    records += `@link t${index}\n  relationships\n    requires @link t${index + 1}\n`;
  put(root, `${folder}/records.ia`, `${records}@link t${links}\n  meaning\n    says "the end refers to nothing"\n`);
  return `${folder}/records.ia`;
};
const linkId = (index: number) => `chain-system/definition/link/t${index}`;
it('settles a chain of refusals at what admission may spend', () => {
  const root = workspace(),
    links = 6;
  chain(root, links);
  limits.admission = (links + 1) * viewBuilder(readInputs(root))().work;
  const db = open(root, { cache: false });
  try {
    expect(db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE')).toEqual([]);
    expect(db.get(linkId(0))).toBeUndefined();
  } finally {
    db.close();
  }
});
it('stops one past what admission may spend, naming where and failing closed', () => {
  const root = workspace(),
    links = 6,
    path = chain(root, links);
  limits.admission = (links + 1) * viewBuilder(readInputs(root))().work - 1;
  const db = open(root, { cache: false });
  try {
    const message = pastBound(path, `is past ${limits.admission} units of admission in all`);
    expect(db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE')).toEqual([
      { code: 'IA-DB-SOURCE-UNAVAILABLE', severity: 'error', path, line: 1, message },
    ]);
    expect(db.report.outcome).toBe('fail');
    // A reader that gates on a word counts this as possibly that word (D15).
    expect(db.unadmitted.filter((entry) => entry.path === path && entry.word === undefined)).toHaveLength(1);
  } finally {
    db.close();
  }
});
it('leaves what it has not reached readable when it stops short, with the report failing', () => {
  const root = workspace(),
    path = chain(root, 6);
  limits.admission = 3 * viewBuilder(readInputs(root))().work - 1;
  const db = open(root, { cache: false });
  try {
    expect(db.get(linkId(0))?.source.path).toBe(path);
    expect(db.get(linkId(6))).toBeUndefined();
    expect(db.report.outcome).toBe('fail');
  } finally {
    db.close();
  }
});
it('names the blocked system when a pass past the bound refused no record', () => {
  const root = workspace();
  rmSync(resolve(root, chain(root, 1)));
  rmSync(resolve(root, '.ia/src/systems/chain-system/steward.ia'));
  limits.admission = 0;
  const db = open(root, { cache: false });
  try {
    expect(db.report.findings.filter((entry) => entry.code === 'IA-DB-SOURCE-UNAVAILABLE')).toEqual([
      expect.objectContaining({ path: '.ia/src/systems/chain-system/system.ia', line: 1 }),
    ]);
  } finally {
    db.close();
  }
});
describe('the contexts of one capture', () => {
  const heavy = '.ia/src/heavy.ia',
    reach = '.ia/src/reach.ia',
    locations = {
      [reach]: { placement: { kind: 'open', band: 50, reach: 'team' }, provenance: 'methodology' },
    } as const,
    list = (count: number) => `#! ia 1.0\n@schema heavy\n  k [${'a,'.repeat(count)}a]\n`,
    capture = (root: string, count: number) => {
      put(root, heavy, list(count));
      return viewBuilder(readInputs(root, { locations }));
    };
  it('compile once what they read under the same vocabulary, and hold one registry of it', () => {
    const root = workspace(false);
    put(root, reach, '#! ia 1.0\n# no vocabulary of its own\n');
    const build = capture(root, 100_000);
    // What extraction diagnoses is made again for each reach; compiling the list again would cost it four units an item.
    expect(build('team').work - build().work).toBeLessThan(1_000);
    expect(build('team').unparsed.size).toBe(0);
    expect(build('team').graph.registry).toBe(build().graph.registry);
  });
  it('share one node of a record, however many views load it', () => {
    const root = workspace(),
      build = viewBuilder(readInputs(root)),
      identity = 'governance-system/governance/law/sample-rule';
    expect(build('', 'plan').graph.nodes.get(identity)).toBe(build().graph.nodes.get(identity));
  });
  it('hold a registry for each vocabulary', () => {
    const root = workspace(false);
    put(root, reach, '#! ia 1.0\n@schema reached\n  lowers to binding\n  sections\n    closed\n');
    const build = capture(root, 1);
    expect(build('team').graph.registry).not.toBe(build().graph.registry);
    expect(build('team').graph.registry.schemas.has('reached')).toBe(true);
    expect(build().graph.registry.schemas.has('reached')).toBe(false);
  });
  it('spend one budget between them, each reach after the root paying for what it compiles again', () => {
    const root = workspace(false);
    put(root, reach, '#! ia 1.0\n@schema reached\n  lowers to binding\n  sections\n    closed\n');
    const spends = (count: number) => capture(root, count)('team').work,
      first = spends(1_000),
      each = (spends(2_000) - first) / 1_000,
      at = 1_000 + Math.floor((WORK_BOUNDS.view - first) / each);
    const fits = capture(root, at);
    expect(fits().unparsed.size).toBe(0);
    expect(fits('team').unparsed.size).toBe(0);
    // Its second compile is spent on top of the first, not in its place.
    expect(fits('team').work - fits().work).toBeGreaterThan(at * WORK_COST.product);
    const past = capture(root, at + 1);
    expect(past().unparsed.size).toBe(0);
    expect([...past('team').unparsed]).toEqual([heavy]);
    // The root still holds what the reach refused, so nothing of it was given back.
    expect(past('team').work).toBeGreaterThanOrEqual(past().work);
    expect(past('team').report.findings.filter((entry) => entry.path === heavy)).toEqual([
      expect.objectContaining({ code: 'IA-DB-SOURCE-UNAVAILABLE', message: pastBudget(heavy) }),
    ]);
  }, 60_000);
  it('do not read again a source one of them refused', () => {
    const root = workspace(false);
    put(root, reach, '#! ia 1.0\n@schema reached\n  lowers to binding\n  sections\n    closed\n');
    put(root, heavy, `#! ia 1.0\n@schema heavy\n  relationships\n${'    x\n'.repeat(160_000)}`);
    parsing.compiled.length = 0;
    const build = viewBuilder(readInputs(root, { locations }));
    expect([...build().unparsed]).toEqual([heavy]);
    expect([...build('team').unparsed]).toEqual([heavy]);
    expect(parsing.compiled.filter((path) => path === heavy)).toHaveLength(1);
  });
  it('hold no reach past its bound', () => {
    const root = workspace(false),
      many = (count: number) =>
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => {
            const path = `.ia/src/r${index}.ia`;
            put(root, path, '#! ia 1.0\n');
            return [
              path,
              { placement: { kind: 'open', band: 50, reach: `r${index}` }, provenance: 'methodology' } as const,
            ];
          }),
        );
    expect(viewBuilder(readInputs(root, { locations: many(SOURCE_BOUNDS.reaches - 1) }))().work).toBeGreaterThan(0);
    expect(() => viewBuilder(readInputs(root, { locations: many(SOURCE_BOUNDS.reaches) }))).toThrow(
      expect.objectContaining({
        code: 'IA-DB-SOURCE-UNAVAILABLE',
        message: expect.stringContaining(`is past ${SOURCE_BOUNDS.reaches} reaches`),
      }),
    );
  });
});
it('reads each diagnostic of a graph that refuses many records for their dimensions a bounded number of times', () => {
  const root = workspace(),
    each = 5_000;
  for (let file = 0; file < 4; file++) {
    let text = '#! ia 1.0\n';
    for (let index = 0; index < each; index++)
      text += `@law d${file}x${index}\n  meaning\n    says "a"\n    answers "b"\n  governance\n    severity nope\n`;
    put(root, `.ia/src/systems/governance-system/records/d${file}.ia`, text);
  }
  diagnosticReads.enabled = true;
  diagnosticReads.reads = 0;
  const db = open(root, { cache: false });
  try {
    expect(db.report.findings.filter((entry) => entry.code === 'IA-GRAPH-DIMENSION-UNKNOWN')).toHaveLength(4 * each);
    expect(diagnosticReads.reads).toBeLessThan(100 * 4 * each);
  } finally {
    db.close();
  }
}, 60_000);
it('caches a view that serializes within what the cache may hold, and writes nothing of one past it', () => {
  const root = workspace();
  expect(CACHE_BOUNDS.size).toBeGreaterThan(0);
  const size = serialize(viewBuilder(readInputs(root))().graph).length;
  limits.size = 10 * size;
  const kept = open(root);
  expect(kept.cache.state).toBe('written');
  kept.close();
  rmSync(resolve(root, '.ia/.iadb'), { recursive: true });
  limits.size = size >>> 1;
  const skipped = open(root);
  try {
    expect(skipped.cache).toEqual({
      state: 'unavailable',
      observations: [
        expect.objectContaining({
          code: 'IA-DB-CACHE-UNAVAILABLE',
          message: `Cache unavailable: Past ${limits.size} to serialize`,
        }),
      ],
    });
    expect(existsSync(resolve(root, '.ia/.iadb'))).toBe(false);
  } finally {
    skipped.close();
  }
});
it('reads a phase view again after a refresh', () => {
  const root = workspace(),
    db = open(root, { cache: false });
  try {
    const records = () => db.records({ within: db.resolveScope({ phase: 'act' }).token }).length,
      before = records();
    db.refresh();
    expect(records()).toBe(before);
  } finally {
    db.close();
  }
});
afterEach(() => {
  diagnosticReads.enabled = false;
  parsing.throwsAt = undefined;
  limits.view = undefined;
  limits.admission = undefined;
  limits.size = undefined;
  for (const root of temporary.splice(0)) {
    const path = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(path) || !path.startsWith('ia-db-view-') || path.includes('..'))
      throw new Error('Unsafe temporary cleanup target');
    rmSync(root, { recursive: true, force: true });
  }
});
it('admits the native corpus and keeps absent execution/build evidence explicit', () => {
  const view = viewBuilder(readInputs(workspace()))();
  expect(view.graph.byName.has('sample-procedure')).toBe(true);
  expect(view.refused).toEqual([]);
  expect(view.blockedSystems).toEqual([]);
  expect(view.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(view.report.verdicts.filter((v) => v.outcome === 'not-evaluated').map((v) => v.check)).toEqual([
    'COMP-ADOPTION',
    'COMP-FIXTURES',
    'COMP-KERNEL',
  ]);
  expect(view.report.findings.some((f) => f.code === 'IA-LANG-EDGE-TARGET-MISSING')).toBe(false);
});
it('admits only the default kernel in an empty workspace', () => {
  const view = viewBuilder(readInputs(workspace(false)))();
  expect(view.graph.nodes.size).toBe(118);
  expect(view.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(view.admittedSystems).toEqual(['floor', 'taxonomy']);
});
it('refuses a foreign instance while preserving healthy records and the owning system finding', () => {
  const root = workspace(),
    path = '.ia/src/systems/agent-system/records/foreign.ia';
  const before = [...viewBuilder(readInputs(root))().graph.nodes.keys()].sort();
  put(root, path, readFileSync(resolve(root, lawPath), 'utf8').replace('@law sample-rule', '@law foreign-law'));
  const view = viewBuilder(readInputs(root))();
  expect([...view.graph.nodes.keys()].sort()).toEqual(before);
  expect(view.graph.byName.has('foreign-law')).toBe(false);
  expect(view.report.findings.filter((f) => f.code === 'IA-COMP-DISCRIMINATOR-FOREIGN')).toHaveLength(1);
  expect(view.refused.find((r) => r.path === path)?.reason).toBe('IA-COMP-DISCRIMINATOR-FOREIGN');
});
it('refuses every preview in a language-error file but preserves another healthy file', () => {
  const root = workspace(),
    source = readFileSync(resolve(root, methodPath), 'utf8');
  put(root, '.ia/src/bad.ia', source.replace('@playbook sample-procedure', '@playbook preview') + '\n@unknown bad\n');
  put(root, '.ia/src/good.ia', source.replace('@playbook sample-procedure', '@playbook healthy'));
  const view = viewBuilder(readInputs(root))();
  expect(view.graph.byName.has('preview')).toBe(false);
  expect(view.graph.byName.has('healthy')).toBe(true);
  expect(
    view.report.findings.some((f) => f.code === 'IA-LANG-DISCRIMINATOR-UNREGISTERED' && f.path === '.ia/src/bad.ia'),
  ).toBe(true);
});
it('refuses individual schema failures and their nested descendants while keeping valid sibling records', () => {
  const root = workspace(),
    source = readFileSync(resolve(root, methodPath), 'utf8').replace('@playbook sample-procedure', '@playbook healthy');
  put(
    root,
    '.ia/src/instances.ia',
    '#! ia 1.0\n@playbook incomplete\n  meaning\n    says "missing answers and cognition"\n    @agent nested\n      meaning\n        says "nested"\n        answers "nested"\n      governance\n        applies [agent]\n' +
      source.replace('#! ia 1.0', ''),
  );
  const view = viewBuilder(readInputs(root))();
  expect(view.graph.byName.has('incomplete')).toBe(false);
  expect(view.graph.byName.has('nested')).toBe(false);
  expect(view.graph.byName.has('healthy')).toBe(true);
  expect(view.refused.some((r) => r.reason === 'enclosing record refused')).toBe(true);
});
it('refuses a missing steward join and its dependents without cascaded steward findings', () => {
  const root = workspace();
  const path = '.ia/src/systems/agent-system/steward.ia';
  put(root, path, '#! ia 1.0\n');
  const view = viewBuilder(readInputs(root))();
  expect(view.blockedSystems).toEqual([
    'agent-composition-system',
    'agent-system',
    'authoring-system',
    'compliance-system',
    'governance-system',
    'hook-authoring-system',
    'learning-system',
    'session-system',
    'template-system',
    'work-system',
    'workspace-system',
  ]);
  expect(view.graph.nodes.size).toBe(118);
  expect(view.admittedSystems).toEqual(['floor', 'taxonomy']);
  expect(view.report.findings.filter((f) => f.code === 'IA-COMP-STEWARD-MISSING')).toHaveLength(1);
});
it('refuses missing schema registration and restores every agent after source restoration', () => {
  const root = workspace(),
    path = '.ia/src/systems/agent-system/system.ia',
    original = readFileSync(resolve(root, path), 'utf8');
  const before = viewBuilder(readInputs(root))().graph.byDiscriminator.get('agent');
  put(root, path, original.replace('      schema @schema agent\n', '').replace('      schema @schema agent\r\n', ''));
  const bad = viewBuilder(readInputs(root))();
  expect(bad.graph.byDiscriminator.has('agent')).toBe(false);
  expect(bad.report.findings.some((f) => f.code === 'IA-LANG-REGISTRATION-INCOMPLETE')).toBe(true);
  put(root, path, original);
  expect(viewBuilder(readInputs(root))().graph.byDiscriminator.get('agent')).toEqual(before);
});
it('selects reach and phase before authority without compiler ambiguity between shadowed occurrences', () => {
  const root = workspace(),
    overlay = '.ia/src/override.ia';
  put(
    root,
    overlay,
    readFileSync(resolve(root, methodPath), 'utf8').replace(
      / {2}activation\n(?: {4}activate when .*\n)+/,
      '  activation\n    activate when phase is act\n',
    ),
  );
  const locations: Record<string, Location> = {
    [methodPath]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' },
    [overlay]: { placement: { kind: 'authored', band: 100, reach: 'team' }, provenance: 'workspace' },
  };
  const build = viewBuilder(readInputs(root, { locations }));
  expect(build().graph.nodes.get(methodId)?.source.path).toBe(methodPath);
  expect(build('team', 'act').graph.nodes.get(methodId)?.source.path).toBe(overlay);
  expect(build('team', 'orient').graph.nodes.get(methodId)?.source.path).toBe(methodPath);
  expect(build('team', 'act').report.findings.some((f) => f.code === 'IA-LANG-EDGE-TARGET-AMBIGUOUS')).toBe(false);
});
it('checks physical requirement duplicates across bands and disjoint reaches before authority', () => {
  const root = workspace(),
    overlay = '.ia/src/contract-overlay.ia';
  put(root, overlay, readFileSync(resolve(root, contractPath), 'utf8'));
  const view = viewBuilder(
    readInputs(root, {
      locations: { [overlay]: { placement: { kind: 'adopted', band: 90, reach: 'other' }, provenance: 'methodology' } },
    }),
  )();
  expect([...view.graph.nodes.values()].some((r) => r.name === 'foundation-authoring-contract')).toBe(false);
  const findings = view.report.findings.filter((f) => f.code === 'IA-LANG-REQUIREMENT-DUPLICATE');
  expect(findings).toHaveLength(6);
  expect(new Set(findings.map((f) => f.path))).toEqual(new Set([overlay, contractPath]));
});
it('resolves new vocabulary only in the locations where its system is visible', () => {
  const root = workspace(),
    prefix = '.ia/src/systems/extension';
  const before = [...viewBuilder(readInputs(root))().graph.nodes.keys()].sort();
  const files = {
    'system.ia':
      '#! ia 1.0\n@system extension\n  provider "fixture"\n  version "1.0.0"\n  steward @agent extension-steward\n  requires\n    - agent-system\n  discriminators\n    widget lowers to definition\n      category thing\n      facets [widget]\n      schema @schema widget\n  edges\n    cite * using *\n',
    'schemas/widget.ia': '#! ia 1.0\n@schema widget\n  lowers to definition\n  sections\n    open\n',
    'steward.ia':
      '#! ia 1.0\n@agent extension-steward\n  meaning\n    says "Own extension"\n    answers "Who owns widget?"\n  governance\n    applies [widget]\n',
    'records/one.ia': '#! ia 1.0\n@widget one\n',
  };
  const locations: Record<string, Location> = {};
  for (const [name, text] of Object.entries(files)) {
    const path = `${prefix}/${name}`;
    put(root, path, text);
    locations[path] = { placement: { kind: 'authored', band: 100, reach: 'team' }, provenance: 'workspace' };
  }
  const build = viewBuilder(readInputs(root, { locations })),
    outside = build(),
    inside = build('team');
  expect([...outside.graph.nodes.keys()].sort()).toEqual(before);
  expect(outside.admittedSystems).not.toContain('extension');
  expect(inside.graph.byDiscriminator.get('widget')).toHaveLength(1);
  expect(inside.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(inside.graph.revision).not.toBe(outside.graph.revision);
});
it('retains a malformed empty folder in revision and admission evidence', () => {
  const root = workspace(false),
    before = viewBuilder(readInputs(root))();
  mkdirSync(resolve(root, '.ia/src/systems/empty'), { recursive: true });
  const after = viewBuilder(readInputs(root))();
  expect(after.graph.revision).not.toBe(before.graph.revision);
  expect(after.report.findings.filter((f) => f.code === 'IA-COMP-SYSTEM-MALFORMED')).toHaveLength(1);
});
it('admits a record authored outside every system folder under its word’s owner at band 100', () => {
  const root = workspace(),
    path = '.ia/src/notes.ia';
  put(
    root,
    path,
    '#! ia 1.0\n@spec loose-spec\n  meaning\n    says "A specification kept beside the systems rather than inside one."\n  work\n    title "Loose specification"\n    status draft\n',
  );
  const view = viewBuilder(readInputs(root))();
  expect(view.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(view.refused).toEqual([]);
  const record = view.graph.nodes.get('work-system/contract/spec/loose-spec');
  expect(record?.source.path).toBe(path);
  expect(record?.system).toBe('work-system');
  expect(record?.band).toBe(100);
});
/** The repository's own authored tree plus a local `probe` system that requires work-system and mints `note`. */
const probe = '.ia/src/systems/probe';
function adoptingWorkspace(): string {
  const root = workspace(false);
  cpSync(resolve(repository, '.ia/src'), resolve(root, '.ia/src'), {
    recursive: true,
    filter: (path) => !/(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/.test(path),
  });
  const files = {
    'system.ia':
      '#! ia 1.0\n@system probe\n  provider "fixture"\n  version "1.0.0"\n  steward @agent probe-steward\n  requires\n    - agent-system\n    - work-system\n  discriminators\n    note lowers to definition\n      category process\n      facets [note]\n      schema @schema note\n  edges\n    require * using note\n',
    'schemas/note.schema.ia': '#! ia 1.0\n@schema note\n  lowers to definition\n  sections\n    open\n',
    'steward.ia':
      '#! ia 1.0\n@agent probe-steward\n  meaning\n    says "Owns the probe words."\n    answers "Who owns note?"\n  governance\n    applies [note]\n',
    'records/t.ia':
      '#! ia 1.0\n@task t\n  meaning\n    says "A core task the probe depends on."\n  work\n    title "Probe dependency"\n    status open\n    milestone @milestone example-milestone\n',
    'records/n.ia': '#! ia 1.0\n@note n\n  relationships\n    requires @task t\n',
  };
  for (const [name, text] of Object.entries(files)) put(root, `${probe}/${name}`, text);
  return root;
}
it('admits an adopting system’s word requiring a core task through any-adopter, and refuses it without the keyword', () => {
  const root = adoptingWorkspace();
  const view = viewBuilder(readInputs(root))();
  expect(view.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(view.admittedSystems).toContain('probe');
  expect(view.graph.nodes.get('probe/definition/note/n')?.system).toBe('probe');
  expect(view.graph.nodes.get('work-system/definition/task/t')?.source.path).toBe(`${probe}/records/t.ia`);
  expect(
    view.graph.out
      .get('probe/definition/note/n')
      ?.get('require')
      ?.map((edge) => edge.to),
  ).toEqual(['work-system/definition/task/t']);
  const ledger = '.ia/src/systems/work-system/system.ia',
    text = readFileSync(resolve(root, ledger), 'utf8');
  expect(text).toContain('using task, milestone, any-adopter');
  put(root, ledger, text.replace('using task, milestone, any-adopter', 'using task, milestone'));
  // Each file compiles against an empty pool, so the cross-file edge is judged at graph load: the record stays,
  // the edge is refused, and the refusal is the one error of the view.
  const refused = viewBuilder(readInputs(root))();
  expect(refused.graph.nodes.has('probe/definition/note/n')).toBe(true);
  expect(refused.graph.nodes.has('work-system/definition/task/t')).toBe(true);
  expect(refused.graph.out.get('probe/definition/note/n')?.get('require')).toBeUndefined();
  const errors = refused.report.findings.filter((f) => f.severity === 'error');
  expect(errors.map((f) => [f.code, f.path, f.line])).toEqual([
    ['IA-GRAPH-EDGE-UNCONSENTED', `${probe}/records/n.ia`, 4],
  ]);
  expect(errors[0]!.message).toContain(
    'target system refuses require from probe/definition/note/n to work-system/definition/task/t',
  );
}, 60_000);
