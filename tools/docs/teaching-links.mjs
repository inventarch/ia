import { existsSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { localTarget, parseMarkdown } from './markdown.mjs';

/** Absolute URLs and in-page anchors are not local teaching targets. */
const NOT_LOCAL = /^[a-z][a-z0-9+.-]*:|^[#/]/i;
/** @param {ReturnType<typeof parseMarkdown>} parsed */
const markdownHrefs = (parsed) => parsed.links.filter((link) => link.kind !== 'html').map((link) => link.href);
/** @param {ReadonlySet<string>} available @param {string} target */
const inClosure = (available, target) =>
  available.has(target) || [...available].some((file) => file.startsWith(`${target}/`));

/** Required relative links must survive the installed native/resource closure. A generator may supply its pending view.
 * @param {string} root @param {readonly {path: string, text: string}[]} files @param {ReadonlySet<string>} nativePaths
 * @param {(path: string) => boolean} [exists] @returns {string[]}
 */
export function teachingLinkFindings(root, files, nativePaths, exists = (path) => existsSync(resolve(root, path))) {
  const available = new Set([...nativePaths, ...files.map((file) => file.path)]),
    findings = [];
  const parsedFiles = new Map(files.map((file) => [file.path, parseMarkdown(file.text)]));
  for (const file of files) {
    const parsed = parsedFiles.get(file.path);
    if (!parsed) throw new Error('Missing parsed teaching document');
    for (const href of markdownHrefs(parsed)) {
      if (NOT_LOCAL.test(href)) continue;
      let decoded, fragment;
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
      if (!target.startsWith('.ia/src/') || !exists(target) || !inClosure(available, target))
        findings.push(`${file.path}: target outside installed teaching closure: ${href}`);
      else if (fragment && parsedFiles.has(target) && !parsedFiles.get(target)?.ids.has(fragment))
        findings.push(`${file.path}: section missing from its installed teaching target: ${href}`);
    }
  }
  return findings.sort();
}

/** Counts installed requirements and external references without repository-specific citation policy.
 * @param {readonly {text: string}[]} files
 */
export function teachingLinkClasses(files) {
  let required = 0,
    external = 0;
  for (const file of files)
    for (const href of markdownHrefs(parseMarkdown(file.text))) {
      if (/^https?:/.test(href)) external += 1;
      else if (!NOT_LOCAL.test(href)) required += 1;
    }
  return { required, external };
}
