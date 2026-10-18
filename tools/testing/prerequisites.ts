import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { Manifest, TaskRecord } from './manifest.js';

/** A clean shard must build workspace prerequisites before compiling its consumer. */
export function validateBuildDependencies(root: string, manifest: Manifest): readonly string[] {
  const builds = manifest.tasks.filter((task) => task.id.endsWith(':build'));
  const packages = builds.map((task) => ({
    task,
    package: JSON.parse(readFileSync(resolve(root, task.project, 'package.json'), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    },
  }));
  const owners = new Map(packages.map((entry) => [entry.package.name, entry.task.id]));
  return packages.flatMap(({ task, package: pkg }) =>
    Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).flatMap((name) => {
      const dependency = owners.get(name);
      return dependency && !task.dependsOn.includes(dependency)
        ? [`${task.id}: missing workspace build prerequisite ${dependency}`]
        : [];
    }),
  );
}

const SOURCE_SUFFIXES = ['', '.ts', '.mts', '.mjs', '.js', '/index.ts', '/index.mjs'];
const SPAWNERS = ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'fork'];
const DEVELOPMENT_CONDITION = '--conditions=development';

/** Resolve a relative specifier to the source file it names, tolerating emitted `.js` extensions. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(from, '..', specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.mts'),
    ...SOURCE_SUFFIXES.map((suffix) => base + suffix),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const callee = (node: ts.CallExpression): string =>
  ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : '';

/**
 * Specifiers a file needs at run time. Parsed rather than matched, so a specifier quoted inside a
 * fixture string is not mistaken for an import, and `import type` is excluded because it erases.
 */
function runtimeSpecifiers(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  const erases = (clause: ts.ImportClause | undefined): boolean => {
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
      !clause.name &&
      !!bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  };
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!erases(node.importClause)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return specifiers;
}

/** Every `@inventarch/*` package a set of entry files reaches at run time through relative imports. */
function reachedPackages(entries: readonly string[]): ReadonlySet<string> {
  const packages = new Set<string>(),
    seen = new Set<string>(),
    queue = [...entries];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of runtimeSpecifiers(parse(file))) {
      if (specifier.startsWith('@inventarch/')) {
        packages.add(specifier.split('/').slice(0, 2).join('/'));
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const target = resolveRelative(file, specifier);
      if (target) queue.push(target);
    }
  }
  return packages;
}

/**
 * Scripts a test file runs in a child Node process that resolves packages the installed way. A spawn
 * carrying `--conditions=development` reaches package source and needs no build; one without it lands on
 * the `default` export, which is the built `dist`. Only statically named scripts are reported, so a
 * computed path is skipped rather than guessed at.
 */
function installedChildScripts(root: string, source: ts.SourceFile): readonly string[] {
  const scripts: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && SPAWNERS.includes(callee(node))) {
      const [command, argv] = node.arguments;
      const node_ = command && ts.isPropertyAccessExpression(command) && command.name.text === 'execPath';
      if (
        (node_ || (command && ts.isStringLiteral(command) && /(^|\/)node(\.exe)?$/.test(command.text))) &&
        argv &&
        ts.isArrayLiteralExpression(argv)
      ) {
        const literals = argv.elements.filter(ts.isStringLiteral).map((element) => element.text);
        if (!literals.includes(DEVELOPMENT_CONDITION)) {
          const script = literals.find((literal) => !literal.startsWith('-') && /\.[cm]?[jt]s$/.test(literal));
          if (script && existsSync(resolve(root, script))) scripts.push(resolve(root, script));
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return scripts;
}

/**
 * A test task that runs a script in an installed-resolution child process must build every workspace
 * package that script imports. validateBuildDependencies reads package.json, so it only constrains
 * `:build` tasks; nothing else declares this edge, and an omission surfaces as a missing `dist/` on
 * whichever shard happens to run the task without a package build beside it.
 */
export function validateTestPrerequisites(root: string, manifest: Manifest): readonly string[] {
  const byId = new Map(manifest.tasks.map((task) => [task.id, task]));
  const owners = new Map(
    manifest.tasks
      .filter((task) => task.id.endsWith(':build'))
      .map((task) => [
        (JSON.parse(readFileSync(resolve(root, task.project, 'package.json'), 'utf8')) as { name?: string }).name,
        task.id,
      ]),
  );
  return manifest.tasks.flatMap((task) => {
    if (task.kind !== 'vitest' || task.mode !== 'source') return [];
    const scripts = task.files.flatMap((file) => {
      const entry = resolve(root, task.project === '.' ? '' : task.project, file);
      return existsSync(entry) ? installedChildScripts(root, parse(entry)) : [];
    });
    if (!scripts.length) return [];
    const declared = prerequisiteClosure(byId, task.id);
    return [...reachedPackages(scripts)].sort().flatMap((name) => {
      const build = owners.get(name);
      return build && build !== task.id && !declared.has(build)
        ? [`${task.id}: runs an installed child process needing ${name}, without the build prerequisite ${build}`]
        : [];
    });
  });
}

/** The transitive `dependsOn` closure of a task, so an indirect build still counts as declared. */
function prerequisiteClosure(tasks: ReadonlyMap<string, TaskRecord>, id: string): ReadonlySet<string> {
  const closure = new Set<string>(),
    queue = [...(tasks.get(id)?.dependsOn ?? [])];
  while (queue.length) {
    const next = queue.pop() as string;
    if (closure.has(next)) continue;
    closure.add(next);
    queue.push(...(tasks.get(next)?.dependsOn ?? []));
  }
  return closure;
}
