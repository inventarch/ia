import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
    const text =
      '#! ia 1.0\n@plan repository-maintenance\n  meaning\n    says "Maintain the repository."\n  work\n    title "Repository maintenance"\n    status open\n' +
      '\n@milestone repository-maintained\n  meaning\n    says "The repository is maintained."\n  work\n    title "Maintained"\n    status open\n    plan @plan repository-maintenance\n    exit "Maintenance is done."\n' +
      '\n@task repository-maintenance-checks\n  meaning\n    says "Run the maintenance checks."\n  work\n    title "Maintenance checks"\n    status open\n    milestone @milestone repository-maintained\n';
    for (const path of ['.ia/src/records/maintenance.ia', '.ia/src/systems/work-system/records/maintenance.ia']) {
      const changed = checkNative(
        [
          ...local.inputs,
          { path, text, location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' } },
        ],
        local.folders,
      );
      expect(changed.ok).toBe(true);
      expect(
        checkRepositoryArchitecture(changed.records).filter((finding) => finding.code === 'IA-NATIVE-WORK-PLACEMENT'),
      ).toHaveLength(path.includes('/systems/') ? 3 : 0);
    }
  });
});
