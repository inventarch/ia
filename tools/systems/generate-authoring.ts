import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import { teachingLinkClasses, teachingLinkFindings } from './teaching-links.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = '.ia/src/systems/authoring-system/library.json',
  target = '.ia/authoring.resources.json';
const selection = decodeDistributionJson(readFileSync(resolve(root, source), 'utf8')) as Record<string, unknown>;
if (
  selection['format'] !== 'ia.authoring-library.v1' ||
  Object.keys(selection).sort().join(',') !== 'associations,files,format,index' ||
  !Array.isArray(selection['files']) ||
  selection['files'].length > 256
)
  throw new Error('Invalid explicit authoring library');
const seen = new Set<string>();
let total = 0;
const files = selection['files'].map((input: unknown) => {
  if (input === null || typeof input !== 'object' || Object.keys(input).join(',') !== 'path')
    throw new Error('Invalid authoring file selection');
  const path = (input as { path: unknown }).path;
  if (
    typeof path !== 'string' ||
    !path.startsWith('.ia/src/') ||
    !path.endsWith('.md') ||
    path !== path.normalize('NFC') ||
    /[\\\u0000-\u001f<>:"|?*]/.test(path) ||
    path.split('/').some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p)) ||
    seen.has(path.toLowerCase())
  )
    throw new Error('Unsafe, duplicated or non-Markdown authoring selection');
  seen.add(path.toLowerCase());
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Authoring selection crosses an alias');
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || (total += stat.size) > 16 * 1024 * 1024)
    throw new Error('Unbounded or aliased authoring file');
  const bytes = readFileSync(current);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const after = lstatSync(current);
  if (
    stat.ino !== after.ino ||
    stat.dev !== after.dev ||
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs ||
    bytes.length !== stat.size
  )
    throw new Error('Authoring file changed during generation');
  return {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'text/markdown',
    encoding: 'utf8',
  };
});
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const nativePaths = new Set<string>();
function nativeFiles(directory: string): void {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) nativeFiles(path);
    else if (entry.isFile() && path.endsWith('.ia')) nativePaths.add(path);
  }
}
nativeFiles('.ia/src');
const teaching = files.map((file) => ({ path: file.path, text: readFileSync(resolve(root, file.path), 'utf8') }));
const linkFindings = teachingLinkFindings(root, teaching, nativePaths),
  links = teachingLinkClasses(teaching);
if (linkFindings.length) throw new Error(linkFindings.join('\n'));
const output =
  JSON.stringify(
    { format: 'ia.authoring-resources.v1', files, associations: selection['associations'], index: selection['index'] },
    null,
    2,
  ) + '\n';
if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new Error('Authoring manifest exceeds its metadata ceiling');
const args = process.argv.slice(2);
if (args.length !== 1 || !['--check', '--write'].includes(args[0]!)) throw new Error('Use --check or --write');
if (args[0] === '--write') writeFileSync(resolve(root, target), output);
else if (readFileSync(resolve(root, target), 'utf8') !== output)
  throw new Error('Authoring resources changed; review the explicit library and run pnpm authoring:generate');
process.stdout.write(
  `PASS: ${files.length} explicitly selected authoring resources; ${total} bytes; ${links.required} required local links; ${links.historical} pinned historical citations.\n`,
);
