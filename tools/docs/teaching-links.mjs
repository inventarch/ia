import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { teachingLinkFindings as canonTeachingLinkFindings } from '@inventarch/db';
import { parseMarkdown } from './markdown.mjs';

/** Absolute URLs and in-page anchors are not local teaching targets. */
const NOT_LOCAL = /^[a-z][a-z0-9+.-]*:|^[#/]/i;
/** @param {ReturnType<typeof parseMarkdown>} parsed */
const markdownHrefs = (parsed) => parsed.links.filter((link) => link.kind !== 'html').map((link) => link.href);
/** Required relative links must survive the installed native/resource closure. A generator may supply its pending view.
 * C12 lives in `@inventarch/db` (`teachingLinkFindings`), where the `CANON-TEACHING-LINKS` check reads it too.
 * @param {string} root @param {readonly {path: string, text: string}[]} files @param {ReadonlySet<string>} nativePaths
 * @param {(path: string) => boolean} [exists] @returns {string[]}
 */
export function teachingLinkFindings(root, files, nativePaths, exists = (path) => existsSync(resolve(root, path))) {
  return canonTeachingLinkFindings(files, nativePaths, exists)
    .map((finding) => finding.message)
    .sort();
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
