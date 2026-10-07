import '../temp/physical-temp.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { KERNEL_DIGEST, LANGUAGE_VERSION, LANG_CODES } from '../../packages/language/src/index.js';
import { GRAPH_CODES, load } from '../../packages/graph/src/index.js';
import {
  COMP_CODES,
  EVIDENCE_CODES,
  evaluate,
  fixtureCoverage,
  runLanguageFixture,
  verdict,
} from '../../packages/compliance/src/index.js';
import type { Finding, LanguageFixture } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';
import { inputs as fixtureInputs } from '../../packages/compliance/tests/native.js';
import { compileNative } from '../native/compile.js';
import { observeFoundationAuthoring } from '../native/fixture-authoring.js';
import { foundationAdoptionEvaluators } from './foundation-adoption.js';
import { generateKernel, readKernel } from '../kernel/generate.js';
import { runRefusalFixtures } from '../../packages/compliance/fixtures/refusals.js';
import { HOOK_CODES, PUBLICATION_CODES, RUNTIME_CODES, RUNTIME_ESCALATIONS } from '../../packages/runtime/src/index.js';
import { runMandateFixtures, runRuntimeFixtures } from './runtime-fixtures.js';
import { runEvidenceFixtures } from './evidence-fixtures.js';
import { runHookFixtures } from './hook-fixtures.js';
import { EXEC_CODES } from '../systems/types.js';
import { executionFixtureCodes, runExecutionFixtures } from '../systems/refusal-fixtures.js';
import { publicationFixtureCodes, runPublicationFixtures } from './publication-fixtures.js';

