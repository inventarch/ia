import { readdirSync, type Dirent } from 'node:fs';
import { decodeDistributionJson } from '@ia/db/distribution';
import {
  bytes,
  contained,
  digest,
  fail,
  json,
  locate,
  object,
  portable,
  replace,
  sha256,
  utf8,
  workspace,
} from './files.js';
import { acquireHostRegistrationLock } from './host.js';
import type { WorkspaceHost as Host } from './hosts.js';

/** A path may be owned under more than one hash while an interrupted apply is between writing state and writing bytes. */
type Accepted = string | readonly string[];
export interface Artifact {
  readonly path: string;
  readonly text: string;
}
export type ProjectionAction = {
  readonly path: string;
  readonly action: 'create' | 'update' | 'unchanged' | 'remove' | 'unowned';
};
export type ProjectionDrift = {
  readonly path: string;
  readonly drift: 'changed' | 'missing' | 'outdated' | 'unmanaged' | 'unowned';
};
export interface ProjectionPlan {
  readonly format: 'ia.host-projection-plan.v1';
  readonly root: string;
  readonly host: Host;
  readonly marker: string;
  readonly artifacts: readonly Artifact[];
  readonly actions: readonly ProjectionAction[];
  readonly before: string | null;
  readonly digest: string;
}
/** Spec §6.3: exact paths per host; subagent files are the one pattern. */
export const PROJECTION_PATHS: Readonly<Record<Host, readonly string[]>> = Object.freeze({
  claude: ['.claude/rules/ia-workspace.md', '.claude/skills/ia-authoring/SKILL.md'],
  codex: ['AGENTS.md', '.agents/skills/ia-authoring/SKILL.md'],
});
const asHost = (value: unknown): Host => {
  if (value !== 'claude' && value !== 'codex') fail('INPUT-INVALID', 'Expected Claude or Codex');
  return value;
};
const allowed = (host: Host, path: string): boolean =>
  PROJECTION_PATHS[host].includes(path) || (host === 'claude' && /^\.claude\/agents\/[a-z][a-z0-9-]*\.md$/.test(path));
