import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { localTarget, parseMarkdown } from './markdown.mjs';

const root = resolve(import.meta.dirname, '../..');
export { gitFiles } from '../../packages/runtime/src/authoring-execution/inventory.js';
import { gitFiles } from '../../packages/runtime/src/authoring-execution/inventory.js';

function collect(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collect(path, files);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
}
export function checkLinks(
  directory: string,
  files: readonly string[],
): { files: number; links: number; failures: string[] } {
  let links = 0;
  const failures: string[] = [];
  for (const file of files) {
    const path = resolve(directory, file),
      label = relative(directory, path).replaceAll('\\', '/');
    if (extname(path).toLowerCase() !== '.md') {
      failures.push(`Expected Markdown: ${label}`);
      continue;
    }
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      failures.push(`${label}: unreadable Markdown`);
      continue;
    }
    for (const { href, kind } of parseMarkdown(source).links) {
      if (kind === 'html') continue;
      let target: string | undefined;
      try {
        target = localTarget(href)?.pathname;
      } catch {
        failures.push(`${label}: invalid link encoding ${href}`);
        continue;
      }
      if (!target) continue;
      links++;
      const resolved = resolve(dirname(path), target),
        local = relative(resolve(directory), resolved).replaceAll('\\', '/');
      if (local === '..' || local.startsWith('../') || isAbsolute(local))
        failures.push(`${label}: local target escapes repository ${target}`);
      else if (!existsSync(resolved)) failures.push(`${label}: missing ${target}`);
    }
  }
  return { files: files.length, links, failures: failures.sort() };
}
if (isEntry(process.argv[1], import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      files: string[] = [];
    if (args.includes('--all')) {
      if (args.length !== 1) throw new Error('--all cannot be combined with paths');
      files.push(...gitFiles(root).filter((path) => path.toLowerCase().endsWith('.md')));
    } else if (args.length) files.push(...args);
    else collect(resolve(root, 'docs'), files);
    const result = checkLinks(root, files);
    if (result.failures.length) {
      for (const failure of result.failures) console.error(failure);
      process.exitCode = 1;
    } else
      console.log(
        `Documentation links verified: ${result.files} files, ${result.links} local targets. Anchor/lifecycle review is separate.`,
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