export function readFixtures(root: string): { fixtures: LanguageFixture[]; strays: string[] } {
  const base = resolve(root, 'packages/compliance/fixtures/language'),
    fixtures: LanguageFixture[] = [],
    strays: string[] = [];
  for (const clause of readdirSync(base, { withFileTypes: true })) {
    if (!clause.isDirectory()) {
      strays.push(clause.name);
      continue;
    }
    for (const mode of readdirSync(resolve(base, clause.name), { withFileTypes: true })) {
      if (!mode.isDirectory() || (mode.name !== 'pass' && mode.name !== 'fail')) {
        strays.push(`${clause.name}/${mode.name}`);
        continue;
      }
      const folder = resolve(base, clause.name, mode.name),
        entries = readdirSync(folder, { withFileTypes: true });
      const allowed =
        mode.name === 'pass' ? ['.ast.json', '.records.json', '.pool.json'] : ['.diagnostics.json', '.pool.json'];
      if (clause.name === 'format') allowed.push(mode.name === 'pass' ? '.formatted.txt' : '.candidate.txt');
      for (const entry of entries) {
        const path = `${clause.name}/${mode.name}/${entry.name}`;
        if (!entry.isFile()) {
          strays.push(path);
          continue;
        }
        if (!entry.name.endsWith('.ia')) {
          const suffix = allowed.find((s) => entry.name.endsWith(s));
          if (suffix === undefined || !existsSync(resolve(folder, entry.name.slice(0, -suffix.length) + '.ia')))
            strays.push(path);
          continue;
        }
        const stem = entry.name.slice(0, -3),
          companions: Record<string, unknown> = {};
        for (const [key, suffix] of Object.entries({
          ast: '.ast.json',
          records: '.records.json',
          pool: '.pool.json',
          diagnostics: '.diagnostics.json',
          formatted: '.formatted.txt',
          candidate: '.candidate.txt',
        })) {
          const file = resolve(folder, stem + suffix);
          if (existsSync(file)) {
            const text = readFileSync(file, 'utf8');
            companions[key] = suffix.endsWith('.json') ? (JSON.parse(text) as unknown) : text;
          }
        }
        fixtures.push({
          path,
          clause: clause.name,
          mode: mode.name,
          source: readFileSync(resolve(folder, entry.name), 'utf8'),
          ...companions,
        });
      }
    }
  }
  return { fixtures: fixtures.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), strays: strays.sort() };
}
export function checkCompliance(root: string) {
  const native = {
      inputs: fixtureInputs,
      folders: [
        'agent-system',
        'compliance-system',
        'workspace-system',
        'governance-system',
        'session-system',
        'authoring-system',
        'agent-composition-system',
        'template-system',
        'hook-authoring-system',
        'learning-system',
        'work-system',
      ],
    },
    corpus = compileNative(native.inputs);
  const graph = load(corpus.records, corpus.registry, {
    sources: native.inputs,
    kernelDigest: KERNEL_DIGEST,
    languageVersion: LANGUAGE_VERSION,
    location: '',
  });
  const folders = native.folders.map((name) => {
    const path = `.ia/src/systems/${name}`;
    return {
      name,
      path,
      sources: corpus.sources.filter((s) => s.ast.path.startsWith(path + '/')),
      records: corpus.records.filter((r) => r.source.path.startsWith(path + '/')),
    };
  });
  const listing = readFixtures(root),
    results = listing.fixtures.map(runLanguageFixture);
  const boundaries = [
      ...runRefusalFixtures(graph, native.inputs, folders),
      ...runEvidenceFixtures(graph),
      ...runRuntimeFixtures(root),
      ...runMandateFixtures(corpus.records),
      ...runHookFixtures(root),
      ...runExecutionFixtures(root),
      ...runPublicationFixtures(),
    ],
    all = [...results, ...boundaries];
  const effectCodes = [...executionFixtureCodes(), ...publicationFixtureCodes()];
  const deferredPlatformCodes = [...EXEC_CODES, ...PUBLICATION_CODES]
    .filter((code) => !effectCodes.includes(code))
    .sort();
  const qualification = {
    platform: process.platform,
    deferredPlatformCodes,
    reason: deferredPlatformCodes.length
      ? 'Managed draft publication is qualified only on local Windows NTFS; unsupported hosts verify refusal without effects.'
      : null,
  };
  const fixtures = assess('COMP-FIXTURES', 'repository', [
    ...all.flatMap((r) => r.assessment.findings),
    ...fixtureCoverage(
      [
        ...LANG_CODES,
        ...GRAPH_CODES,
        ...COMP_CODES,
        ...EVIDENCE_CODES,
        ...HOOK_CODES,
        ...effectCodes,
        ...RUNTIME_CODES,
        ...RUNTIME_ESCALATIONS,
      ],
      all,
    ).findings,
    ...listing.strays.map(
      (path): Finding => ({
        code: 'IA-COMP-FIXTURE-MISMATCH',
        severity: 'error',
        path,
        line: 1,
        message: 'Unexpected fixture entry or orphan companion',
      }),
    ),
  ]);
  const kernelFindings: Finding[] = [];
  try {
    const generated = generateKernel(readKernel(root));
    if (
      generated.text !==
      readFileSync(resolve(root, 'packages/language/src/kernel.generated.ts'), 'utf8').replaceAll('\r\n', '\n')
    )
      throw new Error('Generated kernel differs from the checked-in module');
  } catch (error) {
    kernelFindings.push({
      code: 'IA-COMP-FIXTURE-MISMATCH',
      severity: 'error',
      path: '.ia/src/floor',
      line: 1,
      message: `Kernel verification: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const adoptionEvaluators = foundationAdoptionEvaluators(observeFoundationAuthoring(native.inputs, native.folders));
  return {
    report: evaluate(graph, {
      sourceDiagnostics: corpus.diagnostics,
      folders,
      adoptionEvaluators,
      evidence: new Map([
        ['COMP-FIXTURES', verdict(fixtures, graph.revision)],
        ['COMP-KERNEL', verdict(assess('COMP-KERNEL', 'floor', kernelFindings), graph.revision)],
      ]),
    }),
    fixtures: results.length,
    boundaries: boundaries.length,
    qualification,
  };
}
if (isEntry(process.argv[1], import.meta.url)) {
  const { report, fixtures, boundaries, qualification } = checkCompliance(resolve(import.meta.dirname, '../..'));
  if (process.argv.includes('--json'))
    process.stdout.write(JSON.stringify({ ...report, qualification }, null, 2) + '\n');
  else {
    process.stdout.write(
      `${report.outcome}: ${report.verdicts.length} verdicts, ${fixtures} language fixtures, ${boundaries} boundary fixtures; revision ${report.revision}\n`,
    );
    if (qualification.deferredPlatformCodes.length)
      process.stdout.write(
        `Platform qualification (${qualification.platform}): ${qualification.reason} Not observed here: ${qualification.deferredPlatformCodes.join(', ')}\n`,
      );
    for (const v of report.verdicts.filter((v) => v.outcome !== 'pass'))
      process.stdout.write(`${v.outcome} ${v.check} ${v.scope}: ${v.findings.map((f) => f.message).join('; ')}\n`);
  }
  if (report.outcome === 'fail') process.exitCode = 1;
}
