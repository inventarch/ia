import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { posix, resolve } from 'node:path';
import { canonAssessment, executingKitSystems, isKitWorkspace } from '@inventarch/compliance';
import type { Assessment, Finding } from '@inventarch/compliance';
import type { Graph, Node } from '@inventarch/graph';
import { decodeDistributionLock, decodeReleaseDescriptor } from '../distribution/contracts.js';
import { localTarget, scanMarkdown } from './links.js';

/** The directories no canon file walk enters. */
const SKIPPED: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git']);
/** Runtime state under any `.ia/` (the root's, or a nested workspace's): never a source root, never shipped. */
const RUNTIME_STATE = /(?:^|\/)\.ia\/(?:distributions|work)$/;
const isRuntimeState = (path: string): boolean => RUNTIME_STATE.test(path);
const SOURCE = '.ia/src';
const KB_KIT = 'inventarch/ia-kb-kit';

/** `\` is a separator in every path these rules compare. */
const slashed = (path: string): string => path.split(String.fromCharCode(92)).join('/');
const DRIVE = /^[A-Za-z]:(?=\/|$)/;
const isAbsolutePath = (path: string): boolean => path.startsWith('/') || DRIVE.test(path);
/**
 * A path as the rules compare it: `/`-separated, case preserved. An absolute path is made relative to the root when
 * both are absolute (a drive letter is dropped from the two together, never from one), else it is kept as given.
 */
export function relativeTo(root: string, path: string): string {
  const spelled = posix.normalize(slashed(path)),
    base = slashed(root).replace(/\/+$/, '');
  if (!isAbsolutePath(spelled) || !isAbsolutePath(base)) return spelled.replace(/^\.\//, '');
  const [from, to] = [base.replace(DRIVE, ''), spelled.replace(DRIVE, '')];
  return to === from ? '' : to.startsWith(from + '/') ? to.slice(from.length + 1) : spelled;
}

function entries(directory: string): readonly Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    return [];
  }
}

/** A `.git` entry (directory, or the file a worktree has) is the boundary of a separate checkout. */
const isSeparateCheckout = (root: string, path: string): boolean =>
  entries(resolve(root, path)).some((child) => child.name === '.git');

/**
 * Every file under `directory` as a root-relative `/` path, in order; links are not followed. `node_modules`, `dist`,
 * `.git` and runtime state at any depth are skipped; `bounded` also stops at separate checkouts.
 */
function walkFiles(root: string, directory: string, bounded = false): readonly string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of entries(resolve(root, relative))) {
      if (SKIPPED.has(entry.name)) continue;
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory() && (isRuntimeState(path) || (bounded && isSeparateCheckout(root, path)))) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  visit(directory);
  return found;
}

/** The Markdown files under `<root>/.ia/src`, as root-relative paths. */
export function teachingFiles(root: string): readonly string[] {
  return walkFiles(root, SOURCE).filter((path) => path.endsWith('.md'));
}

const closed = (available: ReadonlySet<string>, target: string): boolean =>
  available.has(target) || [...available].some((file) => file.startsWith(`${target}/`));

/** Absolute URLs (a scheme, or a `//` network path) and in-page anchors are not local teaching targets. */
const NOT_LOCAL = /^[a-z][a-z0-9+.-]*:|^#|^\/\//i;

/**
 * C12 over documents already read: a relative link must stay under `.ia/src/`, exist and be in the installed closure
 * (`nativePaths` and the documents themselves). A root-relative `/x` link leaves `.ia/src/` and is reported; absolute
 * URLs and `#` anchors are skipped. Paths are `/` paths.
 */
export function teachingLinkFindings(
  files: readonly { readonly path: string; readonly text: string }[],
  nativePaths: ReadonlySet<string>,
  exists: (path: string) => boolean,
): readonly Finding[] {
  const available = new Set([...nativePaths, ...files.map((file) => file.path)]),
    parsed = new Map(files.map((file) => [file.path, scanMarkdown(file.text)])),
    found: Finding[] = [];
  const report = (path: string, line: number, message: string): void => {
    found.push({ code: 'IA-COMP-CANON-TEACHING-LINKS', path, line, severity: 'error', message: `${path}: ${message}` });
  };
  for (const file of files) {
    for (const link of parsed.get(file.path)!.links) {
      if (link.kind === 'html' || NOT_LOCAL.test(link.href)) continue;
      if (link.href.startsWith('/')) {
        report(file.path, link.line, `target outside installed teaching closure: ${link.href}`);
        continue;
      }
      let pathname: string, fragment: string;
      try {
        const local = localTarget(link.href);
        pathname = slashed(local?.pathname ?? '');
        fragment = local?.fragment ?? '';
      } catch {
        report(file.path, link.line, `invalid teaching link ${link.href}`);
        continue;
      }
      if (pathname === '') continue;
      const target = posix.normalize(posix.join(posix.dirname(file.path), pathname));
      if (!target.startsWith(SOURCE + '/') || !exists(target) || !closed(available, target))
        report(file.path, link.line, `target outside installed teaching closure: ${link.href}`);
      else if (fragment !== '' && parsed.has(target) && !parsed.get(target)!.ids.has(fragment))
        report(file.path, link.line, `section missing from its installed teaching target: ${link.href}`);
    }
  }
  return found.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
}

