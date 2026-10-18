import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { open } from '@inventarch/db';
import { normalizeScopeKey, positionBody, resolveScopeKey } from '@inventarch/runtime';
import { releaseRoots, releaseRootFindings, WORKSPACE_PATH } from './release-roots.js';
import { checkNative, readNative } from './check.js';
import { publicLanguageInputs } from './public-language.js';
import { checkRepositoryArchitecture } from './repository-architecture.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const local = readNative(root);
const baseline = checkNative(local.inputs, local.folders);
describe('public repository architecture boundary', () => {
  it.each([undefined, 'docs/specification.md', 'releases/current.json'])(
    'refuses system-owned specification instances regardless of source %s',
    (source) => {
      const text =
        '#! ia 1.0\n@spec repository-maintenance\n  meaning\n    says "Maintained repository specification."\n  work\n    title "Repository maintenance"\n    status draft\n' +
        (source === undefined ? '' : `    source "${source}"\n`);
      for (const path of ['.ia/src/systems/work-system/records/maintenance.ia', '.ia/src/records/maintenance.ia']) {
        const changed = checkNative(
          [
            ...local.inputs,
            {
              path,
              text,
              location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
            },
          ],
          local.folders,
        );
        expect(changed.ok).toBe(true);
        expect(
          checkRepositoryArchitecture(changed.records).filter((finding) => finding.code === 'IA-NATIVE-WORK-PLACEMENT'),
        ).toHaveLength(path.includes('/systems/') ? 1 : 0);
      }
    },
  );

  it('requires the release law to govern every release record unconditionally', () => {
    const law = baseline.records.find((record) => record.name === 'repository-release-selection')!;
    const targets = baseline.records.filter((record) => record.source.path === '.ia/src/records/npm-release.ia');
    expect(targets).toHaveLength(6);
    for (const target of targets) {
      for (const conditional of [false, true]) {
        const changed = baseline.records.map((record) =>
          record !== law
            ? record
            : {
                ...record,
                edges: record.edges.flatMap((edge) =>
                  edge.predicate !== 'govern' || edge.target !== target.identity
                    ? [edge]
                    : conditional
                      ? [{ ...edge, condition: [{ axis: 'phase' as const, value: 'act' }] }]
                      : [],
                ),
              },
        );
        expect(checkRepositoryArchitecture(changed).map((finding) => finding.code)).toContain(
          'IA-NATIVE-RELEASE-GOVERNANCE',
        );
      }
    }
    expect(
      checkRepositoryArchitecture(baseline.records.filter((record) => record !== law)).map((finding) => finding.code),
    ).toContain('IA-NATIVE-RELEASE-GOVERNANCE');
  });
  it('delivers the release law to every release identity and its path without governing unrelated vocabulary', () => {
    const db = open(root, { cache: false });
    try {
      const within = db.resolveScope().token;
      const rules = (seat: string | { path: string }) =>
        positionBody(
          db,
          within,
          resolveScopeKey(db, within, normalizeScopeKey({ seat, shape: 'governance' })),
        ).rules.map((rule) => rule.identity);
      const law = 'governance-system/governance/law/repository-release-selection';
      for (const record of baseline.records.filter((record) => record.source.path === '.ia/src/records/npm-release.ia'))
        expect(rules(record.identity), record.identity).toContain(law);
      expect(rules({ path: '.ia/src/records/npm-release.ia' })).toContain(law);
      expect(rules('floor/contract/head/task')).not.toContain(law);
    } finally {
      db.close();
    }
  });

  it('derives only sorted system roots from the maintained workspace while preserving the distribution identity', () => {
    const workspace = (members: string) =>
      `#! ia 1.0\n@workspace language-workspace\n  composition\n    systems [${members}]\n`;
    const generated = releaseRoots(workspace('@system z, @system a'));
    expect(generated).toContain('@distribution language-distribution');
    expect(generated).toContain('records [@system a, @system z]');
    expect(generated).not.toContain('@workspace');
    expect(releaseRoots(workspace('@system a, @system z'))).toBe(generated);
    expect(releaseRoots(workspace('@system a'))).toContain('records [@system a]');
    for (const members of ['@system a, @system a', '@system a, @system A', '@task a', '@system a#part', 'a', ''])
      expect(() => releaseRoots(workspace(members))).toThrow();
    for (const source of [
      workspace('@system a').replace('language-workspace', 'other'),
      workspace('@system a') + workspace('@system a'),
      workspace('@system a').replace(']\n', '] when phase is act\n'),
      workspace('@system a') + '    systems [@system b]\n',
      '#! ia 1.0\n',
    ])
      expect(() => releaseRoots(source)).toThrow();
  });
  it('detects missing, added and duplicate distribution roots without changing the maintained workspace', () => {
    const workspace = '#! ia 1.0\n@workspace language-workspace\n  composition\n    systems [@system a, @system b]\n';
    const expected = releaseRoots(workspace);
    const findings = (output: string) =>
      releaseRootFindings(root, (path) => (path === WORKSPACE_PATH ? workspace : output));
    expect(findings(expected)).toEqual([]);
    for (const output of [
      '',
      expected.replace(', @system b', ''),
      expected.replace('@system b]', '@system b, @system c]'),
      expected.replace('@system b]', '@system b, @system b]'),
    ])
      expect(findings(output).map((finding) => finding.code)).toEqual(['IA-NATIVE-RELEASE-ROOTS']);
  });
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
