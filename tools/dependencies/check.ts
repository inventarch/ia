import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import ts from 'typescript';

export const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  '@ia/architecture-system': ['@ia/code-quality-system', '@ia/db', '@ia/graph', '@ia/language', '@ia/runtime'],
  '@ia/authoring-system': ['@ia/db', '@ia/language', '@ia/runtime'],
  '@ia/template-system': ['@ia/language', '@ia/runtime'],
  '@ia/language': [],
  '@ia/graph': ['@ia/language'],
  '@ia/compliance': ['@ia/language', '@ia/graph'],
  '@ia/db': ['@ia/language', '@ia/graph', '@ia/compliance'],
  '@ia/runtime': ['@ia/language', '@ia/graph', '@ia/db'],
  '@ia/session-system': [],
  '@ia/agent-system': ['@ia/session-system', '@ia/runtime', '@ia/language', '@ia/graph', '@ia/db'],
  '@ia/agent-composition-system': [
    '@ia/agent-system',
    '@ia/session-system',
    '@ia/authoring-system',
    '@ia/template-system',
    '@ia/runtime',
    '@ia/db',
    '@ia/language',
    '@ia/graph',
    '@ia/compliance',
  ],
  '@ia/service-contracts': [],
  '@ia/service-host': ['@ia/service-contracts'],
  '@ia/inventarch-system': ['@ia/agent-composition-system', '@ia/db', '@ia/graph', '@ia/runtime'],
  '@ia/delivery-system': [],
  '@ia/code-quality-system': [],
};
const HOSTS: Readonly<Record<string, readonly string[]>> = {
  '@ia/mcp-door': ['@ia/runtime', '@ia/service-contracts', '@ia/agent-composition-system'],
  '@ia/distribution': [
    '@ia/language',
    '@ia/graph',
    '@ia/db',
    '@ia/authoring-system',
    '@ia/agent-composition-system',
    '@ia/session-system',
    '@ia/steward-hook',
  ],
  '@ia/steward-hook': ['@ia/runtime', '@ia/db', '@ia/agent-composition-system'],
  '@ia/cli': [
    '@ia/code-quality-system',
    '@ia/architecture-system',
    '@ia/runtime',
    '@ia/inventarch-system',
    '@ia/agent-composition-system',
    '@ia/db',
    '@ia/distribution',
    '@ia/compliance',
  ],
  '@ia/agent-runner': ['@ia/runtime', '@ia/agent-system', '@ia/session-system', '@ia/agent-composition-system'],
  '@ia/marketplace': [
    '@ia/distribution',
    '@ia/db',
    '@ia/service-contracts',
    '@ia/service-host',
    '@ia/agent-composition-system',
    '@ia/agent-system',
    '@ia/session-system',
    '@ia/language',
  ],
  '@ia/folio': ['@ia/language'],
};
export interface Component {
  readonly name: string;
  readonly path: string;
  readonly app: boolean;
}
export function importedModules(source: string, path: string): readonly (string | null)[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true),
    modules: (string | null)[] = [];
  const add = (node: ts.Node | undefined): void => {
    modules.push(node !== undefined && ts.isStringLiteralLike(node) ? node.text : null);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node)) add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return modules;
}
export function moduleProblem(owner: Component, file: string, specifier: string | null): string | undefined {
  if (specifier === null) return 'Nonliteral module load cannot establish dependency direction';
  if (owner.name === '@ia/service-contracts' && !specifier.startsWith('.') && specifier !== 'zod')
    return 'Client contracts may only import zod and their own modules';
  if (specifier.startsWith('.') || specifier.startsWith('/') || /^[A-Za-z]:/.test(specifier)) {
    const path = resolve(dirname(file), specifier),
      local = relative(owner.path, path).replaceAll('\\', '/');
    if (local === '..' || local.startsWith('../') || /^[A-Za-z]:/.test(local))
      return `Cross-package path import ${specifier}; use a public package`;
    return undefined;
  }
  if (specifier.startsWith('@inventarch/monorepo-kit-host'))
    return ['@ia/cli', '@ia/inventarch-cli'].includes(owner.name) &&
      owner.app &&
      ['@inventarch/monorepo-kit-host', '@inventarch/monorepo-kit-host/development'].includes(specifier)
      ? undefined
      : 'Only the CLI may select the declared development producer';
  if (!specifier.startsWith('@ia/')) return undefined;
  const dependency = specifier.split('/').slice(0, 2).join('/');
  if (
    dependency === owner.name ||
    (owner.app ? (HOSTS[owner.name] ?? ['@ia/runtime']) : (ALLOWED[owner.name] ?? [])).includes(dependency)
  )
    return undefined;
  return `${owner.name} may not depend on ${dependency}`;
}
function sources(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(resolve(path, entry.name))
      : /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [resolve(path, entry.name)]
        : [],
  );
}
export function checkDependencies(root: string): readonly string[] {
  const findings: string[] = [];
  for (const area of ['packages', 'apps', '.ia/src/systems']) {
    const folder = resolve(root, area);
    if (!existsSync(folder)) continue;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name),
        manifestPath = resolve(path, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const owner = { name: manifest.name, path, app: area === 'apps' };
      const declared = new Set(
        Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }),
      );
      if (!owner.app && ALLOWED[owner.name] === undefined)
        findings.push(`${manifestPath}: no dependency policy for ${owner.name}`);
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      })) {
        const problem = moduleProblem(owner, manifestPath, dependency);
        if (problem !== undefined) findings.push(`${manifestPath}: ${problem}`);
      }
      for (const file of sources(resolve(path, 'src')))
        for (const imported of importedModules(readFileSync(file, 'utf8'), file)) {
          const problem = moduleProblem(owner, file, imported);
          if (problem !== undefined) findings.push(`${file}: ${problem}`);
          else if (imported?.startsWith('@ia/') || imported?.startsWith('@inventarch/monorepo-kit-host')) {
            const dependency = imported.split('/').slice(0, 2).join('/');
            if (dependency !== owner.name && !declared.has(dependency))
              findings.push(`${file}: ${dependency} is allowed but not declared as an installed dependency`);
          }
        }
    }
  }
  return findings.sort();
}
if (isEntry(process.argv[1], import.meta.url)) {
  const findings = checkDependencies(resolve(import.meta.dirname, '../..'));
  if (findings.length > 0) {
    process.stderr.write(findings.join('\n') + '\n');
    process.exitCode = 1;
  } else process.stdout.write('Runtime package dependency direction verified.\n');
}
