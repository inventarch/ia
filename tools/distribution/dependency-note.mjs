import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gitText } from '../shared/git.mjs';
import { isEntry } from '../entry/is-entry.mjs';
import { publicPackages } from './release-packages.mjs';
import { draftNote, writeNote } from './release-notes.mjs';

/**
 * A pending release note for a branch that only moves dependency ranges, such as a Dependabot pull request: Dependabot
 * edits public package manifests but writes no note, so `pnpm release:check` refuses it. The Dependabot release note
 * workflow runs this with Node alone, before any dependency install, so it imports only Node built-ins and repository
 * tools.
 */

/** The manifest sections a consumer installs with the package; a move in one of them is a patch. */
export const RUNTIME_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const SECTIONS = [...RUNTIME_SECTIONS, 'devDependencies'];

/** Each dependency whose range differs between two manifests, in section then name order. */
export function dependencyChanges(before, after) {
  const rows = [];
  for (const section of SECTIONS) {
    const from = before?.[section] ?? {},
      to = after?.[section] ?? {};
    for (const name of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort())
      if (from[name] !== to[name]) rows.push({ section, name, from: from[name] ?? null, to: to[name] ?? null });
  }
  return rows;
}

const move = (row) =>
  (row.from === null
    ? `adds \`${row.name}\` ${row.to}`
    : row.to === null
      ? `drops \`${row.name}\``
      : `\`${row.name}\` ${row.from} to ${row.to}`) + (row.section === 'devDependencies' ? ' (development)' : '');

/**
 * Bump, title and summary for the dependency moves of each public package. A runtime move is a patch; a branch that
 * moves only development dependencies records `none`, which rides along with the next release but never starts one.
 * @param {readonly {name: string, rows: ReturnType<typeof dependencyChanges>}[]} packages
 */
export function describeDependencyChanges(packages) {
  const moved = packages.filter((entry) => entry.rows.length);
  assert.ok(moved.length, 'No public package manifest moves a dependency; this branch needs a hand-written note');
  const runtime = moved.some((entry) => entry.rows.some((row) => RUNTIME_SECTIONS.includes(row.section)));
  const parts = moved.map((entry) => `\`${entry.name}\`: ${entry.rows.map(move).join(', ')}`);
  return {
    bump: runtime ? 'patch' : 'none',
    title: runtime ? 'Move dependencies to newer releases' : 'Move development dependencies to newer releases',
    summary: `${runtime ? 'Dependencies' : 'Only development dependencies'} move to newer releases. ${parts.join('; ')}.`,
  };
}

/** The manifest a package directory had at `commit`, or null where it did not exist. */
function manifestAt(root, commit, directory) {
  try {
    return JSON.parse(gitText(root, ['show', `${commit}:${directory}/package.json`]));
  } catch {
    return null;
  }
}

/** Write the note for HEAD against `base` and return its repository path. */
export function writeDependencyNote(root, base, id) {
  const projects = publicPackages(root),
    mergeBase = gitText(root, ['merge-base', base, 'HEAD']);
  const described = describeDependencyChanges(
    projects.map((project) => ({
      name: project.manifest.name,
      rows: dependencyChanges(manifestAt(root, mergeBase, project.directory), project.manifest),
    })),
  );
  const { note } = draftNote(root, projects, { base, ...described });
  return writeNote(root, projects.map((project) => project.manifest.name).sort(), note, id);
}

if (isEntry(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: 'string' }, id: { type: 'string' } } });
  assert.ok(values.base && values.id, 'Use: dependency-note.mjs --base <commit> --id <note id>');
  console.log(writeDependencyNote(resolve(import.meta.dirname, '../..'), values.base, values.id));
}
