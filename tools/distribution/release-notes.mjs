import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';
import { publicPackages } from './release-packages.mjs';

/** One file per unreleased change. `pnpm release:version` consumes them into the next coordinated changeset. */
export const PENDING = 'releases/pending';
export const NOTE_FORMAT = 'ia.npm-change-note.v1';
export const BUMPS = ['patch', 'minor', 'major'];
/** `none` records a package change with no consumer impact, such as tests; it rides along but never starts a release. */
export const NOTE_BUMPS = ['none', ...BUMPS];
/** Change ids the versioner writes itself; a note cannot claim them. */
export const GENERATED_CHANGES = ['cohort-alignment', 'repository-maintenance'];
/** Release bookkeeping that is sealed separately and never needs a note. */
export const RELEASE_MANAGED = ['.ia/public-package-inputs.json', 'CHANGELOG.md', 'releases/'];
const ID = /^[a-z][a-z0-9-]*$/;
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NOTE_KEYS = ['bump', 'format', 'packages', 'paths', 'summary', 'title'];
const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();

export function bumpVersion(version, bump) {
  assert.match(version, STABLE, 'A stable version is required');
  assert.ok(BUMPS.includes(bump), 'Bump must be patch, minor or major');
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
export function maxBump(bumps) {
  assert.ok(bumps.length, 'At least one bump is required');
  for (const bump of bumps) assert.ok(BUMPS.includes(bump), 'Bump must be patch, minor or major');
  return BUMPS[Math.max(...bumps.map((bump) => BUMPS.indexOf(bump)))];
}
/** The single bump that turns `from` into `to`; a skipped or regressing version has none. */
export function releaseBump(from, to) {
  const bump = BUMPS.find((candidate) => bumpVersion(from, candidate) === to);
  assert.ok(bump, `${to} is not the next patch, minor or major version after ${from}`);
  return bump;
}
/** Conventional-commit impact, or null when any message carries no type prefix and a person must choose. */
export function inferBump(messages) {
  if (!messages.length) return null;
  const typed = /^[a-z]+(\([^)\n]*\))?!?: \S/;
  if (!messages.every((message) => typed.test(message))) return null;
  if (messages.some((message) => /^[a-z]+(\([^)\n]*\))?!:/.test(message) || /^BREAKING[ -]CHANGE: /m.test(message)))
    return 'major';
  return messages.some((message) => /^feat(\([^)\n]*\))?: /.test(message)) ? 'minor' : 'patch';
}
export const packageOwner = (projects, path) =>
  projects.find((project) => path.startsWith(project.directory + '/'))?.manifest.name ?? null;
export const releaseManaged = (path) =>
  RELEASE_MANAGED.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix));

export function validateNote(id, note, names) {
  assert.match(id, ID, `${PENDING}/${id}.json: use a lowercase kebab-case file name`);
  assert.ok(!GENERATED_CHANGES.includes(id), `${PENDING}/${id}.json: that change id is reserved`);
  assert.ok(note && typeof note === 'object' && !Array.isArray(note), `${id}: a release note is a JSON object`);
  assert.deepEqual(Object.keys(note).sort(), NOTE_KEYS, `${id}: a release note has exactly ${NOTE_KEYS.join(', ')}`);
  assert.equal(note.format, NOTE_FORMAT, `${id}: unexpected release note format`);
  assert.ok(NOTE_BUMPS.includes(note.bump), `${id}: bump must be none, patch, minor or major`);
  assert.ok(
    typeof note.title === 'string' && note.title.trim() && !note.title.includes('\n'),
    `${id}: a one-line title is required`,
  );
  assert.ok(typeof note.summary === 'string' && note.summary.trim(), `${id}: a user-facing summary is required`);
  assert.ok(
    Array.isArray(note.packages) && note.packages.length && new Set(note.packages).size === note.packages.length,
    `${id}: name each affected public package once`,
  );
  for (const name of note.packages) assert.ok(names.includes(name), `${id}: unknown public package ${name}`);
  assert.ok(
    Array.isArray(note.paths) &&
      note.paths.length &&
      note.paths.every(
        (path) =>
          typeof path === 'string' && path.length && !path.includes('..') && !path.includes('\\') && path[0] !== '/',
      ),
    `${id}: a repository-relative path scope is required`,
  );
  return note;
}
export function pendingNotes(root, names) {
  const directory = resolve(root, PENDING);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .sort()
    .map((name) => {
      assert.ok(name.endsWith('.json'), `${PENDING}/${name}: release notes are JSON files`);
      const id = name.slice(0, -'.json'.length);
      const note = JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
      return { id, path: `${PENDING}/${name}`, note: validateNote(id, note, names) };
    });
}

