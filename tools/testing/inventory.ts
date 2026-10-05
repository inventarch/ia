import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import ts from 'typescript';
import { gitFiles } from '../docs/check.js';

export const SCHEMA_VERSION = 1;
export const PLATFORMS = ['linux', 'windows', 'macos'] as const;
export const MODES = ['source', 'emitted'] as const;
export const RESOURCE_CLASSES = ['pure', 'io', 'subprocess', 'native-heavy'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Mode = (typeof MODES)[number];
export type ResourceClass = (typeof RESOURCE_CLASSES)[number];
const TASK_ID = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const normalize = (value: string): string => value.replaceAll('\\', '/');

export interface TimeoutProfile {
  readonly taskTimeoutMs: number;
  readonly hookTimeoutMs: number;
  readonly testTimeoutMs: number;
  readonly subprocessTimeoutMs: number;
  readonly workerLimit: number;
}
/** A skip the task contract permits. `platforms` scopes it where the reason is platform-specific. */
export interface DeclaredSkip {
  readonly case: string;
  readonly reason: string;
  readonly platforms?: readonly Platform[];
  /** Requires execution provenance to prove the named capability is absent. */
  readonly when?: 'file-symlink-unavailable';
}

interface TaskBase {
  readonly taskTimeoutMs?: number;
  readonly id: string;
  readonly project: string;
  readonly profile: string;
  readonly platforms: readonly Platform[];
  readonly mode: Mode;
  readonly inputProfile: string;
  readonly dependsOn: readonly string[];
  readonly outputs: readonly string[];
  readonly cache: boolean;
  readonly workerLimit: number;
  readonly resourceClass: ResourceClass;
  /** Legacy qualification leaves this task takes over; several tasks may share one leaf. */
  readonly covers?: readonly string[];
  readonly reason?: string;
  readonly skips?: readonly DeclaredSkip[];
}
export interface VitestTask extends TaskBase {
  readonly kind: 'vitest';
  readonly files: readonly string[];
}
export interface CommandTask extends TaskBase {
  readonly kind: 'command';
  readonly command: string;
}
export type TaskRecord = VitestTask | CommandTask;
export interface Manifest {
  readonly schemaVersion: number;
  readonly profiles: Readonly<Record<string, TimeoutProfile>>;
  readonly inputProfiles: Readonly<Record<string, string>>;
  readonly tasks: readonly TaskRecord[];
}
export interface ProjectDescriptor {
  /** Repository-relative project directory; `.` is the repository root. */
  readonly id: string;
  readonly name: string;
  /** Project-relative Vitest configuration path. */
  readonly config: string;
}
export interface ProjectDiscovery {
  readonly project: string;
  /** Project-relative POSIX test file paths, exactly as Vitest resolved them. */
  readonly files: readonly string[];
}
export interface DiscoveredCase {
  readonly project: string;
  readonly file: string;
  readonly name: string;
}

/**
 * Reads the workspace package globs. Only the `dir/*` and literal forms this repository uses are
 * supported; an unrecognised entry refuses instead of silently shrinking the inventory.
 */
export function workspaceGlobs(source: string): readonly string[] {
  const globs: string[] = [];
  let inside = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\S/.test(line)) break;
    if (!line.trim()) continue;
    const entry = /^\s+-\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(line);
    if (!entry) throw new Error(`Unsupported workspace entry: ${line}`);
    const glob = entry[1] ?? entry[2] ?? entry[3]!;
    if (!/^[A-Za-z0-9._/-]+(?:\/\*)?$/.test(glob)) throw new Error(`Unsupported workspace glob: ${glob}`);
    globs.push(glob);
  }
  if (!globs.length) throw new Error('Workspace declares no package globs');
  return globs;
}

