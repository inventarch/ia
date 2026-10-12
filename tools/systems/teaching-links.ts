import { existsSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { localTarget, parseMarkdown } from '../docs/markdown.mjs';

/** Absolute URLs and in-page anchors are not local teaching targets. */
const NOT_LOCAL = /^[a-z][a-z0-9+.-]*:|^[#/]/i;

function teachingHrefs(text: string): string[] {
  return markdownHrefs(parseMarkdown(text));
}
const markdownHrefs = (parsed: ReturnType<typeof parseMarkdown>): string[] =>
  parsed.links.filter((link) => link.kind !== 'html').map((link) => link.href);

/** Required relative links must survive the installed native/resource closure. */
export function teachingLinkFindings(
  root: string,
  files: readonly { path: string; text: string }[],
  nativePaths: ReadonlySet<string>,
): string[] {
  const available = new Set([...nativePaths, ...files.map((file) => file.path)]),
    findings: string[] = [];
  const parsedFiles = new Map(files.map((file) => [file.path, parseMarkdown(file.text)]));
  for (const file of files) {
    const parsed = parsedFiles.get(file.path)!,
      hrefs = markdownHrefs(parsed);
    for (const href of hrefs) {
      if (NOT_LOCAL.test(href)) continue;
      let decoded: string, fragment: string;
      try {
        const local = localTarget(href);
        decoded = local?.pathname ?? '';
        fragment = local?.fragment ?? '';
      } catch {
        findings.push(`${file.path}: invalid teaching link ${href}`);
        continue;
      }
      if (!decoded) continue;
      const target = posix.normalize(posix.join(dirname(file.path).replaceAll('\\', '/'), decoded));
      if (!target.startsWith('.ia/src/') || !existsSync(resolve(root, target)) || !inClosure(available, target))
        findings.push(`${file.path}: target outside installed teaching closure: ${href}`);
      else if (fragment && parsedFiles.has(target) && !parsedFiles.get(target)!.ids.has(fragment))
        findings.push(`${file.path}: section missing from its installed teaching target: ${href}`);
    }
  }
  return findings.sort();
}

const inClosure = (available: ReadonlySet<string>, target: string): boolean =>
  available.has(target) || [...available].some((file) => file.startsWith(`${target}/`));

/** Counts installed requirements and external references without repository-specific citation policy. */
export function teachingLinkClasses(files: readonly { text: string }[]): { required: number; external: number } {
  let required = 0,
    external = 0;
  for (const file of files)
    for (const href of teachingHrefs(file.text)) {
      if (/^https?:/.test(href)) external += 1;
      else if (!NOT_LOCAL.test(href)) required += 1;
    }
  return { required, external };
}
