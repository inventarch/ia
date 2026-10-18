import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { parseOptions } from '../shared/args.mjs';
import { gitFiles } from '../../packages/runtime/src/authoring-execution/inventory.js';
import {
  readManifest,
  qualificationLeaves,
  validateManifest,
  SCHEMA_VERSION,
  type ProjectDescriptor,
  type ProjectDiscovery,
  type DiscoveredCase,
} from './manifest.js';
import { validateBuildDependencies, validateTestPrerequisites } from './prerequisites.js';
export * from './manifest.js';
export { validateBuildDependencies, validateTestPrerequisites } from './prerequisites.js';
const normalize = (value: string): string => value.replaceAll('\\', '/');

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

/** Test files Git can see, including nonignored untracked additions made locally. */
export function trackedTestFiles(root: string): readonly string[] {
  return gitFiles(root).filter((path) => /(^|\/)[^/]+\.test\.[cm]?tsx?$/.test(path) && !path.startsWith('.ia/work/'));
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

export function takeInventory(root: string, options: { readonly cases?: boolean } = {}): InventoryResult {
  const projects = discoverProjects(root);
  const discovery = projects.map((project) => listFiles(root, project));
  const leaves = qualificationLeaves(root),
    manifest = readManifest(root);
  const findings = [
    ...validateManifest({
      manifest,
      projects,
      discovery,
      leaves,
      tracked: trackedTestFiles(root),
      namedInputs:
        (
          JSON.parse(readFileSync(resolve(root, 'nx.json'), 'utf8')) as {
            namedInputs: Record<string, readonly unknown[]>;
          }
        ).namedInputs ?? {},
    }),
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
  let options: ReturnType<typeof parseOptions> | undefined;
  try {
    options = parseOptions(process.argv.slice(2), { booleans: ['json', 'cases'] });
  } catch (error) {
    console.error('Usage: pnpm tests:inventory [--json] [--cases]');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (options)
    try {
      const result = takeInventory(resolve(import.meta.dirname, '../..'), { cases: options.has('cases') });
      if (options.has('json')) console.log(JSON.stringify(result, null, 2));
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
