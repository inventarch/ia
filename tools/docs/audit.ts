import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { checkLinks, gitFiles } from './check.js';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const normalize = (value: string): string => value.replaceAll('\\', '/');
export { ownerOf } from '../../packages/runtime/src/authoring-execution/inventory.js';
import { ownerOf } from '../../packages/runtime/src/authoring-execution/inventory.js';

interface Surface {
  readonly name: string;
  readonly version?: string;
  readonly exports: readonly string[];
  readonly bins: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
}
export interface OwnerAudit {
  readonly owner: string;
  readonly spec: string;
  readonly files: number;
  readonly codeFiles: number;
  readonly testFiles: number;
  readonly digest: string;
  readonly surface?: Surface;
  readonly folders: readonly { path: string; spec: string }[];
}
const TOOL_SECTIONS = [
  'Purpose',
  'Modules',
  'Commands',
  'Inputs',
  'Outputs',
  'Prerequisites',
  'Validation',
  'Invariants',
  'Limits',
];
/** Structural minimum; semantic accuracy still requires an independent review. */
export function toolContractFindings(
  owner: string,
  source: string,
  members: readonly string[],
  references: { scripts: ReadonlySet<string>; tasks: ReadonlySet<string> } = { scripts: new Set(), tasks: new Set() },
): string[] {
  const findings = TOOL_SECTIONS.filter((section) => !source.split(/\r?\n/).includes(`## ${section}`)).map(
    (section) => `${owner}/SPEC.md: missing ${section} contract section`,
  );
  for (const member of members.filter(
    (path) => dirname(path).replaceAll('\\', '/') === owner && /\.(?:[cm]?[jt]s|json)$/.test(path),
  )) {
    const name = member.slice(owner.length + 1);
    if (!source.includes(`](${name})`)) findings.push(`${owner}/SPEC.md: module map omits ${name}`);
  }
  // These sections declare executable references. Examples and historical prose elsewhere are not commands.
  const sections = source.split(/^## /m).filter((section) => /^(?:Commands|Validation)\r?\n/.test(section));
  for (const section of sections) {
    for (const [, span] of section.matchAll(/`([^`\n]+)`/g))
      for (const [, body] of span!.matchAll(/\bpnpm\b(?:\s+([^&;|]*))?/g)) {
        const args = (body ?? '').trim().split(/\s+/).filter(Boolean);
        let index = 0;
        while (['--silent', '-s'].includes(args[index] ?? '')) index += 1;
        const explicitRun = args[index] === 'run';
        if (explicitRun) index += 1;
        while (['--silent', '-s'].includes(args[index] ?? '')) index += 1;
        const script = args[index];
        if (!script || script.startsWith('-'))
          findings.push(`${owner}/SPEC.md: unsupported pnpm root-script reference ${script ?? '(missing script)'}`);
        else if ((explicitRun || !['exec', 'install', 'store'].includes(script)) && !references.scripts.has(script))
          findings.push(`${owner}/SPEC.md: unknown pnpm script ${script}`);
      }
    for (const [, row] of section.matchAll(/^Task ownership:\s*(.+)$/gm)) {
      const declared = row!.match(/^((?:`[^`]+`(?:,\s*)?)+)\./)?.[1];
      if (!declared) findings.push(`${owner}/SPEC.md: malformed task ownership declaration`);
      for (const [, task] of (declared ?? '').matchAll(/`([^`]+)`/g))
        if (!references.tasks.has(task!)) findings.push(`${owner}/SPEC.md: unknown task ${task}`);
    }
  }
  return [...new Set(findings)];
}
export function auditRepository(root: string, inventory: readonly string[] = gitFiles(root)) {
  const files = [...new Set(inventory)].sort(),
    present = new Set(files),
    failures: string[] = [];
  const groups = new Map<string, string[]>([['.', []]]),
    digests = new Map<string, string>(),
    safe = new Set<string>();
  for (const path of files) {
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '..' || part === '.') ||
      /^[A-Za-z]:/.test(path)
    ) {
      failures.push(`${path}: noncanonical inventory path`);
      continue;
    }
    try {
      // Refuse aliases at every ancestor, not only at the leaf.
      let relative = '';
      for (const part of path.split('/')) {
        relative = relative ? `${relative}/${part}` : part;
        if (lstatSync(resolve(root, relative)).isSymbolicLink()) throw new Error('alias');
      }
      if (!lstatSync(resolve(root, path)).isFile()) throw new Error('non-file');
      digests.set(path, hash(readFileSync(resolve(root, path))));
      safe.add(path);
    } catch {
      failures.push(`${path}: missing, unreadable or aliased inventory file`);
    }
    const owner = ownerOf(path);
    if (owner === undefined) {
      failures.push(`${path}: no declared ownership area`);
      continue;
    }
    const group = groups.get(owner) ?? [];
    group.push(path);
    groups.set(owner, group);
  }
  for (const path of files.filter((path) => safe.has(path) && (path === 'SPEC.md' || path.endsWith('/SPEC.md')))) {
    if (!/^#\s+\S/m.test(readFileSync(resolve(root, path), 'utf8')))
      failures.push(`${path}: empty or untitled contract`);
  }
  const references = { scripts: new Set<string>(), tasks: new Set<string>() };
  for (const path of ['package.json', 'tools/testing/tasks.json']) {
    if (!safe.has(path)) continue;
    try {
      const value = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as {
        scripts?: Record<string, unknown>;
        tasks?: { id?: unknown }[];
      };
      if (path === 'package.json') {
        for (const script of Object.keys(value.scripts ?? {})) references.scripts.add(script);
      } else if (Array.isArray(value.tasks)) {
        for (const task of value.tasks) if (typeof task.id === 'string') references.tasks.add(task.id);
      }
    } catch {
      failures.push(`${path}: unreadable command reference manifest`);
    }
  }
  const owners: OwnerAudit[] = [];
  for (const [owner, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const spec = owner === '.' ? 'SPEC.md' : `${owner}/SPEC.md`;
    if (!present.has(spec) || !safe.has(spec)) failures.push(`${owner}: missing colocated SPEC.md`);
    else if (/^tools\/[^/]+$/.test(owner))
      failures.push(...toolContractFindings(owner, readFileSync(resolve(root, spec), 'utf8'), members, references));
    const directories = new Set<string>([owner]);
    for (const member of members) {
      let directory = normalize(dirname(member));
      while (directory !== '.' && (owner === '.' || directory === owner || directory.startsWith(`${owner}/`))) {
        directories.add(directory);
        directory = normalize(dirname(directory));
      }
    }
    const folders = [...directories].sort().map((path) => {
      let current = path,
        inherited = spec;
      while (current !== '.' && (owner === '.' || current === owner || current.startsWith(`${owner}/`))) {
        if (present.has(`${current}/SPEC.md`) && safe.has(`${current}/SPEC.md`)) {
          inherited = `${current}/SPEC.md`;
          break;
        }
        current = normalize(dirname(current));
      }
      return { path, spec: inherited };
    });
    let surface: Surface | undefined;
    const manifestPath = owner === '.' ? 'package.json' : `${owner}/package.json`;
    if (safe.has(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as {
          name: string;
          version?: string;
          exports?: Record<string, unknown> | string;
          bin?: Record<string, string> | string;
          dependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        if (typeof manifest.name !== 'string' || !manifest.name) throw new Error('name');
        surface = {
          name: manifest.name,
          ...(manifest.version === undefined ? {} : { version: manifest.version }),
          exports: typeof manifest.exports === 'string' ? ['.'] : Object.keys(manifest.exports ?? {}).sort(),
          bins: typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {}),
          dependencies: Object.keys({
            ...manifest.dependencies,
            ...manifest.optionalDependencies,
            ...manifest.peerDependencies,
          }).sort(),
        };
      } catch {
        failures.push(`${manifestPath}: invalid package metadata`);
      }
    }
    owners.push({
      owner,
      spec,
      files: members.length,
      codeFiles: members.filter((path) => /\.[cm]?[jt]sx?$/.test(path)).length,
      testFiles: members.filter((path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)).length,
      digest: hash(JSON.stringify(members.map((path) => [path, digests.get(path) ?? null]))),
      ...(surface ? { surface } : {}),
      folders,
    });
  }
  const markdown = checkLinks(
    root,
    files.filter((path) => safe.has(path) && path.toLowerCase().endsWith('.md')),
  );
  failures.push(...markdown.failures);
  return {
    version: 1,
    scope: 'git-tracked-and-nonignored-untracked',
    files: files.length,
    digest: hash(JSON.stringify(files.map((path) => [path, digests.get(path) ?? null]))),
    markdown: { files: markdown.files, links: markdown.links },
    owners,
    failures: failures.sort(),
    limitations: [
      'File-target links only; anchors, HTML links and lifecycle require review.',
      'SPEC presence/inheritance and declared package surfaces do not prove semantic agreement or executed product acceptance.',
      'Ignored outputs and local scratch state are excluded; use owning build/generator/host checks.',
    ],
  };
}
if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error('Usage: pnpm docs:audit [--json]');
    process.exitCode = 2;
  } else
    try {
      const result = auditRepository(resolve(import.meta.dirname, '../..'));
      if (args[0] === '--json') console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `Repository coverage: ${result.files} files, ${result.owners.length} owners, ${result.markdown.files} Markdown files, ${result.markdown.links} local targets.`,
        );
        for (const failure of result.failures) console.error(failure);
        console.log(
          result.failures.length
            ? `FAIL: ${result.failures.length} findings.`
            : 'PASS: owner SPEC coverage and file-target links. Semantic consistency requires the recorded review.',
        );
      }
      if (result.failures.length) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
