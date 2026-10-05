import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { open, systemMember, unaliased } from '../../packages/db/src/index.js';
import type { CompiledRecord } from '../../packages/language/src/index.js';
import { PROJECTION_MARKER, renderHostArtifacts } from '../../packages/compliance/src/index.js';
import type { HostArtifact, ProjectionMembership } from '../../packages/compliance/src/index.js';
import { HOST_MODES, launcherInvocation } from '../../apps/distribution/src/host-modes.js';

const BOOTSTRAP_HASH = 'b4df6f906cd3d27a26061eddc3cf997f58015866fc610a195c5b228d619ef2eb';
const skillPaths = ['.agents/skills/ia-authoring/SKILL.md', '.claude/skills/ia-authoring/SKILL.md'];
function safe(root: string, path: string): string {
  const base = resolve(root),
    target = resolve(base, path),
    rel = relative(base, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep))
    throw new Error(`Projection path escapes root: ${path}`);
  // Another case or normalization of the same names is not an alias (#315); a link anywhere in the root still is.
  if (!unaliased(base, realpathSync.native(base))) throw new Error('Projection root is aliased');
  let current = base;
  for (const part of ['', ...rel.split(sep)]) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Projection path is aliased: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
function owned(bytes: Buffer, path: string): boolean {
  return (
    bytes.toString('utf8').split(/\r?\n/).includes(PROJECTION_MARKER) ||
    (skillPaths.includes(path) && createHash('sha256').update(bytes).digest('hex') === BOOTSTRAP_HASH)
  );
}
/** I/O seam used by the real composition root and bounded filesystem tests. */
export function publishArtifacts(root: string, artifacts: readonly HostArtifact[], write: boolean): readonly string[] {
  const expected = new Set(artifacts.map((a) => a.path)),
    pending: HostArtifact[] = [];
  const allowed = (path: string): boolean =>
    path === 'CLAUDE.md' ||
    skillPaths.includes(path) ||
    /^\.(?:agents|claude)\/skills\/ia-authoring\/(?:parts\/(?:orient|plan|act|learn)\.md|scripts\/context\.mjs)$/.test(
      path,
    ) ||
    /^\.claude\/agents\/[a-z][a-z0-9-]*\.md$/.test(path);
  if (expected.size !== artifacts.length || artifacts.some((a) => !allowed(a.path)))
    throw new Error('Invalid projection output set');
  const agents = safe(root, '.claude/agents');
  if (existsSync(agents))
    for (const entry of readdirSync(agents, { withFileTypes: true })) {
      const path = `.claude/agents/${entry.name}`,
        target = safe(root, path);
      if (
        entry.isFile() &&
        !expected.has(path) &&
        readFileSync(target, 'utf8').split(/\r?\n/).includes(PROJECTION_MARKER)
      )
        throw new Error(`Stale managed projection requires source-aware reconciliation: ${path}`);
    }
  for (const host of ['.agents', '.claude'])
    for (const directory of ['parts', 'scripts']) {
      const prefix = `${host}/skills/ia-authoring/${directory}`,
        folder = safe(root, prefix);
      if (!existsSync(folder)) continue;
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = `${prefix}/${entry.name}`,
          target = safe(root, path);
        if (entry.isFile() && !expected.has(path) && owned(readFileSync(target), path))
          throw new Error(`Stale managed projection requires source-aware reconciliation: ${path}`);
      }
    }
  // Preflight the complete set before publishing any file.
  for (const artifact of artifacts) {
    const target = safe(root, artifact.path);
    if (existsSync(target)) {
      const bytes = readFileSync(target);
      if (bytes.equals(Buffer.from(artifact.text))) continue;
      if (!owned(bytes, artifact.path)) throw new Error(`Refusing unmanaged projection: ${artifact.path}`);
    }
    pending.push(artifact);
  }
  if (write)
    for (const artifact of pending) {
      const target = safe(root, artifact.path);
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        safe(root, relative(resolve(root), temp));
        writeFileSync(temp, artifact.text, { encoding: 'utf8', flag: 'wx' });
        safe(root, artifact.path);
        if (existsSync(target) && !owned(readFileSync(target), artifact.path))
          throw new Error(`Projection changed before publication: ${artifact.path}`);
        renameSync(temp, target);
      } finally {
        safe(root, relative(resolve(root), temp));
        if (existsSync(temp)) unlinkSync(temp);
      }
    }
  return pending.map((a) => a.path);
}
/** Observe only the caller's admitted view, retaining exact immutable source paths. */
export function projectionMembership(records: readonly CompiledRecord[], revision: string): ProjectionMembership {
  return Object.freeze({
    revision,
    members: Object.freeze(
      [...new Set(records.map((r) => r.source.path))].sort().flatMap((path) => {
        const member = systemMember(path);
        return [Object.freeze({ path, system: member?.name ?? null, root: member?.root ?? null })];
      }),
    ),
  });
}
export function generateProjections(root: string, write: boolean): readonly string[] {
  const db = open(root, { cache: false });
  try {
    if (db.report.findings.some((f) => f.severity === 'error'))
      throw new Error('Native corpus has errors; projections refused');
    const records = db.records(),
      rendered = renderHostArtifacts(
        records,
        db.revision,
        projectionMembership(records, db.revision),
        HOST_MODES.map((row) => ({ invocation: launcherInvocation(row), meaning: row.meaning })),
        { requireStewardProfiles: true },
      );
    if (rendered.assessment.outcome !== 'pass')
      throw new Error(rendered.assessment.findings.map((f) => f.message).join('; '));
    return publishArtifacts(root, rendered.artifacts, write);
  } finally {
    db.close();
  }
}
if (isEntry(process.argv[1], import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !['--check', '--write'].includes(process.argv[2]!))
      throw new Error('Usage: generate.ts --check|--write');
    const write = process.argv[2] === '--write',
      changed = generateProjections(resolve(import.meta.dirname, '../..'), write);
    process.stdout.write(
      `${write ? 'Updated' : 'Drifted'} projections: ${changed.length}${changed.length ? '\n' + changed.join('\n') : ''}\n`,
    );
    if (!write && changed.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
