// Derives one Nx target per declared task in tools/testing/tasks.json. Targets are contributed
// through the plugin rather than written into each project, so no configuration file is added under
// a steward-owned tree, and the manifest stays the single place a task is defined.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MANIFEST = 'tools/testing/tasks.json';
const ROOT_PROJECT = 'workspace';
const TOOL_DIRECTORY = /^tools\/[^/]+(?=\/)/;
const isToolDirectory = (root) => /^tools\/[^/]+$/.test(root);

/**
 * Nx project name for a project directory: the package name, `tools-<name>` for a tools directory,
 * or `workspace` at the root.
 */
export function projectNameFor(workspaceRoot, project) {
  if (project === '.') return ROOT_PROJECT;
  if (isToolDirectory(project)) return project.replace('/', '-');
  const manifest = JSON.parse(readFileSync(resolve(workspaceRoot, project, 'package.json'), 'utf8'));
  if (typeof manifest.name !== 'string' || !manifest.name)
    throw new Error(`${project}/package.json declares no package name`);
  return manifest.name;
}

/** The workspace files a root task executes: its Vitest selection, or the tools paths its script names. */
function entriesOf(task, scripts) {
  if (task.kind === 'vitest') return task.files ?? [];
  const script = /^pnpm (\S+)/.exec(task.command ?? '')?.[1];
  return [...(scripts[script] ?? '').matchAll(/(?:^|\s)(tools\/\S+)/g)].map((match) => match[1]);
}

/**
 * The directory whose Nx project owns a task. A root task whose entries all lie in one tools
 * directory belongs to that directory, so its imports, rather than everything the root project
 * happens to contain, decide what its result depends on. Anything else stays at the root.
 */
export function ownerOf(task, scripts) {
  if (task.project !== '.') return task.project;
  const directories = new Set(entriesOf(task, scripts).map((entry) => TOOL_DIRECTORY.exec(entry)?.[0]));
  return directories.size === 1 && !directories.has(undefined) ? [...directories][0] : '.';
}

export const behaviourOf = (id) => id.slice(id.indexOf(':') + 1);

/**
 * Target name for a task: its whole identity, slugged. Keeping the owner in the name avoids
 * colliding with the plain npm-script targets Nx infers from each package, so a declared task and
 * the raw script it wraps stay distinguishable.
 */
export const targetNameFor = (task) => task.id.replace(':', '-');

const scriptsOf = (workspaceRoot) =>
  JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8')).scripts ?? {};

/** The Nx task reference for a manifest task identity. */
export function nxTaskFor(workspaceRoot, tasks, id) {
  const task = tasks.find((entry) => entry.id === id);
  if (!task) throw new Error(`Unknown task ${id}`);
  return `${projectNameFor(workspaceRoot, ownerOf(task, scriptsOf(workspaceRoot)))}:${targetNameFor(task)}`;
}

function targetFor(workspaceRoot, manifest, scripts, task) {
  const owner = ownerOf(task, scripts);
  const dependsOn = task.dependsOn.map((id) => {
    const dependency = manifest.tasks.find((entry) => entry.id === id);
    if (!dependency) throw new Error(`${task.id} depends on unknown task ${id}`);
    return {
      projects: [projectNameFor(workspaceRoot, ownerOf(dependency, scripts))],
      target: targetNameFor(dependency),
    };
  });
  return {
    executor: 'nx:run-commands',
    // The task's own manifest entry and timeout profile are its execution contract. Nx hashes target
    // options, so editing one entry invalidates that project's results rather than every task's, and the
    // manifest file itself need not be a shared input. run-commands does not forward object options.
    options: {
      command: `pnpm tests:run --task ${task.id}`,
      contract: { schemaVersion: manifest.schemaVersion, task, profile: manifest.profiles?.[task.profile] ?? null },
    },
    // The profile names the task's own files and filesystem-read trees. Dependencies come from the
    // import graph, without their test files, which no consumer imports. A tools directory also reads
    // the documents and records the root project owns through the filesystem; those files enter as the
    // root's own files only, because the root's dependencies span the whole workspace. Nothing else
    // crosses: a dependency task's hash and its build products are not part of this hash.
    inputs: [
      task.inputProfile,
      '^dependency-source',
      ...(isToolDirectory(owner) ? [{ input: 'owner-source', projects: ROOT_PROJECT }] : []),
    ],
    outputs: task.outputs.map((output) => `{workspaceRoot}/${output}`),
    dependsOn,
    cache: task.cache === true,
    // Native-heavy work claims a runner to itself rather than competing for memory.
    parallelism: task.resourceClass !== 'native-heavy',
    metadata: { description: `${task.kind} task ${task.id} (${task.profile} profile, ${task.mode} mode)` },
  };
}

export function projectNodes(workspaceRoot) {
  const manifest = JSON.parse(readFileSync(resolve(workspaceRoot, MANIFEST), 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error(`${MANIFEST}: unsupported schemaVersion`);
  manifest.tasks ??= [];
  const scripts = scriptsOf(workspaceRoot),
    projects = {};
  for (const task of manifest.tasks) {
    const root = ownerOf(task, scripts);
    projects[root] ??=
      root === '.'
        ? { name: ROOT_PROJECT, projectType: 'application', targets: {} }
        : isToolDirectory(root)
          ? { name: projectNameFor(workspaceRoot, root), projectType: 'library', targets: {} }
          : { targets: {} };
    const name = targetNameFor(task);
    if (projects[root].targets[name]) throw new Error(`${task.id}: ${root} already contributes a ${name} target`);
    projects[root].targets[name] = targetFor(workspaceRoot, manifest, scripts, task);
  }
  return { projects };
}

export const createNodesV2 = [
  MANIFEST,
  async (files, _options, context) => files.map((file) => [file, projectNodes(context.workspaceRoot)]),
];
