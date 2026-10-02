import { existsSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { localTarget, parseMarkdown } from '../docs/markdown.mjs';

/** Links into these private repositories are historical citations: an installed reader may lack the credentials to follow them. */
const REPOSITORY = String.raw`(crowncodes\/ia|crowncodes\/ia-apps|inventarch\/api)`;
const PRIVATE_LINK = new RegExp(
  String.raw`^https?:\/\/(?:www\.)?(?:github\.com\/${REPOSITORY}(?:[/?#]|$)|raw\.githubusercontent\.com\/${REPOSITORY}\/)`,
  'i',
);
const PINNED_SOURCE = new RegExp(
  String.raw`^https?:\/\/(?:(?:www\.)?github\.com\/${REPOSITORY}\/(?:blob|tree|raw)|raw\.githubusercontent\.com\/${REPOSITORY})\/[0-9a-f]{40}(?:\/([^?#]*))?(?:[?#]|$)`,
  'i',
);
/** Absolute URLs and in-page anchors are not local teaching targets. */
const NOT_LOCAL = /^[a-z][a-z0-9+.-]*:|^[#/]/i;

function teachingHrefs(text: string): string[] {
  return parseMarkdown(text)
    .links.filter((link) => link.kind !== 'html')
    .map((link) => link.href);
}

/**
 * Required instruction is a relative link and must survive the installed native/resource closure.
 * A private-source citation is historical: it must pin a commit and must not stand in for a target the closure ships.
 */
export function teachingLinkFindings(
  root: string,
  files: readonly { path: string; text: string }[],
  nativePaths: ReadonlySet<string>,
): string[] {
  const available = new Set([...nativePaths, ...files.map((file) => file.path)]),
    findings: string[] = [];
  for (const file of files)
    for (const href of teachingHrefs(file.text)) {
      if (PRIVATE_LINK.test(href)) {
        const citation = PINNED_SOURCE.exec(href);
        if (!citation)
          findings.push(
            `${file.path}: private-repository link must be a source citation pinned to a full commit: ${href}`,
          );
        else if (
          (citation[1] ?? citation[2])!.toLowerCase() === 'crowncodes/ia' &&
          shipped(available, citation[3] ?? '')
        )
          findings.push(
            `${file.path}: required target ships in the installed teaching closure; link it relatively: ${href}`,
          );
        continue;
      }
      if (NOT_LOCAL.test(href)) continue;
      let decoded: string;
      try {
        decoded = localTarget(href)?.pathname ?? '';
      } catch {
        findings.push(`${file.path}: invalid teaching link ${href}`);
        continue;
      }
      if (!decoded) continue;
      const target = posix.normalize(posix.join(dirname(file.path).replaceAll('\\', '/'), decoded));
      if (!target.startsWith('.ia/src/') || !existsSync(resolve(root, target)) || !inClosure(available, target))
        findings.push(`${file.path}: target outside installed teaching closure: ${href}`);
    }
  return findings.sort();
}

const inClosure = (available: ReadonlySet<string>, target: string): boolean =>
  available.has(target) || [...available].some((file) => file.startsWith(`${target}/`));

/** A citation path names a shipped file or directory once decoded; an undecodable path cannot name one. */
function shipped(available: ReadonlySet<string>, path: string): boolean {
  try {
    return inClosure(available, decodeURIComponent(path).replace(/\/+$/, ''));
  } catch {
    return false;
  }
}

/** Counts each class so a generator can report how much teaching still leans on private history. */
export function teachingLinkClasses(files: readonly { text: string }[]): { required: number; historical: number } {
  let required = 0,
    historical = 0;
  for (const file of files)
    for (const href of teachingHrefs(file.text)) {
      if (PRIVATE_LINK.test(href)) historical += 1;
      else if (!NOT_LOCAL.test(href)) required += 1;
    }
  return { required, historical };
}