/** Enumerates every Vitest project from the workspace globs plus the root tools configuration. */
export function discoverProjects(root: string): readonly ProjectDescriptor[] {
  const globs = workspaceGlobs(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'));
  const directories: string[] = [];
  for (const glob of globs) {
    if (!glob.endsWith('/*')) {
      directories.push(glob);
      continue;
    }
    const parent = glob.slice(0, -2);
    if (!existsSync(resolve(root, parent))) continue;
    const listing = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', `${parent}/*/package.json`],
      { cwd: root, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 },
    );
    for (const entry of listing.split('\0').filter(Boolean)) {
      const parts = normalize(entry).split('/');
      if (parts.length === parent.split('/').length + 2) directories.push(parts.slice(0, -1).join('/'));
    }
  }
  const projects: ProjectDescriptor[] = [];
  for (const directory of [...new Set(directories)].sort()) {
    if (!existsSync(resolve(root, directory, 'vitest.config.mts'))) continue;
    const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof manifest.name !== 'string' || !manifest.name)
      throw new Error(`${directory}/package.json: missing package name`);
    projects.push({ id: directory, name: manifest.name, config: 'vitest.config.mts' });
  }
  const tools = 'vitest.tools.config.mts';
  if (!existsSync(resolve(root, tools))) throw new Error(`Missing root Vitest configuration ${tools}`);
  projects.push({ id: '.', name: '@inventarch/workspace', config: tools });
  return projects;
}

function vitestList(root: string, project: ProjectDescriptor, extra: readonly string[]): unknown {
  const bin = resolve(root, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(bin)) throw new Error('Vitest is not installed; run pnpm install before taking inventory');
  const output = execFileSync(process.execPath, [bin, 'list', '--json', '--config', project.config, ...extra], {
    cwd: resolve(root, project.id),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: process.env['CI'] ?? '1' },
  });
  const start = output.indexOf('[');
  if (start < 0) throw new Error(`${project.id}: Vitest produced no inventory`);
  return JSON.parse(output.slice(start)) as unknown;
}

/** Asks Vitest itself which files its configuration selects; a filename guess is never the source. */
export function listFiles(root: string, project: ProjectDescriptor): ProjectDiscovery {
  const rows = vitestList(root, project, ['--filesOnly']) as readonly { file?: unknown }[];
  const base = resolve(root, project.id),
    files = new Set<string>();
  for (const row of rows) {
    if (typeof row?.file !== 'string') throw new Error(`${project.id}: malformed Vitest inventory row`);
    files.add(normalize(relative(base, resolve(row.file))));
  }
  return { project: project.id, files: [...files].sort() };
}

/** Expands parameterized cases, for pre/post migration coverage comparison rather than planning. */
export function listCases(root: string, project: ProjectDescriptor): readonly DiscoveredCase[] {
  const rows = vitestList(root, project, []) as readonly { file?: unknown; name?: unknown }[];
  const base = resolve(root, project.id),
    cases: DiscoveredCase[] = [];
  for (const row of rows) {
    if (typeof row?.file !== 'string' || typeof row.name !== 'string')
      throw new Error(`${project.id}: malformed Vitest case row`);
    cases.push({ project: project.id, file: normalize(relative(base, resolve(row.file))), name: row.name });
  }
  return cases.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

/**
 * Expands a package script into the commands that actually execute. A segment that only invokes
 * another script is followed; anything carrying its own flags stays a leaf, because a recursive
 * workspace run is itself the unit of work.
 */
export function scriptLeaves(
  scripts: Readonly<Record<string, string>>,
  name: string,
  seen: readonly string[] = [],
): readonly string[] {
  const body = scripts[name];
  if (body === undefined) throw new Error(`Unknown script: ${name}`);
  if (seen.includes(name)) throw new Error(`Recursive script chain: ${[...seen, name].join(' -> ')}`);
  const leaves: string[] = [];
  for (const raw of body.split('&&')) {
    const segment = raw.trim();
    if (!segment) throw new Error(`${name}: empty command segment`);
    const nested = /^pnpm\s+([A-Za-z][\w:-]*)$/.exec(segment);
    if (nested && scripts[nested[1]!] !== undefined) leaves.push(...scriptLeaves(scripts, nested[1]!, [...seen, name]));
    else leaves.push(segment);
  }
  return leaves;
}

export function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(resolve(root, 'tools/testing/tasks.json'), 'utf8')) as Manifest;
}