/**
 * C12: the teaching documents `files` (root-relative or absolute under `root`) read from disk, their links checked
 * against the files under `<root>/.ia/src` (plus `nativePaths`) as the installed closure.
 */
export function canonTeachingLinks(
  root: string,
  files: readonly string[],
  nativePaths: ReadonlySet<string>,
): readonly Finding[] {
  const documents: { path: string; text: string }[] = [];
  for (const file of files) {
    const path = relativeTo(root, file);
    try {
      documents.push({ path, text: readFileSync(resolve(root, path), 'utf8') });
    } catch {
      // A listed file that cannot be read has no links to check.
    }
  }
  const installed = new Set([...walkFiles(root, SOURCE), ...[...nativePaths].map((path) => relativeTo(root, path))]);
  return teachingLinkFindings(documents, installed, (path) => existsSync(resolve(root, path)));
}

/**
 * A nested `.ia/` is released when its `release.json` decodes as a release descriptor, or adopted when its
 * `distributions.lock.json` decodes as a lock installing at least one package or entry. An empty or malformed file
 * exempts nothing.
 */
function releasedOrAdopted(root: string, ia: string): boolean {
  const read = (name: string): string | null => {
    try {
      return readFileSync(resolve(root, ia, name), 'utf8');
    } catch {
      return null;
    }
  };
  const descriptor = read('release.json'),
    lock = read('distributions.lock.json');
  if (descriptor !== null)
    try {
      decodeReleaseDescriptor(descriptor);
      return true;
    } catch {
      // Not a release descriptor; the lock may still adopt the root.
    }
  if (lock !== null)
    try {
      const decoded = decodeDistributionLock(lock);
      return decoded.packages.length + (decoded.entries?.length ?? 0) > 0;
    } catch {
      // Not a lock.
    }
  return false;
}

/** Every `.ia/src` directory below `root` other than `<root>/.ia/src`, as a root-relative path. */
function nestedSources(root: string): readonly string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    const here = relative === '' ? '' : `${relative}/`;
    for (const entry of entries(resolve(root, relative))) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue;
      const path = `${here}${entry.name}`;
      if (isRuntimeState(path) || isSeparateCheckout(root, path)) continue;
      const children = entries(resolve(root, path));
      if (entry.name === '.ia') {
        if (
          path !== '.ia' &&
          children.some((child) => child.isDirectory() && child.name === 'src') &&
          !releasedOrAdopted(root, path)
        )
          found.push(`${path}/src`);
      }
      visit(path);
    }
  };
  visit('');
  return found;
}

/**
 * A6: a `.ia/src` below `root` other than `<root>/.ia/src` is reported unless its `.ia/` holds a `release.json` that
 * decodes or a `distributions.lock.json` that decodes with an entry. Active in a kit or a knowledge repository
 * (`scope`), else nothing.
 */
export function canonSourceRoots(root: string, scope: 'kit' | 'knowledge' | null): readonly Finding[] {
  if (scope === null) return [];
  return nestedSources(root).map(
    (path): Finding => ({
      code: 'IA-COMP-CANON-SOURCE-ROOTS',
      path,
      line: 1,
      severity: 'error',
      message: `${path}: A ${scope === 'kit' ? 'kit' : 'knowledge repository'} authors one .ia/src; this nested root is neither released nor adopted.`,
    }),
  );
}

/** A script extension, matched case-insensitively. */
const SCRIPT = /\.(?:mjs|cjs|js|ts|mts|cts|tsx|jsx|py|rb|sh|bash|zsh|ps1|psm1|cmd|bat)$/i;

