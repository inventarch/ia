import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG_CODES } from '@inventarch/language';
import { GRAPH_CODES, stableSerialize } from '@inventarch/graph';
import { fixtureCoverage, runLanguageFixture } from '../fixtures.js';
import type { FixtureResult, LanguageFixture } from '../fixtures.js';
import { COMP_CODES, EVIDENCE_CODES, assess } from '../types.js';
import type { Assessment, Finding } from '../types.js';
import { loadCorpus } from './corpus.js';
import { runEvidenceFixtures } from './evidence-fixtures.js';
import {
  CONFORMANCE_PROFILE,
  companionSuffixes,
  fileDigest,
  inventoryDigest,
  isConformanceProfile,
} from './inventory.js';
import type { ConformanceInventory } from './inventory.js';
import { runRefusalFixtures } from './refusals.js';

export interface ProfileResult {
  readonly assessment: Assessment;
  /** The codes passing failing cases observed. */
  readonly observedCodes: readonly string[];
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const companion: Readonly<Record<string, keyof LanguageFixture>> = {
  '.ast.json': 'ast',
  '.records.json': 'records',
  '.pool.json': 'pool',
  '.diagnostics.json': 'diagnostics',
  '.formatted.txt': 'formatted',
  '.candidate.txt': 'candidate',
};
/** Every file under `root` as a `<clause>/<mode>/<name>` path; anything at another depth is a stray. */
function listing(root: string): { files: Set<string>; strays: string[] } {
  const files = new Set<string>(),
    strays: string[] = [];
  for (const clause of readdirSync(root, { withFileTypes: true })) {
    if (!clause.isDirectory()) {
      strays.push(clause.name);
      continue;
    }
    for (const mode of readdirSync(join(root, clause.name), { withFileTypes: true })) {
      if (!mode.isDirectory()) {
        strays.push(`${clause.name}/${mode.name}`);
        continue;
      }
      for (const entry of readdirSync(join(root, clause.name, mode.name), { withFileTypes: true }))
        if (entry.isFile()) files.add(`${clause.name}/${mode.name}/${entry.name}`);
        else strays.push(`${clause.name}/${mode.name}/${entry.name}`);
    }
  }
  return { files, strays };
}

/**
 * Runs the package profile `inventory` describes over the language fixture files under `directory`: every listed
 * file must exist with its listed digest, as a companion its clause and mode admit, and nothing else may; the corpus
 * boundary suites must run exactly the listed cases; and passing failing cases must observe every required code. A
 * fixture file that cannot be read is not evaluated and suspends the coverage judgement; other failures still fail. This returns an assessment, not evidence; only verifyFixtures produces evidence.
 */
export function runProfile(inventory: ConformanceInventory, digest: string, directory: URL): ProfileResult {
  const findings: Finding[] = [];
  const mismatch = (path: string, message: string): void => {
    findings.push({ code: 'IA-COMP-FIXTURE-MISMATCH', severity: 'error', path, line: 1, message });
  };
  const root = fileURLToPath(directory);
  let found: ReturnType<typeof listing>;
  try {
    found = listing(root);
  } catch (error) {
    const message = `The package fixture files cannot be read: ${error instanceof Error ? error.message : String(error)}`;
    return Object.freeze({
      assessment: assess('COMP-FIXTURES', CONFORMANCE_PROFILE, [
        { code: 'IA-COMP-NOT-EVALUATED', severity: 'warning', path: '', line: 1, message },
      ]),
      observedCodes: Object.freeze([]),
    });
  }
  if (!isConformanceProfile(inventory.profile)) mismatch('', 'The inventory names an unknown conformance profile');
  if (inventoryDigest(inventory) !== digest) mismatch('', 'The inventory differs from the digest it is pinned by');
  const running = [...new Set([...LANG_CODES, ...GRAPH_CODES, ...COMP_CODES, ...EVIDENCE_CODES])].sort(compare);
  if (stableSerialize(inventory.requiredCodes) !== stableSerialize(running))
    mismatch('', "The inventory's required codes differ from the running toolchain's");
  const listed = new Set<string>(),
    results: FixtureResult[] = [];
  let unreadable = false;
  for (const fixture of inventory.fixtures) {
    if (listed.has(fixture.path)) {
      mismatch(fixture.path, `${fixture.path}: duplicate inventory path`);
      continue;
    }
    listed.add(fixture.path);
    const stem = fixture.path.slice(0, -'.ia'.length),
      read: Record<string, string> = {},
      folder = `${fixture.clause}/${fixture.mode}/`,
      admitted = ['.ia', ...companionSuffixes(fixture.clause, fixture.mode)];
    let verified = fixture.path.endsWith('.ia') && Object.keys(fixture.files).includes('.ia');
    if (!fixture.path.startsWith(folder) || fixture.path.slice(folder.length).includes('/')) {
      mismatch(fixture.path, `${fixture.path}: listed as a ${fixture.clause}/${fixture.mode} fixture`);
      verified = false;
    }
    for (const [suffix, expected] of Object.entries(fixture.files)) {
      const path = stem + suffix;
      if (!admitted.includes(suffix)) {
        found.files.delete(path);
        mismatch(path, `${path}: ${suffix} is not a companion of ${fixture.clause}/${fixture.mode} fixtures`);
        verified = false;
        continue;
      }
      if (!found.files.has(path)) {
        mismatch(path, `${path}: missing`);
        verified = false;
        continue;
      }
      found.files.delete(path);
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(root, path));
      } catch (error) {
        // An unreadable file is no evidence either way: it is not evaluated, and coverage is not judged.
        unreadable = true;
        findings.push({
          code: 'IA-COMP-NOT-EVALUATED',
          severity: 'warning',
          path,
          line: 1,
          message: `${path}: cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        });
        verified = false;
        continue;
      }
      if (fileDigest(bytes) !== expected) {
        mismatch(path, `${path}: differs from the inventory`);
        verified = false;
      } else read[suffix] = bytes.toString('utf8');
    }
    if (!verified) continue;
    try {
      const companions: Record<string, unknown> = {};
      for (const [suffix, key] of Object.entries(companion))
        if (read[suffix] !== undefined)
          companions[key] = suffix.endsWith('.json') ? (JSON.parse(read[suffix]) as unknown) : read[suffix];
      results.push(
        runLanguageFixture({
          path: fixture.path,
          clause: fixture.clause,
          mode: fixture.mode,
          source: read['.ia']!,
          ...(companions as Partial<LanguageFixture>),
        }),
      );
    } catch (error) {
      mismatch(fixture.path, `${fixture.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const path of [...found.files, ...found.strays])
    mismatch(path, `${path}: unexpected fixture entry or orphan companion`);
  try {
    const corpus = loadCorpus(inventory.corpus, inventory.folders);
    const boundaries = [
      ...runRefusalFixtures(corpus.graph, corpus.inputs, corpus.folders),
      ...runEvidenceFixtures(corpus.graph),
    ];
    const ran = new Set(boundaries.map((result) => result.assessment.scope)),
      expected = new Set(inventory.boundaries);
    for (const scope of expected) if (!ran.has(scope)) mismatch('', `${scope}: listed boundary case did not run`);
    for (const scope of ran) if (!expected.has(scope)) mismatch('', `${scope}: boundary case is not in the inventory`);
    results.push(...boundaries);
  } catch (error) {
    mismatch('', `The conformance corpus does not load: ${error instanceof Error ? error.message : String(error)}`);
  }
  findings.push(
    ...results.flatMap((result) => result.assessment.findings),
    ...(unreadable ? [] : fixtureCoverage(inventory.requiredCodes, results).findings),
  );
  return Object.freeze({
    assessment: assess('COMP-FIXTURES', CONFORMANCE_PROFILE, findings),
    observedCodes: Object.freeze(
      [...new Set(results.filter((r) => r.assessment.outcome === 'pass').flatMap((r) => r.observedCodes))].sort(
        compare,
      ),
    ),
  });
}
