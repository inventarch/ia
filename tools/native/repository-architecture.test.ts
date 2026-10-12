import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNative, readNative } from './check.js';
import { publicLanguageInputs } from './public-language.js';
import { checkRepositoryArchitecture } from './repository-architecture.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const local = readNative(root);
const baseline = checkNative(local.inputs, local.folders);
describe('public repository architecture boundary', () => {
  it('keeps the maintained live corpus admitted and free of sample and release-work payloads', () => {
    expect(baseline.ok).toBe(true);
    expect(checkRepositoryArchitecture(baseline.records)).toEqual([]);
  });
  it('refuses copying neutral examples back into the live source tree', () => {
    const example = publicLanguageInputs(root).inputs.find((input) => input.path.endsWith('/records/work.ia'))!;
    const changed = checkNative([...local.inputs, example], local.folders);
    expect(changed.ok).toBe(true);
    const findings = checkRepositoryArchitecture(changed.records);
    expect(findings.some((finding) => finding.code === 'IA-NATIVE-EXAMPLE-PLACEMENT')).toBe(true);
    expect(findings.some((finding) => finding.code === 'IA-NATIVE-WORK-PLACEMENT')).toBe(true);
  });
  it('refuses moving repository work into its vocabulary owner even when references still resolve', () => {
    const changed = checkNative(
      local.inputs.map((input) =>
        input.path === '.ia/src/records/npm-release.ia'
          ? { ...input, path: '.ia/src/systems/work-system/records/npm-release.ia' }
          : input,
      ),
      local.folders,
    );
    expect(changed.ok).toBe(true);
    expect(
      checkRepositoryArchitecture(changed.records).filter((finding) => finding.code === 'IA-NATIVE-WORK-PLACEMENT'),
    ).toHaveLength(6);
  });
  it('refuses removing or changing the maintained release-policy source', () => {
    const path = '.ia/src/records/npm-release.ia';
    const text = readFileSync(resolve(root, path), 'utf8');
    for (const replacement of ['', '    source "docs/a-different-policy.md"\n']) {
      const changed = checkNative(
        local.inputs.map((input) =>
          input.path === path
            ? { ...input, text: text.replace('    source "releases/current.json"\n', replacement) }
            : input,
        ),
        local.folders,
      );
      expect(changed.ok).toBe(true);
      expect(checkRepositoryArchitecture(changed.records).map((finding) => finding.code)).toContain(
        'IA-NATIVE-RELEASE-POLICY-SOURCE',
      );
    }
  });
  it('refuses withdrawing a current policy while the workflow still requires it', () => {
    const path = '.ia/src/records/npm-release.ia';
    const changed = checkNative(
      local.inputs.map((input) =>
        input.path === path
          ? {
              ...input,
              text: input.text.replace(
                '    title "Use the maintained release selection"\n    status made',
                '    title "Use the maintained release selection"\n    status withdrawn',
              ),
            }
          : input,
      ),
      local.folders,
    );
    expect(changed.ok).toBe(true);
    expect(checkRepositoryArchitecture(changed.records).map((finding) => finding.code)).toContain(
      'IA-NATIVE-RELEASE-POLICY-STATUS',
    );
  });
  it('refuses detaching current work from the mutable plan source or current policy prerequisite', () => {
    const path = '.ia/src/records/npm-release.ia';
    for (const change of [
      (text: string) =>
        text.replace('    start "2026-10-05"\n    source "releases/current.json"', '    start "2026-10-05"'),
      (text: string) =>
        text.replace('    requires @decision npm-release-policy', '    requires @decision coordinated-npm-release'),
      (text: string) =>
        text.replace('    requires @task npm-release-hygiene-checks', '    requires @decision coordinated-npm-release'),
    ]) {
      const changed = checkNative(
        local.inputs.map((input) => (input.path === path ? { ...input, text: change(input.text) } : input)),
        local.folders,
      );
      expect(changed.ok).toBe(true);
      expect(checkRepositoryArchitecture(changed.records).map((finding) => finding.code)).toContain(
        'IA-NATIVE-RELEASE-WORKFLOW',
      );
    }
  });
  it('refuses detaching publication review from the milestone whose exit requires it', () => {
    const path = '.ia/src/records/npm-release.ia';
    const moved =
      '@milestone isolated-publication-review\n  meaning\n    says "A separate review outcome."\n  work\n    title "Isolated review"\n    status open\n    plan @plan npm-release-hygiene\n    exit "The isolated review is done."\n';
    const changed = checkNative(
      local.inputs.map((input) =>
        input.path === path
          ? {
              ...input,
              text:
                input.text.replace(
                  '    title "Review publication prerequisites"\n    status open\n    milestone @milestone npm-release-prepared',
                  '    title "Review publication prerequisites"\n    status open\n    milestone @milestone isolated-publication-review',
                ) +
                '\n' +
                moved,
            }
          : input,
      ),
      local.folders,
    );
    expect(changed.ok).toBe(true);
    expect(checkRepositoryArchitecture(changed.records).map((finding) => finding.code)).toContain(
      'IA-NATIVE-RELEASE-WORKFLOW',
    );
  });
  it('refuses making a maintained prerequisite conditional on a delivery phase', () => {
    const path = '.ia/src/records/npm-release.ia';
    for (const prerequisite of ['@decision npm-release-policy', '@task npm-release-hygiene-checks']) {
      const changed = checkNative(
        local.inputs.map((input) =>
          input.path === path
            ? {
                ...input,
                text: input.text.replace(
                  `    requires ${prerequisite}`,
                  `    requires ${prerequisite} when phase is act`,
                ),
              }
            : input,
        ),
        local.folders,
      );
      expect(changed.ok).toBe(true);
      expect(checkRepositoryArchitecture(changed.records).map((finding) => finding.code)).toContain(
        'IA-NATIVE-RELEASE-WORKFLOW',
      );
    }
  });
});