export interface ValidationInput {
  readonly manifest: Manifest;
  readonly projects: readonly ProjectDescriptor[];
  readonly discovery: readonly ProjectDiscovery[];
  /** Leaf commands of the legacy qualification chain that the task set must still cover. */
  readonly leaves: readonly string[];
  /** Repository-relative test files visible to Git, including nonignored untracked additions. */
  readonly tracked: readonly string[];
}

/**
 * Mechanical manifest validation. It proves assignment coverage and declaration shape; it does not
 * establish that a task's declared cache inputs are complete, which needs the mutation probes.
 */
export function validateManifest(input: ValidationInput): readonly string[] {
  const { manifest, projects, discovery, leaves, tracked } = input,
    findings: string[] = [];
  if (manifest.schemaVersion !== SCHEMA_VERSION)
    findings.push(`tasks.json: expected schemaVersion ${SCHEMA_VERSION}, found ${String(manifest.schemaVersion)}`);
  const profiles = Object.keys(manifest.profiles ?? {}),
    inputProfiles = Object.keys(manifest.inputProfiles ?? {});
  if (!profiles.length) findings.push('tasks.json: no timeout profiles declared');
  if (!inputProfiles.length) findings.push('tasks.json: no input profiles declared');
  for (const [name, profile] of Object.entries(manifest.profiles ?? {})) {
    for (const field of [
      'taskTimeoutMs',
      'hookTimeoutMs',
      'testTimeoutMs',
      'subprocessTimeoutMs',
      'workerLimit',
    ] as const) {
      const value = profile[field];
      if (!Number.isSafeInteger(value) || value < 1)
        findings.push(`profile ${name}: ${field} must be a positive integer`);
    }
  }
  const byId = new Map<string, TaskRecord>(),
    projectIds = new Set(projects.map((project) => project.id));
  const discovered = new Map(discovery.map((entry) => [entry.project, new Set(entry.files)]));
  for (const task of manifest.tasks ?? []) {
    if (!TASK_ID.test(task.id ?? '')) {
      findings.push(`${String(task.id)}: task identity must be <owner>:<behaviour>`);
      continue;
    }
    if (byId.has(task.id)) {
      findings.push(`${task.id}: duplicate task identity`);
      continue;
    }
    byId.set(task.id, task);
  }
  for (const task of byId.values()) {
    const label = task.id;
    if (
      task.taskTimeoutMs !== undefined &&
      (!Number.isSafeInteger(task.taskTimeoutMs) || task.taskTimeoutMs < 1 || task.taskTimeoutMs > 90 * 60_000)
    )
      findings.push(`${task.id}: taskTimeoutMs must be between 1 and 5400000`);
    const profile = manifest.profiles?.[task.profile];
    if (!profile) findings.push(`${label}: unknown timeout profile ${String(task.profile)}`);
    else if (Number.isSafeInteger(task.workerLimit) && task.workerLimit > profile.workerLimit)
      findings.push(`${label}: ${task.workerLimit} workers exceeds what profile ${task.profile} permits`);
    if (!inputProfiles.includes(task.inputProfile))
      findings.push(`${label}: unknown input profile ${String(task.inputProfile)}`);
    if (!MODES.includes(task.mode)) findings.push(`${label}: unknown mode ${String(task.mode)}`);
    if (!RESOURCE_CLASSES.includes(task.resourceClass))
      findings.push(`${label}: unknown resource class ${String(task.resourceClass)}`);
    if (!Number.isSafeInteger(task.workerLimit) || task.workerLimit < 1)
      findings.push(`${label}: workerLimit must be a positive integer`);
    if (!task.platforms?.length) findings.push(`${label}: declares no platform`);
    for (const platform of task.platforms ?? [])
      if (!PLATFORMS.includes(platform)) findings.push(`${label}: unknown platform ${String(platform)}`);
    if (new Set(task.platforms ?? []).size !== (task.platforms ?? []).length)
      findings.push(`${label}: duplicate platform`);
    if (task.cache && !task.outputs?.length) findings.push(`${label}: a cacheable task must declare its outputs`);
    if (!task.cache && !task.reason) findings.push(`${label}: an uncacheable task must record why`);
    for (const skip of task.skips ?? []) {
      if (skip.when !== undefined && skip.when !== 'file-symlink-unavailable')
        findings.push(label + ': unknown skip condition ' + String(skip.when));
      if (!skip.case?.trim() || !skip.reason?.trim())
        findings.push(`${label}: an intentional skip needs a case and a named reason`);
      for (const platform of skip.platforms ?? []) {
        if (!task.platforms.includes(platform))
          findings.push(`${label}: scopes a skip to ${platform}, which the task does not run on`);
      }
    }
    for (const covered of task.covers ?? [])
      if (!leaves.includes(covered))
        findings.push(`${label}: claims to cover ${covered}, which the qualification chain does not run`);
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.id) findings.push(`${label}: depends on itself`);
      else if (!byId.has(dependency)) findings.push(`${label}: depends on unknown task ${dependency}`);
    }
    if (task.kind === 'vitest') {
      if (!projectIds.has(task.project)) findings.push(`${label}: unknown Vitest project ${task.project}`);
      if (!task.files?.length) findings.push(`${label}: selects no test file`);
      const known = discovered.get(task.project),
        seen = new Set<string>();
      for (const file of task.files ?? []) {
        if (seen.has(file)) findings.push(`${label}: repeats ${file}`);
        seen.add(file);
        if (known && !known.has(file))
          findings.push(`${label}: selects ${file}, which its Vitest configuration does not discover`);
      }
    } else if (task.kind === 'command') {
      if (!task.command?.trim()) findings.push(`${label}: declares no command`);
    } else findings.push(`${label}: unknown task kind ${String((task as { kind?: unknown }).kind)}`);
  }
  const ordered = [...byId.values()];
  for (const [index, task] of ordered.entries())
    for (const other of ordered.slice(index + 1)) {
      for (const output of task.outputs ?? [])
        for (const rival of other.outputs ?? []) {
          if (output === rival || output.startsWith(`${rival}/`) || rival.startsWith(`${output}/`))
            findings.push(`${task.id} and ${other.id}: overlapping output ${output} / ${rival}`);
        }
    }
  const cycle = findCycle(byId);
  if (cycle) findings.push(`Dependency cycle: ${cycle.join(' -> ')}`);
  for (const project of projects) {
    const owned = ordered.filter((task): task is VitestTask => task.kind === 'vitest' && task.project === project.id);
    if (!owned.length) {
      findings.push(`${project.id}: has a Vitest configuration but no assigned task`);
      continue;
    }
    const files = discovered.get(project.id) ?? new Set<string>();
    if (!files.size) findings.push(`${project.id}: its Vitest configuration discovers no test file`);
    for (const file of [...files].sort())
      for (const platform of PLATFORMS) {
        const covering = owned.filter((task) => task.files.includes(file) && task.platforms.includes(platform));
        if (!covering.length) findings.push(`${project.id}/${file}: no task runs it on ${platform}`);
        else if (covering.length > 1)
          findings.push(
            `${project.id}/${file}: ${covering.map((task) => task.id).join(', ')} all claim it on ${platform}`,
          );
      }
  }
  const selected = new Set(
    discovery.flatMap((entry) =>
      entry.files.map((file) => (entry.project === '.' ? file : `${entry.project}/${file}`)),
    ),
  );
  for (const path of tracked)
    if (!selected.has(path)) findings.push(`${path}: a test file no Vitest configuration selects`);
  const covered = new Set(ordered.flatMap((task) => task.covers ?? []));
  for (const leaf of leaves)
    if (!covered.has(leaf)) findings.push(`Qualification leaf not covered by any task: ${leaf}`);
  return [...new Set(findings)].sort();
}

