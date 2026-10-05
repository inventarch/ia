import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';

const temporary = realpathSync.native(tmpdir()),
  roots: string[] = [];
const selector = pathToFileURL(resolve(import.meta.dirname, 'physical-temp.mjs')).href;
const windows = process.platform === 'win32';
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== temporary || !root.startsWith(resolve(temporary, 'ia-physical-temp-')))
      throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(resolve(temporary, 'ia-physical-temp-'));
  roots.push(root);
  const actual = resolve(root, 'actual temporary directory'),
    alias = resolve(root, 'alias');
  mkdirSync(actual);
  symlinkSync(actual, alias, 'junction');
  return { root, actual: realpathSync.native(actual), alias };
}
// A fresh process imports the selector first, as a Vitest configuration or tool script does, then reports what it sees.
// Without a value it gets no TMPDIR; off Windows it also loses TMP and TEMP, so Node falls back to /tmp.
function selectedWith(value?: string) {
  const code = `await import(${JSON.stringify(selector)}); const { tmpdir } = await import('node:os'); process.stdout.write(JSON.stringify({ tmpdir: tmpdir(), TMPDIR: process.env.TMPDIR }));`;
  const env = { ...process.env };
  delete env['TMPDIR'];
  if (value !== undefined) env['TMPDIR'] = value;
  else if (!windows) {
    delete env['TMP'];
    delete env['TEMP'];
  }
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as { tmpdir: string; TMPDIR?: string };
}

it('points TMPDIR at the physical directory when the selected one is reached through a link', () => {
  const f = fixture(),
    seen = selectedWith(f.alias);
  // Windows selects its temporary directory from TEMP/TMP, so the selector leaves TMPDIR alone there.
  if (windows) expect(seen.TMPDIR).toBe(f.alias);
  else expect(seen).toEqual({ tmpdir: f.actual, TMPDIR: f.actual });
});

it('points TMPDIR at the physical directory when a link sits above the selected one', () => {
  // The macOS shape: /var/folders/…/T is a real directory below the /var link, so the link is an ancestor, not the leaf.
  const f = fixture(),
    physical = resolve(f.actual, 'nested'),
    selected = resolve(f.alias, 'nested');
  mkdirSync(physical);
  const seen = selectedWith(selected);
  if (windows) expect(seen.TMPDIR).toBe(selected);
  else expect(seen).toEqual({ tmpdir: physical, TMPDIR: physical });
});

it('resolves the /tmp fallback when TMPDIR is unset', () => {
  // A scrubbed environment leaves Node on /tmp, which macOS also reaches through a link (/tmp -> private/tmp).
  const seen = selectedWith();
  if (windows) {
    expect(seen.TMPDIR).toBeUndefined();
    return;
  }
  const fallback = realpathSync.native('/tmp');
  expect(seen).toEqual(fallback === '/tmp' ? { tmpdir: '/tmp' } : { tmpdir: fallback, TMPDIR: fallback });
});

it('leaves an already physical TMPDIR unchanged', () => {
  const f = fixture(),
    seen = selectedWith(f.actual);
  expect(seen.TMPDIR).toBe(f.actual);
  if (!windows) expect(seen.tmpdir).toBe(f.actual);
});

it('rewrites a non-canonical spelling of a real directory', () => {
  // Spelled by hand: resolve() would fold the '..' before the selector saw it.
  const f = fixture(),
    spelled = `${f.actual}/nested/..`;
  mkdirSync(resolve(f.actual, 'nested'));
  const seen = selectedWith(spelled);
  if (windows) expect(seen.TMPDIR).toBe(spelled);
  else expect(seen).toEqual({ tmpdir: f.actual, TMPDIR: f.actual });
});

it('leaves an unreadable TMPDIR for the operation that uses it to report', () => {
  const f = fixture(),
    missing = resolve(f.root, 'missing');
  expect(selectedWith(missing).TMPDIR).toBe(missing);
});