/** The scope a note claims: the directories of its packages plus the other changed areas of its branch. */
export function notePaths(projects, packages, files) {
  const paths = new Set(projects.filter((p) => packages.includes(p.manifest.name)).map((p) => p.directory + '/'));
  for (const path of files) {
    if (releaseManaged(path) || packageOwner(projects, path)) continue;
    const top = path.split('/')[0];
    // Package directories live below these roots; claim exact files there so a note never covers another package.
    paths.add(path.includes('/') && !['packages', 'apps', '.ia'].includes(top) ? top + '/' : path);
  }
  return [...paths].sort();
}
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
const conventional = (subject) => subject.replace(/^[a-z]+(\([^)]*\))?!?: /, '');

function branchEvidence(root, base) {
  const mergeBase = git(root, 'merge-base', base, 'HEAD');
  const files = new Set(
    [
      ...git(root, 'diff', '--name-only', '--no-renames', mergeBase, '--').split('\n'),
      ...git(root, 'ls-files', '--others', '--exclude-standard').split('\n'),
    ].filter(Boolean),
  );
  const messages = git(root, 'log', '--reverse', '--format=%B%x00', `${mergeBase}..HEAD`)
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean);
  return { mergeBase, files: [...files].sort(), messages };
}
function defaultBase(root) {
  for (const ref of ['origin/main', 'main'])
    try {
      git(root, 'rev-parse', '--verify', '--quiet', ref + '^{commit}');
      return ref;
    } catch {}
  assert.fail('Pass --base: neither origin/main nor main exists');
}
const packageName = (names, value) => {
  const name = value.startsWith('@') ? value : '@inventarch/' + value;
  assert.ok(names.includes(name), 'Unknown public package: ' + value);
  return name;
};

/** Draft a note from the branch diff. Explicit options win; inferred values are reported so they can be reviewed. */
export function draftNote(root, projects, options = {}) {
  const names = projects.map((project) => project.manifest.name).sort();
  const evidence = branchEvidence(root, options.base ?? defaultBase(root));
  const changed = evidence.files.filter((path) => !releaseManaged(path));
  const packages = options.packages?.length
    ? [...new Set(options.packages.map((value) => packageName(names, value)))].sort()
    : [...new Set(changed.map((path) => packageOwner(projects, path)).filter(Boolean))].sort();
  assert.ok(
    packages.length,
    'No public package changed on this branch. Internal-only changes need no release note; pass --packages to describe one anyway.',
  );
  const bump = options.bump ?? inferBump(evidence.messages);
  assert.ok(
    bump,
    'Choose the impact with --bump none|patch|minor|major (commit messages carry no conventional type to infer it)',
  );
  const subjects = evidence.messages.map((message) => conventional(message.split('\n')[0]));
  const title = options.title ?? subjects[0];
  assert.ok(title, 'Pass --title: there is no commit on this branch to take it from');
  const body = evidence.messages[0]?.split('\n').slice(1).join('\n').trim();
  const summary = options.summary ?? (subjects.length > 1 ? subjects.join('; ') + '.' : body || subjects[0]);
  assert.ok(summary, 'Pass --summary describing what changes for package consumers, and any limits');
  const note = {
    format: NOTE_FORMAT,
    bump,
    title: title.trim(),
    summary: summary.trim(),
    packages,
    paths: [...new Set([...notePaths(projects, packages, changed), ...(options.paths ?? [])])].sort(),
  };
  return { note, inferred: { bump: !options.bump, title: !options.title, summary: !options.summary }, evidence };
}
export function writeNote(root, names, note, id) {
  const taken = (candidate) =>
    GENERATED_CHANGES.includes(candidate) || existsSync(resolve(root, PENDING, candidate + '.json'));
  let base = slug(id ?? note.title);
  if (!ID.test(base)) base = 'change-' + base;
  let unique = base;
  for (let suffix = 2; taken(unique); suffix++) unique = `${base}-${suffix}`;
  validateNote(unique, note, names);
  mkdirSync(resolve(root, PENDING), { recursive: true });
  const path = `${PENDING}/${unique}.json`;
  writeFileSync(resolve(root, path), JSON.stringify(note, null, 2) + '\n');
  return path;
}

if (isEntry(process.argv[1], import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      bump: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      packages: { type: 'string' },
      paths: { type: 'string' },
      base: { type: 'string' },
      id: { type: 'string' },
    },
  });
  assert.deepEqual(positionals, ['add'], 'Use: release-notes.mjs add [--bump] [--title] [--summary] [--packages]');
  assert.ok(values.bump === undefined || NOTE_BUMPS.includes(values.bump), 'Bump must be none, patch, minor or major');
  const root = resolve(import.meta.dirname, '../..'),
    projects = publicPackages(root),
    list = (value) =>
      value
        ?.split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  const { note, inferred } = draftNote(root, projects, {
    ...values,
    packages: list(values.packages),
    paths: list(values.paths),
  });
  const path = writeNote(root, projects.map((project) => project.manifest.name).sort(), note, values.id);
  const guessed = Object.keys(inferred).filter((key) => inferred[key]);
  console.log(JSON.stringify({ note: path, ...note }, null, 2));
  if (guessed.length)
    console.log(`\nInferred from the branch: ${guessed.join(', ')}. Review the note before committing.`);
  console.log(`\nNext: git add ${path} && pnpm npm:inputs`);
}