function findCycle(tasks: ReadonlyMap<string, TaskRecord>): readonly string[] | undefined {
  const state = new Map<string, 'open' | 'done'>(),
    stack: string[] = [];
  const walk = (id: string): readonly string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'open') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'open');
    stack.push(id);
    for (const dependency of tasks.get(id)?.dependsOn ?? []) {
      if (!tasks.has(dependency)) continue;
      const cycle = walk(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const id of tasks.keys()) {
    const cycle = walk(id);
    if (cycle) return cycle;
  }
  return undefined;
}

/** Test files Git can see, including nonignored untracked additions made locally. */
export function trackedTestFiles(root: string): readonly string[] {
  return gitFiles(root).filter((path) => /(^|\/)[^/]+\.test\.[cm]?tsx?$/.test(path) && !path.startsWith('.ia/work/'));
}

export function qualificationLeaves(root: string, script = 'platform:qualify'): readonly string[] {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return scriptLeaves(manifest.scripts ?? {}, script);
}

export interface InventoryResult {
  readonly version: number;
  readonly projects: readonly ProjectDescriptor[];
  readonly discovery: readonly ProjectDiscovery[];
  readonly files: number;
  readonly leaves: readonly string[];
  readonly tasks: number;
  readonly findings: readonly string[];
  readonly cases?: readonly DiscoveredCase[];
  readonly limitations: readonly string[];
}

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