// The selector helps only a process that imports it before anything reads tmpdir(). A configuration or script that
// forgets it stays green on Linux and Windows and fails only on macOS, at the alias refusal, so the importers are
// checked here. The files are parsed, never imported: an import would make this project depend on theirs.
const repo = resolve(import.meta.dirname, '../..'),
  selectorPath = resolve(import.meta.dirname, 'physical-temp.mjs');
const inRepo = (path: string): string => relative(repo, path).replaceAll('\\', '/');
// What a file loads, parsed rather than matched, so a specifier inside a comment or a string does not count: its
// static imports and re-exports in evaluation order, then its import() calls. Type-only forms are left out, because
// the compiler erases them. `bare` marks `import '…'`, the one form that loads a module for its effect alone.
function loads(file: string): { path: string; bare: boolean }[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  // An import names the emitted '.js'; the file beside it may be the TypeScript source.
  const target = (specifier: string): string => {
    if (!specifier.startsWith('.')) return specifier;
    const path = resolve(dirname(file), specifier);
    return existsSync(path) ? path : path.replace(/\.([cm]?)js$/, '.$1ts');
  };
  const erases = (clause: ts.ImportClause | undefined): boolean =>
    !!clause &&
    (clause.isTypeOnly ||
      (!clause.name &&
        !!clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly)));
  const out: { path: string; bare: boolean }[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !erases(statement.importClause)
    )
      out.push({ path: target(statement.moduleSpecifier.text), bare: !statement.importClause });
    else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.isTypeOnly
    )
      out.push({ path: target(statement.moduleSpecifier.text), bare: false });
  }
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      out.push({ path: target(node.arguments[0].text), bare: false });
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}
const selectorFirst = (file: string): boolean => {
  const [first] = loads(file);
  return first?.bare === true && first.path === selectorPath;
};

it('is the first import of every Vitest configuration a task runs', () => {
  // tools/testing/run.ts runs a task's Vitest with <project>/vitest.config.mts, or with the root tools configuration.
  const manifest = JSON.parse(readFileSync(resolve(repo, 'tools/testing/tasks.json'), 'utf8')) as {
    tasks: { kind: string; project: string }[];
  };
  const configs = [
    ...new Set(
      manifest.tasks
        .filter((task) => task.kind === 'vitest')
        .map((task) =>
          resolve(repo, task.project, task.project === '.' ? 'vitest.tools.config.mts' : 'vitest.config.mts'),
        ),
    ),
  ];
  expect(configs.length).toBeGreaterThan(1);
  expect(configs.filter((config) => !selectorFirst(config)).map(inRepo)).toEqual([]);
});