/**
 * The files `<root>/.ia/release.json` declares under `assets`, as the marketplace kit loader reads them
 * (`plugins/ia/scripts/lib/kit.mjs` `declaredAssets`): each `assets[].path`, resolved against the root. An asset that is
 * absolute, leaves the root or names no regular file is not shipped and so not listed; a descriptor that does not
 * parse declares none. C6 is not the descriptor's validator.
 */
function declaredAssets(root: string): readonly string[] {
  let assets: unknown;
  try {
    assets = (JSON.parse(readFileSync(resolve(root, '.ia/release.json'), 'utf8')) as { assets?: unknown }).assets;
  } catch {
    return [];
  }
  if (!Array.isArray(assets)) return [];
  const found = new Set<string>();
  for (const asset of assets) {
    const path: unknown = (asset as { path?: unknown } | null)?.path;
    if (typeof path !== 'string' || path === '' || isAbsolutePath(slashed(path))) continue;
    const spelled = posix.normalize(slashed(path));
    if (spelled === '.' || spelled === '..' || spelled.startsWith('../')) continue;
    try {
      if (statSync(resolve(root, spelled)).isFile()) found.add(spelled);
    } catch {
      // A declared asset that is missing is not shipped.
    }
  }
  return [...found].sort();
}

/**
 * The files a kit ships, as marketplace `lib/kit.mjs` packs and digests them: everything under `<root>/.ia/` (the walk
 * skips `node_modules`, `dist`, `.git`, runtime state such as `.ia/distributions` and `.ia/work` at any depth, and
 * separate checkouts) plus the assets `.ia/release.json` declares. Tests, fixtures and scripts the descriptor does not
 * declare stay home.
 */
function shippedFiles(root: string): readonly string[] {
  return [...new Set([...walkFiles(root, '.ia', true), ...declaredAssets(root)])].sort();
}

/**
 * C6: a kit ships no scripts. A shipped file (`shippedFiles`: anything under `.ia/` but runtime state, plus the declared
 * assets) with a script extension is reported unless it sits under `.ia/src/systems/<allowed>/` (the folders of the
 * executing systems, dec-040 A). Nothing outside a kit.
 */
export function canonKitScripts(
  root: string,
  isKit: boolean,
  allowedSystems: readonly string[] = [],
): readonly Finding[] {
  if (!isKit) return [];
  const folders = allowedSystems.map((name) => `${SOURCE}/systems/${name}/`);
  return shippedFiles(root)
    .filter((path) => SCRIPT.test(path) && !folders.some((folder) => path.startsWith(folder)))
    .map(
      (path): Finding => ({
        code: 'IA-COMP-CANON-KIT-SCRIPTS',
        path,
        line: 1,
        severity: 'error',
        message: `${path}: A kit holds no scripts; move this file into the folder of an executing system or remove it.`,
      }),
    );
}

export interface CanonFileOptions {
  /** The Markdown documents C12 reads (default: every `.md` under `<root>/.ia/src`). */
  readonly files?: readonly string[];
  /** The graph whose resolved `enforce` edges decide which laws are enforced. */
  readonly graph?: Graph;
  /** The packages the lock installs, as the db reader returns them; one with the knowledge kit's id sets scope 'knowledge'. */
  readonly installed?: readonly { readonly id: string }[];
}

/** A6's scope: a kit, else a knowledge repository (the lock installs the knowledge kit), else none. */
export function sourceRootScope(
  nodes: readonly Node[],
  installed: readonly { readonly id: string }[] = [],
): 'kit' | 'knowledge' | null {
  return isKitWorkspace(nodes) ? 'kit' : installed.some((p) => p.id === KB_KIT) ? 'knowledge' : null;
}

/** The file-based canon rules C12, A6 and C6 as assessments, each active only when a law enforces a check that runs it. */
export function canonFileAssessments(
  root: string,
  nodes: readonly Node[],
  options: CanonFileOptions = {},
): readonly Assessment[] {
  const { files, graph, installed } = options;
  return [
    canonAssessment(
      nodes,
      'CANON-TEACHING-LINKS',
      () => canonTeachingLinks(root, files ?? teachingFiles(root), new Set()),
      graph,
    ),
    canonAssessment(
      nodes,
      'CANON-SOURCE-ROOTS',
      () => canonSourceRoots(root, sourceRootScope(nodes, installed)),
      graph,
    ),
    canonAssessment(
      nodes,
      'CANON-KIT-SCRIPTS',
      () => canonKitScripts(root, isKitWorkspace(nodes), executingKitSystems(nodes)),
      graph,
    ),
  ].flatMap((assessment) => assessment ?? []);
}
