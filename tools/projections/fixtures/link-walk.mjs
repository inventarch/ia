// The one link rule for projected Markdown (private source history). The isolated packed consumer copies this file beside
// compile-prose.mjs, and in-repo tests import it, so it imports only Node built-ins. See tools/projections/SPEC.md.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

// Exactly the schemes the projection serializer passes through unchanged (resourceMarkdown in
// packages/workspace-runtime/src/projection-host.ts). They name no product file.
const EXTERNAL = /^(?:https?|mailto):/i;
// Any other scheme (a drive letter included) or an absolute path. The serializer refuses these, so one in output is a defect.
const UNSUPPORTED = /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i;
// The serializer's inline link and reference-definition grammar, with an optional title.
const INLINE = /!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s()]+))(?:\s+"[^"\n]*")?\)/g;
const DEFINITION = /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/;
const INSTRUCTIONS = 'developer_instructions = ';

/** One raw link destination: external, fragment-only, unsupported, or a local path with its fragment removed. */
export function classifyLink(raw) {
  if (raw.startsWith('#')) return { kind: 'fragment' };
  if (EXTERNAL.test(raw)) return { kind: 'external' };
  if (UNSUPPORTED.test(raw)) return { kind: 'unsupported' };
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { kind: 'unsupported' };
  }
  return { kind: 'local', path: decoded.split('#')[0] };
}

/**
 * Prose outside fenced blocks and inline code spans, which the serializer keeps literal. Mirrors markdownLines and
 * inlineParts in projection-host.ts; input the serializer would refuse (an unclosed span) is walked as prose.
 */
function proseParts(text) {
  const parts = [];
  let fence;
  for (const line of text.split(/(?<=\n)/)) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line),
      marker = opening?.[1];
    if (marker) {
      if (fence) {
        if (marker[0] === fence.character && marker.length >= fence.length && !opening[2].trim()) fence = undefined;
        continue;
      }
      if (marker[0] !== '`' || !opening[2].includes('`')) {
        fence = { character: marker[0], length: marker.length };
        continue;
      }
    }
    if (fence) continue;
    const ticks = /`+/g;
    let cursor = 0;
    for (let match = ticks.exec(line); match; match = ticks.exec(line)) {
      const preceding = /\\+$/.exec(line.slice(0, match.index))?.[0].length ?? 0;
      if (preceding % 2) continue;
      const start = match.index,
        length = match[0].length;
      let closing;
      do {
        closing = ticks.exec(line);
      } while (closing && closing[0].length !== length);
      if (!closing) break;
      parts.push(line.slice(cursor, start));
      cursor = ticks.lastIndex;
    }
    parts.push(line.slice(cursor));
  }
  return parts;
}

/**
 * Every link in one projected file, in order. Markdown files are walked as prose. A Codex TOML agent is walked through
 * its decoded developer_instructions, and every config_file registration is a local link. Other files carry no links.
 * Local targets are product-relative: resolved against the file's directory and normalized.
 */
export function fileLinks(file) {
  const toml = file.path.endsWith('.toml');
  if (!toml && !file.path.endsWith('.md')) return [];
  const local = (path) => posix.normalize(posix.join(posix.dirname(file.path), path)),
    found = [];
  const add = (raw) => {
    const link = classifyLink(raw);
    found.push(link.kind === 'local' ? { raw, kind: 'local', target: local(link.path) } : { raw, kind: link.kind });
  };
  const line = toml ? file.content.split('\n').find((row) => row.startsWith(INSTRUCTIONS)) : undefined;
  const text = toml ? (line === undefined ? '' : JSON.parse(line.slice(INSTRUCTIONS.length))) : file.content;
  for (const part of proseParts(text)) {
    const definition = DEFINITION.exec(part);
    if (definition) add(definition[1] ?? definition[2]);
    for (const match of part.matchAll(INLINE)) add(match[1] ?? match[2]);
  }
  if (toml)
    for (const match of file.content.matchAll(/^config_file = "([^"]+)"$/gm))
      found.push({ raw: match[1], kind: 'local', target: local(match[1]) });
  return found;
}

/**
 * Problems in a product copied under root: each unsupported destination, and each local target that is missing,
 * resolves outside root through any alias, or is not a regular file. External and fragment-only links name no file.
 */
export function linkProblems(root, files) {
  const inside = realpathSync(root) + sep,
    problems = [];
  for (const file of files)
    for (const link of fileLinks(file)) {
      if (link.kind === 'unsupported') {
        problems.push(`${file.path}: unsupported ${link.raw}`);
        continue;
      }
      if (link.kind !== 'local') continue;
      const path = join(root, link.target);
      if (!existsSync(path)) problems.push(`${file.path}: missing ${link.target}`);
      else if (!realpathSync(path).startsWith(inside)) problems.push(`${file.path}: escapes ${link.target}`);
      else if (!lstatSync(path).isFile()) problems.push(`${file.path}: not a regular file ${link.target}`);
    }
  return problems;
}

/** How many links of each kind a product holds; evidence that a walk saw the links it skipped. */
export function linkCounts(files) {
  const counts = { local: 0, external: 0, fragment: 0, unsupported: 0 };
  for (const file of files) for (const link of fileLinks(file)) counts[link.kind]++;
  return counts;
}
