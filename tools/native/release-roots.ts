import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../packages/language/src/index.js';
import { isEntry } from '../entry/is-entry.mjs';

export const WORKSPACE_PATH = '.ia/src/workspace.ia';
export const RELEASE_ROOTS_PATH = '.ia/src/releases/language-distribution.ia';

/** Preserve the public distribution identity while deriving membership from the source-declaring workspace. */
export function releaseRoots(source: string): string {
  const parsed = parse(source, WORKSPACE_PATH);
  const records = parsed.ast.records;
  if (
    parsed.diagnostics.some((finding) => finding.severity === 'error') ||
    records.length !== 1 ||
    records[0]!.discriminator !== 'workspace' ||
    records[0]!.name !== 'language-workspace'
  )
    throw new Error('Release roots require exactly the maintained language-workspace declaration');
  const composition = records[0]!.sections.filter((section) => section.name === 'composition');
  const fields = composition
    .flatMap((section) => section.children)
    .filter((field) => field.kind === 'field' && field.key === 'systems');
  const field = fields[0];
  if (
    composition.length !== 1 ||
    fields.length !== 1 ||
    field?.kind !== 'field' ||
    field.when !== undefined ||
    field.children.length !== 0 ||
    field.value.kind !== 'list' ||
    field.value.items.length === 0
  )
    throw new Error('Release roots require one unconditional, nonempty composition.systems list');
  const names = field.value.items.map((item) => {
    if (item.kind !== 'ref' || item.discriminator !== 'system' || item.fragment !== undefined)
      throw new Error('Release roots must be whole system references');
    return item.name.toLowerCase();
  });
  if (new Set(names).size !== names.length) throw new Error('Release roots must be unique');
  return [
    '#! ia 1.0',
    '# Generated from workspace.ia composition.systems by pnpm release-roots:generate.',
    '',
    '@distribution language-distribution',
    '  meaning',
    '    says "The root of the public language vocabulary closure."',
    '    answers "Which systems form the public language distribution?"',
    '  distribution',
    '    records [' +
      names
        .sort()
        .map((name) => '@system ' + name)
        .join(', ') +
      ']',
    '',
  ].join('\n');
}

export function releaseRootFindings(
  root: string,
  read = (path: string) => readFileSync(resolve(root, path), 'utf8'),
): readonly { code: string; path: string; message: string }[] {
  try {
    const expected = releaseRoots(read(WORKSPACE_PATH));
    if (read(RELEASE_ROOTS_PATH) === expected) return [];
    return [
      {
        code: 'IA-NATIVE-RELEASE-ROOTS',
        path: RELEASE_ROOTS_PATH,
        message: 'Distribution roots drifted; run pnpm release-roots:generate.',
      },
    ];
  } catch {
    return [
      {
        code: 'IA-NATIVE-RELEASE-ROOTS',
        path: RELEASE_ROOTS_PATH,
        message: 'Release roots require a readable distribution and one valid maintained workspace system list.',
      },
    ];
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--write', '--check'].includes(args[0]!)) throw new Error('Expected --write or --check');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (args[0] === '--write')
    writeFileSync(resolve(root, RELEASE_ROOTS_PATH), releaseRoots(readFileSync(resolve(root, WORKSPACE_PATH), 'utf8')));
  const findings = releaseRootFindings(root);
  if (findings.length) {
    process.stderr.write(JSON.stringify(findings, null, 2) + '\n');
    process.exitCode = 1;
  }
}
