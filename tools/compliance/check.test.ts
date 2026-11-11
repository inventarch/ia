import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { checkCompliance, readFixtures } from './check.js';
import { checkInventory } from './inventory.js';
import { EVIDENCE_CODES, fixtureCoverage } from '../../packages/compliance/src/index.js';
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '../../packages/language/src/index.js';
import { load } from '../../packages/graph/src/index.js';
import { qualifyPublicationRoot } from '../../packages/runtime/src/index.js';
import { inputs, records, registry } from '../../packages/compliance/tests/native.js';
import { runEvidenceFixtures } from './evidence-fixtures.js';

const root = resolve(import.meta.dirname, '../..');
// As in publication-fixtures.test.ts: checkCompliance runs the publication and execution fixtures in-process, and a slow
// Windows runner can take longer than the publication probe's own bounded 30 s, so a fixture observes
// IA-PUBLICATION-UNAVAILABLE where it expects another refusal (CI 43112020588). The probe caches a success for this
// loaded module and never a failure, so qualify the temporary drive up front and retry a probe the runner was too slow
// to finish. Best effort: a failed attempt is only logged, and if every attempt fails, the fixtures probe again and
// report the refusal themselves, as before.
beforeAll(
  () => {
    if (process.platform !== 'win32') return;
    const drive = mkdtempSync(resolve(tmpdir(), 'ia-publication-probe-'));
    try {
      const qualified = realpathSync.native(drive);
      for (let attempt = 1; attempt <= 3; attempt++)
        try {
          qualifyPublicationRoot(qualified);
          return;
        } catch (error) {
          // Not cached: the next attempt probes again under its own bound.
          console.warn(`Publication probe attempt ${attempt} of 3 failed: ${(error as Error).message}`);
        }
    } finally {
      rmSync(drive, { recursive: true, force: true });
    }
  },
  3 * 30_000 + 30_000,
);
it('binds kernel evidence to the floor used by the evaluated graph', () => {
  const { report } = checkCompliance(root);
  expect(report.verdicts.find((v) => v.check === 'COMP-KERNEL')).toMatchObject({ outcome: 'pass', basis: 'verified' });
  expect(report.conformance?.kernel?.floorDigest).toBe(KERNEL_DIGEST);
});
it('cannot reuse a kernel PASS after changing the evaluated repository floor', async () => {
  const candidate = mkdtempSync(join(tmpdir(), 'ia-compliance-floor-'));
  try {
    const sources = execFileSync('git', ['ls-files', '-z', '.ia'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    for (const path of sources) {
      mkdirSync(dirname(resolve(candidate, path)), { recursive: true });
      cpSync(resolve(root, path), resolve(candidate, path));
    }
    for (const directory of ['packages', 'apps', 'tools', 'releases'])
      symlinkSync(resolve(root, directory), resolve(candidate, directory), 'junction');
    cpSync(resolve(root, 'examples'), resolve(candidate, 'examples'), { recursive: true });
    appendFileSync(resolve(candidate, '.ia/src/floor/move.ia'), '\n');
    const { report } = checkCompliance(candidate);
    expect(report.verdicts.find((v) => v.check === 'COMP-KERNEL')?.outcome).not.toBe('pass');
    expect(report.conformance?.kernel?.floorDigest).not.toBe(KERNEL_DIGEST);
    expect(report.outcome).toBe('fail');
  } finally {
    await rm(candidate, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
it('exits nonzero for a covered requirement whose structural evaluator is unavailable', async () => {
  const candidate = mkdtempSync(join(tmpdir(), 'ia-compliance-unevaluated-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--no-local', root, candidate], { timeout: 120_000, windowsHide: true });
    cpSync(resolve(root, 'tools'), resolve(candidate, 'tools'), { recursive: true });
    // Keep the emitted host in its original dependency context: copying dist loses package-local workspace links.
    // The hook still evaluates the candidate workspace supplied by its explicit --root argument.
    symlinkSync(resolve(root, 'apps/steward-hook/dist'), resolve(candidate, 'apps/steward-hook/dist'), 'junction');
    // Before linking candidate dependencies, prove the host uses its original build context. A copied dist cannot
    // rely on the candidate workspace-link layout to conceal its missing dependency context.
    execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./apps/steward-hook/dist/main.js')"], {
      cwd: candidate,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    symlinkSync(resolve(root, 'node_modules'), resolve(candidate, 'node_modules'), 'junction');
    const files = execFileSync('git', ['grep', '-l', 'REQ-FOUNDATION-VALID', '--', 'examples/conformance/native'], {
      cwd: candidate,
      encoding: 'utf8',
    })
      .trim()
      .split(/\r?\n/);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const path = resolve(candidate, file);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('REQ-FOUNDATION-VALID', 'REQ-FOUNDATION-ADDITIONAL'));
    }
    const args = ['--conditions=development', '--import', 'tsx'];
    const invoke = (script: string, flag: string) =>
      spawnSync(process.execPath, [...args, script, flag], {
        cwd: candidate,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
    const inventory = invoke('tools/compliance/inventory.ts', '--write');
    expect(inventory.status, inventory.stderr).toBe(0);
    const checked = invoke('tools/compliance/check.ts', '--json');
    const report = JSON.parse(checked.stdout);
    expect(
      report.outcome,
      JSON.stringify(
        report.verdicts.filter((v: { outcome: string }) => v.outcome !== 'pass'),
        null,
        2,
      ),
    ).toBe('not-evaluated');
    expect(report.verdicts.filter((v: { outcome: string }) => v.outcome === 'fail')).toEqual([]);
    expect(checked.status, checked.stderr).toBe(1);
  } finally {
    await rm(candidate, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 180_000);
it('discovers the actual conformance tree without stray entries', () => {
  const listing = readFixtures(root);
  expect(listing.strays).toEqual([]);
  expect(listing.fixtures).toHaveLength(179);
});
it('executes native graph, all language fixtures, all refusal-code boundaries and kernel generation', () => {
  const { report, fixtures, boundaries, qualification } = checkCompliance(root);
  expect(fixtures).toBe(179);
  // IA-COMP-PROJECTION-INVALID retired with the projection renderers; the mandate resolver adds the default-actor and
  // two profile refusals, the `@mandate` guard its three hook refusals, and admission a second IA-COMP-FIELD-VALUE
  // boundary, the stated empty `authority.moves` it refuses.
  expect(boundaries).toBe(128);
  expect(qualification).toEqual({
    platform: process.platform,
    deferredPlatformCodes:
      process.platform === 'win32' ? [] : ['IA-EXEC-OUTPUT-EXISTS', 'IA-PUBLICATION-BUSY', 'IA-PUBLICATION-CONFLICT'],
    reason:
      process.platform === 'win32'
        ? null
        : 'Managed draft publication is qualified only on local Windows NTFS; unsupported hosts verify refusal without effects.',
  });
  expect(report.verdicts.filter((v) => v.outcome === 'fail')).toEqual([]);
  expect(report.outcome).toBe('pass');
  expect(report.verdicts.filter((v) => v.outcome === 'not-evaluated')).toEqual([]);
  expect(report.verdicts.find((v) => v.check === 'COMP-ADOPTION')!.outcome).toBe('pass');
  expect(report.verdicts.find((v) => v.check === 'COMP-FIXTURES')!.outcome).toBe('pass');
  expect(report.verdicts.find((v) => v.check === 'COMP-KERNEL')!.outcome).toBe('pass');
});

it('requires a successful producer observation for every evaluator evidence code', () => {
  const graph = load(records, registry, {
    sources: inputs,
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    location: '',
  });
  const observations = runEvidenceFixtures(graph);
  expect(observations).toHaveLength(EVIDENCE_CODES.length);
  expect(observations.flatMap((row) => row.assessment.findings)).toEqual([]);
  expect(fixtureCoverage(EVIDENCE_CODES, observations).outcome).toBe('pass');
  for (const code of EVIDENCE_CODES) {
    const missing = observations.filter((row) => !row.observedCodes.includes(code));
    expect(fixtureCoverage(EVIDENCE_CODES, missing).findings).toContainEqual(
      expect.objectContaining({ message: 'No passing failing-case observation covers ' + code }),
    );
    const failed = observations.map((row) =>
      row.observedCodes.includes(code) ? { ...row, assessment: { ...row.assessment, outcome: 'fail' as const } } : row,
    );
    expect(fixtureCoverage(EVIDENCE_CODES, failed).outcome, code).toBe('fail');
  }
});

it('fails the inventory gate after any fixture, companion or corpus edit until it is regenerated', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ia-inventory-'));
  try {
    for (const path of [
      'packages/compliance/fixtures/language',
      'examples/conformance/native',
      'examples/public-language/manifest.json',
      'packages/compliance/src/conformance/inventory.generated.ts',
    ])
      cpSync(resolve(root, path), join(temp, path), { recursive: true });
    const first = checkInventory(temp);
    expect(first.digest).toBe(checkInventory(root).digest);
    expect(first.fixtures).toBe(179);
    const digests = new Set([first.digest]);
    for (const path of [
      'packages/compliance/fixtures/language/identity/fail/facet-undeclared.ia',
      'packages/compliance/fixtures/language/format/fail/lost-comment.candidate.txt',
      'examples/conformance/native/systems/agent-system/system.ia',
    ]) {
      appendFileSync(join(temp, path), '\n');
      expect(() => checkInventory(temp), path).toThrow('Inventory drift');
      digests.add(checkInventory(temp, true).digest);
      expect(checkInventory(temp).digest).toBe([...digests].at(-1));
    }
    expect(digests.size).toBe(4);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