export function takeInventory(root: string, options: { readonly cases?: boolean } = {}): InventoryResult {
  const projects = discoverProjects(root);
  const discovery = projects.map((project) => listFiles(root, project));
  const leaves = qualificationLeaves(root),
    manifest = readManifest(root);
  const findings = [
    ...validateManifest({ manifest, projects, discovery, leaves, tracked: trackedTestFiles(root) }),
    ...validateBuildDependencies(root, manifest),
    ...validateTestPrerequisites(root, manifest),
  ];
  return {
    version: SCHEMA_VERSION,
    projects,
    discovery,
    files: discovery.reduce((total, entry) => total + entry.files.length, 0),
    leaves,
    tasks: (manifest.tasks ?? []).length,
    findings,
    ...(options.cases ? { cases: projects.flatMap((project) => listCases(root, project)) } : {}),
    limitations: [
      'Assignment coverage is mechanical; it does not prove a task declares complete cache inputs.',
      'File discovery reflects the current working tree, not another platform or revision.',
      'Case expansion imports the tests, so it reflects the built state of this checkout.',
    ],
  };
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2),
    unknown = args.filter((arg) => !['--json', '--cases'].includes(arg));
  if (unknown.length) {
    console.error('Usage: pnpm tests:inventory [--json] [--cases]');
    process.exitCode = 2;
  } else
    try {
      const result = takeInventory(resolve(import.meta.dirname, '../..'), { cases: args.includes('--cases') });
      if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `Test inventory: ${result.projects.length} Vitest projects, ${result.files} discovered files, ${result.tasks} declared tasks, ${result.leaves.length} qualification leaves.`,
        );
        if (result.cases) console.log(`Discovered cases: ${result.cases.length}.`);
        for (const finding of result.findings) console.error(finding);
        console.log(
          result.findings.length
            ? `FAIL: ${result.findings.length} findings.`
            : 'PASS: every discovered test is assigned once per platform and every qualification leaf has an owner.',
        );
      }
      if (result.findings.length) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
