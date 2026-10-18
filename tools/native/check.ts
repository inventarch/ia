import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, validateSystems } from '../../packages/compliance/src/index.js';
import { checkMeaning } from './meaning.js';
export { checkMeaning, CIRCULAR_ANSWERS, type MeaningFinding } from './meaning.js';
import { compileNative } from './compile.js';
import type { NativeInput } from './compile.js';
import { checkReleaseWork } from './release-work.js';
import { checkRepositoryArchitecture } from './repository-architecture.js';
import { releaseRootFindings } from './release-roots.js';
import { isEntry } from '../entry/is-entry.mjs';
import { parseOptions } from '../shared/args.mjs';

export function readNative(root: string): { inputs: readonly NativeInput[]; folders: readonly string[] } {
  const inputs: NativeInput[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name.toLowerCase())) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.ia'))
        inputs.push({
          path: child,
          text: readFileSync(resolve(root, child), 'utf8'),
          location: child.startsWith('.ia/src/floor/')
            ? { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' }
            : { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
        });
    }
  };
  walk('.ia/src');
  const folders = readdirSync(resolve(root, '.ia/src/systems'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return { inputs, folders };
}
export function checkNative(inputs: readonly NativeInput[], folders: readonly string[]) {
  const corpus = compileNative(inputs);
  const assessments = [
    ...corpus.records.map((r) => validateSchema(r, corpus.registry, corpus.records)),
    ...validateSystems(
      folders.map((name) => {
        const path = `.ia/src/systems/${name}`;
        return {
          name,
          path,
          sources: corpus.sources.filter((s) => s.ast.path.startsWith(`${path}/`)),
          records: corpus.records.filter((r) => r.source.path.startsWith(`${path}/`)),
        };
      }),
      corpus.registry,
      corpus.records,
    ),
  ];
  return {
    ...corpus,
    assessments,
    ok: !corpus.diagnostics.some((d) => d.severity === 'error') && assessments.every((a) => a.outcome === 'pass'),
  };
}
export function nativeOutcome(result: ReturnType<typeof checkNative>) {
  const meaning = checkMeaning(result.records);
  const release = checkReleaseWork(result.records);
  return {
    ok: result.ok && meaning.length === 0 && release.length === 0,
    findings: [...result.diagnostics, ...result.assessments.flatMap((a) => a.findings), ...meaning, ...release],
  };
}
/** The repository entry point has one complete result, including architecture and release-root policy. */
export function checkRepositoryNative(root: string) {
  const { inputs, folders } = readNative(root),
    result = checkNative(inputs, folders),
    evaluated = nativeOutcome(result);
  const architecture = [...checkRepositoryArchitecture(result.records), ...releaseRootFindings(root)];
  return {
    ...result,
    ok: evaluated.ok && architecture.length === 0,
    findings: [...evaluated.findings, ...architecture],
  };
}
if (isEntry(process.argv[1], import.meta.url)) {
  let valid = false;
  try {
    parseOptions(process.argv.slice(2), {});
    valid = true;
  } catch (error) {
    console.error('Usage: check.ts');
    console.error(String(error));
    process.exitCode = 2;
  }
  if (valid)
    try {
      const result = checkRepositoryNative(fileURLToPath(new URL('../../', import.meta.url)));
      if (result.findings.length) process.stdout.write(JSON.stringify(result.findings, null, 2) + '\n');
      process.stdout.write(
        (result.ok ? 'PASS' : 'FAIL') +
          ': ' +
          result.records.length +
          ' native records; ' +
          result.assessments.length +
          ' structural assessments; order ' +
          result.registry.order.join(', ') +
          '.\n',
      );
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