// Modules that make a temporary root under tmpdir(), or load one that does, without being an entry point, and modules
// that run where the selector does not apply. `loadedBy` names every script that loads the module; each of those is
// listed too or imports the selector first. An entry that no longer needs its place fails, and so does a script that
// loads a listed module without being named. One list serves both trees, so entries and loaders this tree lacks are
// skipped: tools/systems/fixture.ts exists only in the public tree, several others only in this one.
const NOT_ENTRY_POINTS: Readonly<Record<string, { reason: string; loadedBy?: readonly string[] }>> = {
  'tools/compliance/publication-fixtures.ts': { reason: 'a library', loadedBy: ['tools/compliance/check.ts'] },
  'tools/distribution/qualify-linux.mjs': { reason: 'runs only inside WSL Linux' },
  'tools/quality/capture.ts': {
    reason: 'a library',
    loadedBy: [
      'tools/quality/main.ts',
      'tools/quality/scan.ts',
      'tools/quality/test-design.ts',
      'tools/quality/test-run.ts',
    ],
  },
  'tools/quality/scan.ts': { reason: 'a library that loads capture.ts', loadedBy: ['tools/quality/main.ts'] },
  'tools/quality/test-design.ts': { reason: 'a library', loadedBy: ['tools/quality/main.ts'] },
  'tools/quality/test-run.ts': {
    reason: 'a library',
    loadedBy: ['tools/quality/main.ts', 'tools/quality/test-design.ts'],
  },
  'tools/release/export.mjs': { reason: 'its tmpdir() and mkdtemp are text inside a fixture it writes' },
  'tools/systems/fixture.ts': {
    reason: 'written by tools/release/export.mjs for the public tree',
    loadedBy: ['tools/systems/scenarios.ts'],
  },
  'tools/systems/refusal-fixtures.ts': { reason: 'a library', loadedBy: ['tools/compliance/check.ts'] },
};
// The scripts Node runs directly: every module under tools/, whatever its flavour, and the plain-JavaScript files
// beside the apps' and packages' tests, which package scripts and tests start with node. Tests and fixtures are left out.
function scripts(): string[] {
  const under = (dir: string): string[] =>
    existsSync(resolve(repo, dir))
      ? (readdirSync(resolve(repo, dir), { recursive: true }) as string[]).map(
          (file) => `${dir}/${file.replaceAll('\\', '/')}`,
        )
      : [];
  const beside = ['apps', 'packages']
    .flatMap((top) => readdirSync(resolve(repo, top)).flatMap((name) => under(`${top}/${name}/tests`)))
    .filter((file) => /\.[cm]?js$/.test(file));
  return [
    ...under('tools').filter((file) => /\.[cm]?[jt]s$/.test(file) && !/\.d\.[cm]?ts$/.test(file)),
    ...beside,
  ].filter((file) => !/\.test\.[cm]?[jt]s$/.test(file) && !file.includes('/fixtures/'));
}
// The check is keyed on mkdtemp: a script that makes a temporary root under tmpdir() calls both.
const makesRoot = (file: string): boolean => {
  const text = readFileSync(resolve(repo, file), 'utf8');
  return text.includes('tmpdir()') && text.includes('mkdtemp');
};
const present = (file: string): boolean => existsSync(resolve(repo, file));
const loaded = (file: string): string[] => loads(resolve(repo, file)).map(({ path }) => inRepo(path));

it('is the first import of every script that makes a temporary root under tmpdir()', () => {
  const makers = scripts().filter(makesRoot);
  expect(makers.length).toBeGreaterThan(0);
  expect(makers.filter((file) => !(file in NOT_ENTRY_POINTS) && !selectorFirst(resolve(repo, file)))).toEqual([]);
  // A listed module keeps its place only while it makes a root or loads one that does, and not once it imports the selector.
  const stale = (file: string): boolean =>
    selectorFirst(resolve(repo, file)) ||
    !(makesRoot(file) || loaded(file).some((path) => path !== file && path in NOT_ENTRY_POINTS));
  expect(Object.keys(NOT_ENTRY_POINTS).filter((file) => present(file) && stale(file))).toEqual([]);
});

it('names every script that loads a listed module, and each of them is listed or imports the selector first', () => {
  const all = scripts(),
    listed = Object.entries(NOT_ENTRY_POINTS).filter(([file]) => present(file));
  expect(listed.length).toBeGreaterThan(0);
  const unnamed = listed.flatMap(([file, { loadedBy = [] }]) => {
    const found = all.filter((script) => loaded(script).includes(file)).sort(),
      named = loadedBy.filter(present).sort();
    return found.join() === named.join()
      ? []
      : [`${file} is loaded by [${found.join(', ')}], named [${named.join(', ')}]`];
  });
  expect(unnamed).toEqual([]);
  const unguarded = listed.flatMap(([, { loadedBy = [] }]) =>
    loadedBy.filter(
      (loader) => present(loader) && !(loader in NOT_ENTRY_POINTS) && !selectorFirst(resolve(repo, loader)),
    ),
  );
  expect(unguarded).toEqual([]);
});
