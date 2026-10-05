import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Portable documentation metadata only. This is not the native @lane axis.
export const PORTFOLIO_LANES = ['FND', 'AUT', 'WRK', 'REV', 'OPS', 'LRN', 'EXP', 'DST'];
const fail = (message) => {
  throw new Error(`Portfolio: ${message}`);
};
const repoName = (value) => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const lane = (value) => PORTFOLIO_LANES.includes(value);
const digest = (value) => createHash('sha256').update(value.replaceAll('\r\n', '\n')).digest('hex');
const locator = (value) =>
  typeof value === 'string' &&
  /^docs\/[A-Za-z0-9._/-]+$/.test(value) &&
  !value.split('/').some((p) => !p || p === '.' || p === '..');
const key = (entry) => `${entry.repository}:${entry.id}`;

function parse(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
  if (!['ia-portfolio-registry/1', 'ia-portfolio-membership/1'].includes(value.format)) fail('unsupported format');
  if (!repoName(value.repository)) fail('invalid repository');
  if (!Array.isArray(value.lanes) || value.lanes.length !== PORTFOLIO_LANES.length)
    fail('exactly eight lane definitions required');
  const ids = new Set();
  for (const entry of value.lanes) {
    if (!entry || !lane(entry.id) || ids.has(entry.id) || !text(entry.name) || !text(entry.charter))
      fail('invalid or duplicate lane definition');
    ids.add(entry.id);
    for (const field of ['accountablePerson', 'curatorAgent'])
      if (entry[field] !== null && !text(entry[field]))
        fail(`${entry.id}: ${field} must be a nonempty identifier or null`);
    if (
      entry.slack !== undefined &&
      (!entry.slack || !/^T[A-Z0-9]+$/.test(entry.slack.workspaceId) || !/^[CG][A-Z0-9]+$/.test(entry.slack.channelId))
    )
      fail(`${entry.id}: invalid Slack locator`);
  }
  const registry = value.format === 'ia-portfolio-registry/1';
  const repositories = registry ? value.repositories : [value.repository];
  if (
    !Array.isArray(repositories) ||
    !repositories.length ||
    repositories.some((r) => !repoName(r)) ||
    new Set(repositories).size !== repositories.length ||
    !repositories.includes(value.repository)
  )
    fail('invalid repository inventory');
  if (
    !registry &&
    (!value.source ||
      !repoName(value.source.repository) ||
      !locator(value.source.path) ||
      !/^[a-f0-9]{64}$/.test(value.source.digest))
  )
    fail('invalid registry provenance');
  if (!Array.isArray(value.assignments)) fail('assignments must be an array');
  const assignments = new Map();
  for (const entry of value.assignments) {
    if (!entry || !repositories.includes(entry.repository) || !text(entry.id) || !lane(entry.portfolioLane))
      fail('invalid assignment repository, identity or lane');
    if (assignments.has(key(entry))) fail(`duplicate assignment ${key(entry)}`);
    if (!text(entry.rationale)) fail(`${key(entry)}: rationale required`);
    if (
      !Array.isArray(entry.consultedLanes) ||
      entry.consultedLanes.some((id) => !lane(id) || id === entry.portfolioLane) ||
      new Set(entry.consultedLanes).size !== entry.consultedLanes.length
    )
      fail(`${key(entry)}: invalid consulted lanes`);
    assignments.set(key(entry), entry);
  }
  if (!Array.isArray(value.supportingFiles)) fail('supportingFiles must be an array');
  const paths = new Set();
  for (const entry of value.supportingFiles) {
    if (!entry || !repositories.includes(entry.repository) || !locator(entry.path) || !entry.path.endsWith('.md'))
      fail('invalid supporting file');
    const fileKey = `${entry.repository}:${entry.path}`;
    if (paths.has(fileKey)) fail(`duplicate supporting file ${fileKey}`);
    paths.add(fileKey);
    if (entry.parentId !== undefined) {
      if (
        !text(entry.parentId) ||
        entry.portfolioLane !== undefined ||
        !assignments.has(`${entry.repository}:${entry.parentId}`)
      )
        fail(`${fileKey}: invalid inherited assignment`);
    } else if (!lane(entry.portfolioLane)) fail(`${fileKey}: supporting file needs a parent or lane`);
  }
  return value;
}

export function projectPortfolio(registryText, sourcePath, repository) {
  const registry = parse(registryText);
  if (registry.format !== 'ia-portfolio-registry/1') fail('projection input must be the authoritative registry');
  if (!locator(sourcePath) || !registry.repositories.includes(repository))
    fail('unknown projection repository or source path');
  return {
    format: 'ia-portfolio-membership/1',
    repository,
    source: { repository: registry.repository, path: sourcePath, digest: digest(registryText) },
    lanes: registry.lanes,
    assignments: registry.assignments.filter((entry) => entry.repository === repository),
    supportingFiles: registry.supportingFiles.filter((entry) => entry.repository === repository),
  };
}

function localFile(root, relative) {
  if (!locator(relative)) fail(`unsafe path ${relative}`);
  const base = fs.realpathSync(root),
    file = path.resolve(base, relative);
  // Refuse aliased ancestors as well as symlink leaves, even when the target stays in the repository.
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail(`aliased path ${relative}`);
  }
  if (!fs.statSync(file).isFile()) fail(`not a file ${relative}`);
  return file;
}

export function resolvePortfolio(root, policy, documents) {
  if (policy.portfolio === undefined) return null;
  const raw = fs.readFileSync(localFile(root, policy.portfolio), 'utf8');
  const value = parse(raw);
  const projection =
    value.format === 'ia-portfolio-registry/1' ? projectPortfolio(raw, policy.portfolio, policy.repository) : value;
  if (value.repository !== policy.repository || projection.repository !== policy.repository)
    fail('membership belongs to a different repository');
  const assignments = new Map(projection.assignments.map((entry) => [entry.id, entry.portfolioLane]));
  const identities = new Set(),
    documentPaths = new Set();
  for (const doc of documents) {
    if (identities.has(doc.id)) fail(`duplicate document ${doc.id}`);
    identities.add(doc.id);
    documentPaths.add(doc.path);
    if (!assignments.has(doc.id)) fail(`missing assignment ${policy.repository}:${doc.id}`);
    for (const field of ['portfolioLane', 'portfolio-lane'])
      if (Object.hasOwn(doc.metadata ?? {}, field))
        fail(`${doc.path}: ${field} is registry-owned; remove the shadow frontmatter assignment`);
  }
  for (const id of assignments.keys()) if (!identities.has(id)) fail(`orphan assignment ${policy.repository}:${id}`);
  const supportingFiles = projection.supportingFiles.map((entry) => {
    if (documentPaths.has(entry.path)) fail(`${entry.path}: catalog document cannot also be a supporting file`);
    localFile(root, entry.path);
    return {
      path: entry.path,
      portfolioLane: entry.parentId !== undefined ? assignments.get(entry.parentId) : entry.portfolioLane,
      ...(entry.parentId !== undefined ? { inheritedFrom: entry.parentId } : {}),
    };
  });
  return { source: projection.source, lanes: projection.lanes, assignments, supportingFiles };
}

export function portfolioView(portfolio) {
  if (!portfolio) return undefined;
  const { source, lanes, supportingFiles } = portfolio;
  return { source, lanes, supportingFiles };
}
