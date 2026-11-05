#!/usr/bin/env node
/**
 * Generates apps/cli/src/console/width-table.ts, the display-width tables of the console's one width function, from
 * three Unicode Character Database files of one pinned version. The sources are vendored unmodified under
 * tools/unicode/<version>/, so regeneration needs no network; each file's byte count and SHA-256 are pinned here and a
 * mismatch aborts. No dependency: Node built-ins only.
 *
 *   node tools/unicode/generate-width-table.mjs            regenerate the committed table
 *   node tools/unicode/generate-width-table.mjs --check    exit 1 when the committed table differs by one byte
 *   node tools/unicode/generate-width-table.mjs --from <dir>   read the sources from another directory
 *   node tools/unicode/generate-width-table.mjs --download     fetch the sources into the vendored directory first
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../entry/is-entry.mjs';

export const UNICODE_VERSION = '16.0.0';
export const BASE_URL = `https://www.unicode.org/Public/${UNICODE_VERSION}/`;
/** The three sources, by their path under BASE_URL, with the byte count and SHA-256 recorded when they were vendored. */
export const SOURCES = [
  {
    path: 'ucd/EastAsianWidth.txt',
    bytes: 199042,
    sha256: '43adc76c0686a42cb370764eb8cfe2b2a45b10b855e5572a2db4a0eecce15d5b',
  },
  {
    path: 'ucd/emoji/emoji-data.txt',
    bytes: 113024,
    sha256: 'f1365a5173eee18e1f98b240cdc492e84a25f1ce7e0c9d1094eb29c41a22696a',
  },
  {
    path: 'ucd/extracted/DerivedGeneralCategory.txt',
    bytes: 274423,
    sha256: '7676ab755a41ef82108460238569e60ad65c191ddafe61b36c6765ec1353f293',
  },
];
/** A merged table larger than this means the merge went wrong. */
export const MAX_BYTES = 32 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
export const VENDORED = resolve(here, UNICODE_VERSION);
export const TARGET = resolve(repository, 'apps/cli/src/console/width-table.ts');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** `XXXX` or `XXXX..YYYY ; value` rows whose value passes `accept`, as [first, last] code points in file order. */
export function parseRanges(text, accept) {
  const ranges = [];
  for (const line of text.split('\n')) {
    const data = line.split('#', 1)[0].trim();
    if (data === '') continue;
    const [points, value] = data.split(';').map((part) => part.trim());
    if (!accept(value)) continue;
    const [first, last = first] = points.split('..');
    ranges.push([Number.parseInt(first, 16), Number.parseInt(last, 16)]);
  }
  return ranges;
}
/** Sorted, with overlapping and adjacent ranges joined. */
export function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [first, last] of sorted) {
    const previous = out[out.length - 1];
    if (previous !== undefined && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else out.push([first, last]);
  }
  return out;
}

/** The emitted sets, in the order the file declares them, each with the source it is read from. */
export function tables(texts) {
  const width = texts['ucd/EastAsianWidth.txt'],
    emoji = texts['ucd/emoji/emoji-data.txt'],
    category = texts['ucd/extracted/DerivedGeneralCategory.txt'];
  return {
    WIDE: merge(parseRanges(width, (value) => value === 'W' || value === 'F')),
    EMOJI_PRESENTATION: merge(parseRanges(emoji, (value) => value === 'Emoji_Presentation')),
    EMOJI: merge(parseRanges(emoji, (value) => value === 'Emoji')),
    EMOJI_MODIFIER: merge(parseRanges(emoji, (value) => value === 'Emoji_Modifier')),
    ZERO: merge(parseRanges(category, (value) => value === 'Mn' || value === 'Me' || value === 'Cf')),
    CONTROL: merge(parseRanges(category, (value) => value === 'Cc')),
  };
}

const hex = (point) => `0x${point.toString(16)}`;
const name = (point) => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;

