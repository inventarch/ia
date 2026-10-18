import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SCHEMA_VERSION = 1;
export const PLATFORMS = ['linux', 'windows', 'macos'] as const;
export const MODES = ['source', 'emitted'] as const;
export const RESOURCE_CLASSES = ['pure', 'io', 'subprocess', 'native-heavy'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Mode = (typeof MODES)[number];
export type ResourceClass = (typeof RESOURCE_CLASSES)[number];
const TASK_ID = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

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
  return parseManifest(JSON.parse(readFileSync(resolve(root, 'tools/testing/tasks.json'), 'utf8')));
}

/** Validate the execution contract before any planner, timeout or process consumer receives it. */
export function parseManifest(value: unknown): Manifest {
  function object(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ': expected an object');
    const row = value as Record<string, unknown>;
    if (keys && Object.keys(row).some((key) => !keys.includes(key))) throw new Error(label + ': unknown field');
    return row;
  }
  function strings(value: unknown, label: string): void {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()))
      throw new Error(label + ': expected an array of nonempty strings');
  }
  function text(value: unknown, label: string): void {
    if (typeof value !== 'string' || !value.trim()) throw new Error(label + ': expected nonempty text');
  }
  const manifest = object(value, 'tasks.json', ['schemaVersion', 'profiles', 'inputProfiles', 'tasks']);
  const profiles = object(manifest['profiles'], 'profiles'),
    inputs = object(manifest['inputProfiles'], 'inputProfiles');
  for (const [name, value] of Object.entries(profiles)) {
    const profile = object(value, 'profile ' + name, [
      'taskTimeoutMs',
      'hookTimeoutMs',
      'testTimeoutMs',
      'subprocessTimeoutMs',
      'workerLimit',
    ]);
    for (const key of ['taskTimeoutMs', 'hookTimeoutMs', 'testTimeoutMs', 'subprocessTimeoutMs', 'workerLimit'])
      if (!Number.isSafeInteger(profile[key]) || (profile[key] as number) < 1)
        throw new Error('profile ' + name + ': invalid ' + key);
  }
  for (const [name, value] of Object.entries(inputs)) text(value, 'inputProfile ' + name);
  if (!Array.isArray(manifest['tasks']) || !manifest['tasks'].length)
    throw new Error('tasks: expected a nonempty array');
  for (const value of manifest['tasks']) {
    const task = object(value, 'task', [
      'id',
      'kind',
      'project',
      'profile',
      'platforms',
      'mode',
      'inputProfile',
      'dependsOn',
      'outputs',
      'cache',
      'workerLimit',
      'resourceClass',
      'covers',
      'reason',
      'skips',
      'taskTimeoutMs',
      'files',
      'command',
    ]);
    for (const key of ['id', 'kind', 'project', 'profile', 'mode', 'inputProfile', 'resourceClass'])
      text(task[key], 'task.' + key);
    for (const key of ['platforms', 'dependsOn', 'outputs']) strings(task[key], 'task.' + key);
    if (typeof task['cache'] !== 'boolean') throw new Error('task.cache: expected a boolean');
    for (const key of ['covers']) if (task[key] !== undefined) strings(task[key], 'task.' + key);
    if (task['reason'] !== undefined) text(task['reason'], 'task.reason');
    if (task['kind'] === 'vitest') {
      strings(task['files'], 'task.files');
      if (task['command'] !== undefined) throw new Error('Vitest task cannot declare a command');
    } else if (task['kind'] === 'command') {
      text(task['command'], 'task.command');
      if (task['files'] !== undefined) throw new Error('Command task cannot declare test files');
    } else throw new Error('Unknown task kind');
    if (task['skips'] !== undefined) {
      if (!Array.isArray(task['skips'])) throw new Error('task.skips: expected an array');
      for (const value of task['skips']) {
        const skip = object(value, 'skip', ['case', 'reason', 'platforms', 'when']);
        text(skip['case'], 'skip.case');
        text(skip['reason'], 'skip.reason');
        if (skip['platforms'] !== undefined) strings(skip['platforms'], 'skip.platforms');
      }
    }
  }
  const checked = value as Manifest;
  const projects = [...new Set(checked.tasks.filter((task) => task.kind === 'vitest').map((task) => task.project))];
  const findings = validateManifest({
    manifest: checked,
    projects: projects.map((id) => ({ id, name: id, config: '' })),
    discovery: projects.map((project) => ({
      project,
      files: [
        ...new Set(
          checked.tasks.flatMap((task) => (task.kind === 'vitest' && task.project === project ? task.files : [])),
        ),
      ],
    })),
    leaves: [...new Set(checked.tasks.flatMap((task) => task.covers ?? []))],
    tracked: [],
  });
  if (findings.length) throw new Error('Invalid task manifest:\n' + findings.join('\n'));
  return checked;
}

export interface ValidationInput {
  readonly manifest: Manifest;
  readonly projects: readonly ProjectDescriptor[];
  readonly discovery: readonly ProjectDiscovery[];
  /** Leaf commands of the legacy qualification chain that the task set must still cover. */
  readonly leaves: readonly string[];
  /** Repository-relative test files visible to Git, including nonignored untracked additions. */
  readonly tracked: readonly string[];
  /** Actual Nx definitions, supplied by repository inventory rather than inferred from descriptions. */
  readonly namedInputs?: Readonly<Record<string, readonly unknown[]>>;
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
  if (input.namedInputs !== undefined) {
    const named = input.namedInputs;
    const visit = (name: string, stack: readonly string[]): void => {
      if (stack.includes(name)) {
        findings.push(`cyclic Nx input profile: ${[...stack, name].join(' -> ')}`);
        return;
      }
      if (!Object.hasOwn(named, name) || !Array.isArray(named[name])) {
        findings.push(
          stack.length ? `${stack.at(-1)}: unknown Nx input profile ${name}` : `${name}: missing Nx input profile`,
        );
        return;
      }
      for (const entry of named[name]!) {
        if (typeof entry === 'string') {
          if (entry.startsWith('^')) findings.push(`${name}: namedInputs definitions cannot start with ^`);
          else if (!entry.startsWith('{') && !entry.startsWith('!')) visit(entry, [...stack, name]);
        } else if (typeof entry === 'object' && entry !== null) {
          const value = entry as Record<string, unknown>;
          if (value['projects'] || value['dependencies'])
            findings.push(`${name}: namedInputs may only refer to definitions within the same project`);
          else if (
            ![
              'fileset',
              'env',
              'runtime',
              'externalDependencies',
              'dependentTasksOutputFiles',
              'workingDirectory',
              'json',
            ].some((key) => value[key])
          ) {
            if (typeof value['input'] === 'string') visit(value['input'], [...stack, name]);
            else findings.push(`${name}: invalid Nx input reference`);
          }
        } else findings.push(`${name}: invalid Nx input definition`);
      }
    };
    for (const name of inputProfiles) visit(name, []);
  }
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

export function qualificationLeaves(root: string, script = 'platform:qualify'): readonly string[] {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return scriptLeaves(manifest.scripts ?? {}, script);
}