const statePath = (host: Host): string => `.ia/distributions/hosts/${host}-projection.json`;
const read = (root: string, path: string): string | null => {
  const value = bytes(root, path, 1024 * 1024);
  return value === null ? null : utf8(value);
};
const hasMarker = (text: string, marker: string): boolean => text.split(/\r?\n/).includes(marker);
const acceptedHashes = (value: Accepted | undefined): string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : [...value];
const accepts = (value: Accepted | undefined, hash: string): boolean => acceptedHashes(value).includes(hash);
/** CRLF is the one hand-edit shape worth naming: it is what an editor does on its own, not a content change. */
function handEditMessage(path: string, existing: string, accepted: Accepted | undefined): string {
  const suffix = accepts(accepted, sha256(existing.replace(/\r\n/g, '\n'))) ? ' (line endings differ)' : '';
  return `Managed file was edited by hand${suffix}: ${path}`;
}
/** Every recorded path must still be portable and allowlisted, and every hash a bare SHA-256 (or a small set of them mid-apply). */
function owned(root: string, host: Host): Record<string, Accepted> {
  const text = read(root, statePath(host));
  if (text === null) return {};
  const row = object(decodeDistributionJson(text), ['format', 'host', 'files']),
    files = row['files'];
  if (
    row['format'] !== 'ia.host-projection-state.v1' ||
    row['host'] !== host ||
    files === null ||
    typeof files !== 'object' ||
    Array.isArray(files)
  )
    fail('INPUT-INVALID', 'Invalid projection ownership state');
  const result: Record<string, Accepted> = {};
  for (const [path, value] of Object.entries(files as Record<string, unknown>)) {
    let safe: string | null;
    try {
      safe = portable(path);
    } catch {
      safe = null;
    }
    const hashes = Array.isArray(value) ? value : [value];
    if (
      safe !== path ||
      !allowed(host, path) ||
      !hashes.length ||
      hashes.length > 2 ||
      hashes.some((h) => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) ||
      new Set(hashes).size !== hashes.length
    )
      fail('INPUT-INVALID', 'Invalid projection ownership state');
    result[path] = Array.isArray(value) ? (value as string[]) : (value as string);
  }
  return result;
}
/** Spec §6.3: a marked `.claude/agents/*.md` file neither rendered nor owned is reported, never touched. Claude only. */
function orphanStewardFiles(root: string, host: Host, exclude: ReadonlySet<string>, marker: string): string[] {
  if (host !== 'claude') return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(contained(root, '.claude/agents'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-z][a-z0-9-]*\.md$/.test(entry.name)) continue;
    const path = `.claude/agents/${entry.name}`;
    if (exclude.has(path)) continue;
    // A user's own file at this path may be too large, non-UTF-8 or hard-linked; the scan skips it rather than failing the whole plan/observe.
    let existing: string | null;
    try {
      existing = read(root, path);
    } catch {
      continue;
    }
    if (existing !== null && hasMarker(existing, marker)) found.push(path);
  }
  return found;
}
export function planProjection(input: {
  readonly root: string;
  readonly host: Host;
  readonly artifacts: readonly Artifact[];
  readonly marker: string;
}): ProjectionPlan {
  const root = workspace(input.root),
    host = asHost(input.host),
    files = locate(statePath(host), () => owned(root, host)),
    actions: ProjectionAction[] = [],
    seen = new Set<string>();
  for (const artifact of input.artifacts)
    locate(artifact.path, () => {
      portable(artifact.path);
      if (Buffer.byteLength(artifact.text) > 1024 * 1024)
        fail('LIMIT-EXCEEDED', `Projection artifact exceeds 1048576 bytes: ${artifact.path}`);
      if (seen.has(artifact.path)) fail('INPUT-INVALID', 'Duplicate projection path');
      if (!allowed(host, artifact.path))
        fail('PATH-UNSAFE', `Projection path is outside the ${host} allowlist: ${artifact.path}`);
      if (!hasMarker(artifact.text, input.marker))
        fail('INPUT-INVALID', `Projection artifact is missing the marker line: ${artifact.path}`);
      seen.add(artifact.path);
      const existing = read(root, artifact.path);
      if (existing === null) {
        actions.push({ path: artifact.path, action: 'create' });
        return;
      }
      if (existing === artifact.text) {
        actions.push({ path: artifact.path, action: 'unchanged' });
        return;
      }
      if (!hasMarker(existing, input.marker))
        fail('LOCAL-MODIFICATION', `Refusing unmanaged file at a managed path: ${artifact.path}`);
      if (files[artifact.path] === undefined)
        fail(
          'LOCAL-MODIFICATION',
          `Marked file is not owned by this workspace's projection state: ${artifact.path}; remove it, then rerun`,
        );
      if (!accepts(files[artifact.path], sha256(existing)))
        fail('LOCAL-MODIFICATION', handEditMessage(artifact.path, existing, files[artifact.path]));
      actions.push({ path: artifact.path, action: 'update' });
    });
  for (const [path, value] of Object.entries(files))
    if (!seen.has(path))
      locate(path, () => {
        const existing = read(root, path);
        if (existing !== null && !accepts(value, sha256(existing)))
          fail('LOCAL-MODIFICATION', handEditMessage(path, existing, value));
        actions.push({ path, action: 'remove' });
      });
  for (const path of orphanStewardFiles(root, host, new Set([...seen, ...Object.keys(files)]), input.marker))
    actions.push({ path, action: 'unowned' });
  const body = {
    format: 'ia.host-projection-plan.v1' as const,
    root,
    host,
    marker: input.marker,
    artifacts: input.artifacts,
    actions: actions.sort((a, b) => (a.path < b.path ? -1 : 1)),
    before: read(root, statePath(host)),
  };
  return { ...body, digest: digest(body) };
}
/** State first (an expanded accepted-hash set for every path being written), then bytes, then the collapsed final state: an interrupted run never looks hand-edited on the next plan. */
export function applyProjection(
  input: ProjectionPlan,
  checkpoint: (name: string) => void = () => {},
): { status: 'projected'; written: number; removed: number } {
  const root = workspace(input.root),
    unlock = acquireHostRegistrationLock(root);
  try {
    const plan = planProjection(input);
    if (json(plan) !== json(input)) fail('PLAN-STALE', 'Projection plan no longer matches its current inputs');
    const host = plan.host,
      prior = owned(root, host),
      mutating = plan.actions.filter((a) => a.action === 'create' || a.action === 'update' || a.action === 'remove');
    if (mutating.length) {
      const pending: Record<string, Accepted> = { ...prior };
      for (const action of mutating)
        if (action.action !== 'remove') {
          const newHash = sha256(plan.artifacts.find((a) => a.path === action.path)!.text);
          const onDisk = read(root, action.path),
            currentHash = onDisk === null ? null : sha256(onDisk);
          // Bounded to at most 2: whatever is really on disk right now (if it was already accepted), plus the new target. Stale accepted hashes from earlier interrupted rounds are dropped.
          const keep = currentHash !== null && accepts(prior[action.path], currentHash) ? [currentHash] : [];
          const merged = [...new Set([...keep, newHash])];
          pending[action.path] = merged.length === 1 ? merged[0]! : merged;
        }
      replace(
        root,
        statePath(host),
        Buffer.from(json({ format: 'ia.host-projection-state.v1', host, files: pending })),
      );
      checkpoint('pending');
      for (const action of mutating) {
        if (action.action === 'remove') replace(root, action.path, null);
        else replace(root, action.path, Buffer.from(plan.artifacts.find((a) => a.path === action.path)!.text));
        checkpoint(action.path);
      }
    }
    const files = Object.fromEntries(
      plan.artifacts.map((a) => [a.path, sha256(a.text)]).sort(([a], [b]) => (a! < b! ? -1 : 1)),
    );
    replace(
      root,
      statePath(host),
      plan.artifacts.length ? Buffer.from(json({ format: 'ia.host-projection-state.v1', host, files })) : null,
    );
    checkpoint('complete');
    return {
      status: 'projected',
      written: mutating.filter((a) => a.action !== 'remove').length,
      removed: mutating.filter((a) => a.action === 'remove').length,
    };
  } finally {
    unlock();
  }
}
/** Spec §7: changed (hand edit), missing, outdated (would render differently), unmanaged (no marker), unowned (marked but not ours). Never writes. A file that cannot be read is refused at that file, as planning refuses it. */
export function observeProjection(input: {
  readonly root: string;
  readonly host: Host;
  readonly artifacts: readonly Artifact[] | null;
  readonly marker: string;
}): ProjectionDrift[] {
  const root = workspace(input.root),
    host = asHost(input.host),
    files = locate(statePath(host), () => owned(root, host)),
    drift: ProjectionDrift[] = [];
  for (const [path, value] of Object.entries(files))
    locate(path, () => {
      const existing = read(root, path);
      if (existing === null) drift.push({ path, drift: 'missing' });
      else if (!accepts(value, sha256(existing))) drift.push({ path, drift: 'changed' });
      else if (input.artifacts !== null && input.artifacts.find((a) => a.path === path)?.text !== existing)
        drift.push({ path, drift: 'outdated' });
    });
  if (input.artifacts !== null && Object.keys(files).length)
    for (const artifact of input.artifacts)
      if (files[artifact.path] === undefined)
        locate(artifact.path, () => {
          const existing = read(root, artifact.path);
          if (existing === null) drift.push({ path: artifact.path, drift: 'missing' });
          else if (!hasMarker(existing, input.marker)) drift.push({ path: artifact.path, drift: 'unmanaged' });
          else drift.push({ path: artifact.path, drift: 'unowned' });
        });
  for (const path of orphanStewardFiles(
    root,
    host,
    new Set([...Object.keys(files), ...(input.artifacts ?? []).map((a) => a.path)]),
    input.marker,
  ))
    drift.push({ path, drift: 'unowned' });
  return drift.sort((a, b) => (a.path < b.path ? -1 : 1));
}