/** The text of width-table.ts for the given source texts, keyed by their path under BASE_URL. Pure. */
export function build(texts) {
  const sets = tables(texts);
  const sources = SOURCES.map(({ path }) => {
    const text = texts[path];
    return `//   ${BASE_URL}${path}\n//     ${Buffer.byteLength(text, 'utf8')} bytes, sha256 ${sha256(text)}`;
  });
  const summary = Object.entries(sets).map(
    ([set, ranges]) =>
      `//   ${set}: ${ranges.length} ranges, ${name(ranges[0][0])} to ${name(ranges[ranges.length - 1][1])}`,
  );
  // Laid out as the repository's formatter lays it out: a single range on one line, several one per line.
  const body = Object.entries(sets).map(([set, ranges]) =>
    ranges.length === 1
      ? `export const ${set}: readonly Range[] = [[${hex(ranges[0][0])}, ${hex(ranges[0][1])}]];`
      : `export const ${set}: readonly Range[] = [\n${ranges.map(([a, b]) => `  [${hex(a)}, ${hex(b)}],`).join('\n')}\n];`,
  );
  const render = (size) =>
    [
      `// Unicode ${UNICODE_VERSION} display-width tables for the console's width function (width.ts).`,
      '// generated by tools/unicode/generate-width-table.mjs; do not edit.',
      '// License: Unicode License v3; see THIRD_PARTY_NOTICES.txt.',
      '// Sources:',
      ...sources,
      '// Sets:',
      ...summary,
      `// Emitted: ${size} bytes`,
      '',
      '/** An inclusive range of code points. */',
      'export type Range = readonly [number, number];',
      `export const UNICODE_VERSION = '${UNICODE_VERSION}';`,
      ...body,
      '',
    ].join('\n');
  // The header names the file's own size, which depends on the digits it takes: settle on the fixed point.
  let size = 0,
    text = render(size);
  while (Buffer.byteLength(text, 'utf8') !== size) {
    size = Buffer.byteLength(text, 'utf8');
    text = render(size);
  }
  if (size > MAX_BYTES) throw new Error(`the table is ${size} bytes, over ${MAX_BYTES}; the merge went wrong`);
  return text;
}

/** The sources read from `directory`, refused unless each has its pinned byte count and SHA-256. */
export function readSources(directory) {
  const texts = {};
  for (const { path, bytes, sha256: pinned } of SOURCES) {
    const buffer = readFileSync(resolve(directory, path));
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (buffer.length !== bytes || digest !== pinned)
      throw new Error(
        `${path}: ${buffer.length} bytes, sha256 ${digest}; pinned ${bytes} bytes, sha256 ${pinned} (Unicode ${UNICODE_VERSION})`,
      );
    texts[path] = buffer.toString('utf8');
  }
  return texts;
}

/**
 * Fetches every source, and writes them only once each has its pinned byte count and SHA-256, so nothing unverified
 * from the network ever reaches the disk.
 */
async function download(directory) {
  const verified = [];
  for (const { path, bytes, sha256: pinned } of SOURCES) {
    const response = await fetch(BASE_URL + path);
    if (!response.ok) throw new Error(`${BASE_URL}${path}: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (buffer.length !== bytes || digest !== pinned)
      throw new Error(
        `${BASE_URL}${path}: ${buffer.length} bytes, sha256 ${digest}; pinned ${bytes} bytes, sha256 ${pinned}; nothing was written`,
      );
    verified.push({ path, buffer });
  }
  for (const { path, buffer } of verified) {
    const file = resolve(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buffer);
  }
}

async function main(argv) {
  const check = argv.includes('--check');
  const fromIndex = argv.indexOf('--from');
  const from = fromIndex === -1 ? VENDORED : resolve(argv[fromIndex + 1] ?? '');
  if (fromIndex !== -1 && argv[fromIndex + 1] === undefined) throw new Error('--from needs a directory');
  if (argv.includes('--download')) await download(VENDORED);
  const text = build(readSources(from));
  if (check) {
    let committed = '';
    try {
      committed = readFileSync(TARGET, 'utf8');
    } catch {
      committed = '';
    }
    if (committed !== text) {
      process.stderr.write(
        `${TARGET} differs from its regeneration; run node tools/unicode/generate-width-table.mjs\n`,
      );
      return 1;
    }
    process.stdout.write(`${TARGET} matches Unicode ${UNICODE_VERSION}\n`);
    return 0;
  }
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, text);
  process.stdout.write(`wrote ${TARGET} (${Buffer.byteLength(text, 'utf8')} bytes)\n`);
  return 0;
}

if (isEntry(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
