import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileNative } from './compile.js';
import type { NativeInput } from './compile.js';
import { languagePackageInputs } from './public-language.js';
import { checkReleaseWork } from './release-work.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = languagePackageInputs(root).inputs;
const ROOT = '.ia/src/records/release-fixture.ia';
const SYSTEM = '.ia/src/systems/work-system/records/release-fixture.ia';
const NEUTRAL = 'Select the npm cohort version from releases/current.json and its membership from package manifests.';

function decision({
  source = 'releases/current.json',
  choice = NEUTRAL,
  status = 'made',
  constraints,
}: {
  source?: string;
  choice?: string;
  status?: string;
  constraints?: string[];
} = {}): string {
  return [
    '@decision release-policy-fixture',
    '  meaning',
    '    says "The repository npm release policy."',
    '  work',
    '    title "Coordinate the cohort"',
    `    status ${status}`,
    `    source ${JSON.stringify(source)}`,
    '  decision',
    '    question "How is the cohort selected?"',
    `    choice ${JSON.stringify(choice)}`,
    ...(constraints ? [`    constraints ${JSON.stringify(constraints)}`] : []),
  ].join('\n');
}
function compiled(body: string, path = ROOT) {
  const input: NativeInput = {
    path,
    text: '#! ia 1.0\n' + body + '\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  };
  const result = compileNative([...base, input]);
  expect(result.diagnostics.filter((finding) => finding.severity === 'error')).toEqual([]);
  return result.records;
}
const codes = (body: string, path = ROOT) => checkReleaseWork(compiled(body, path)).map((finding) => finding.code);

describe('repository release work freshness', () => {
  it('keeps mutable release policy version- and membership-neutral', () => {
    expect(codes(decision())).toEqual([]);
  });
  it.each([
    ['1.1.0', 21],
    ['2.0.0', 22],
    ['9.7.2-rc.3', 57],
  ])('refuses copied release selection %s and %i packages, including future cohorts', (version, count) => {
    const findings = checkReleaseWork(
      compiled(decision({ choice: `Select ${version} for all ${count} npm packages.` })),
    );
    expect(findings.map((finding) => finding.code)).toEqual([
      'IA-NATIVE-RELEASE-VERSION-LITERAL',
      'IA-NATIVE-RELEASE-COUNT-LITERAL',
    ]);
    expect(findings.every((finding) => finding.path === ROOT && finding.field === 'decision.choice')).toBe(true);
    expect(findings.every((finding) => finding.line === 11)).toBe(true);
  });
  it.each(['./releases/current.json', 'releases/./current.json#version', '.\\releases\\current.json:12'])(
    'does not evade the mutable source through locator alias %s',
    (source) => {
      expect(codes(decision({ source, choice: 'Select v1.1.0.' }))).toEqual(['IA-NATIVE-RELEASE-VERSION-LITERAL']);
    },
  );
  it('also guards the mutable native-package cohort policy', () => {
    expect(
      codes(decision({ source: 'tools/distribution/system-package-policy.json', choice: 'Release all 11 packages.' })),
    ).toEqual(['IA-NATIVE-RELEASE-COUNT-LITERAL']);
  });
  it('reads constraints as structured list values and leaves dates and bounded test deadlines alone', () => {
    expect(codes(decision({ constraints: ['Qualify 30-second test cases on 2026-10-11.'] }))).toEqual([]);
    expect(codes(decision({ constraints: ['The cohort size: 57 must remain fixed.'] }))).toEqual([
      'IA-NATIVE-RELEASE-COUNT-LITERAL',
    ]);
  });
  it.each(['twenty-one npm packages', '57-package cohort', 'package count = 57'])(
    'refuses literal cohort membership %s',
    (choice) => expect(codes(decision({ choice }))).toEqual(['IA-NATIVE-RELEASE-COUNT-LITERAL']),
  );
  it.each(['releases/changesets/1.1.0.json', 'releases/9.7.2.json#version'])(
    'retains a made historical decision bound to immutable source %s',
    (source) => {
      expect(codes(decision({ source, choice: 'Select 1.1.0 for all 21 npm packages.' }))).toEqual([]);
    },
  );
  it.each(['superseded', 'withdrawn'])(
    'does not let self-declared %s status turn mutable selection into history',
    (status) => {
      expect(codes(decision({ status, choice: 'Selected 1.1.0 for all 21 npm packages.' }))).toEqual([
        'IA-NATIVE-RELEASE-VERSION-LITERAL',
        'IA-NATIVE-RELEASE-COUNT-LITERAL',
      ]);
    },
  );
  it('does not interpret unrelated native/protocol versions or source comments as mutable npm selection', () => {
    expect(
      codes(decision({ source: 'docs/reference/protocol-v1.md', choice: 'Protocol 1.1.0 retains 21 packages.' })),
    ).toEqual([]);
    expect(codes('# Historical example: Select 1.1.0 for all 21 npm packages.\n' + decision())).toEqual([]);
  });
  it('refuses repository release work in a distributable system even when neutral or historical', () => {
    expect(codes(decision(), SYSTEM)).toEqual(['IA-NATIVE-RELEASE-WORK-PLACEMENT']);
    expect(codes(decision({ source: 'releases/changesets/1.1.0.json', choice: 'Selected 1.1.0.' }), SYSTEM)).toEqual([
      'IA-NATIVE-RELEASE-WORK-PLACEMENT',
    ]);
  });
  it('carries mutable release scope through prerequisites and the work hierarchy', () => {
    const hierarchy = [
      decision(),
      '@plan release-plan-fixture',
      '  meaning',
      '    says "Prepare this repository release."',
      '  work',
      '    title "Prepare the cohort"',
      '    status open',
      '@milestone release-milestone-fixture',
      '  meaning',
      '    says "The cohort is qualified."',
      '  work',
      '    title "Qualification complete"',
      '    status open',
      '    plan @plan release-plan-fixture',
      '    exit "All 57 npm packages are qualified."',
      '@task release-task-fixture',
      '  meaning',
      '    says "Qualify selected archives."',
      '  work',
      '    title "Qualify the archives"',
      '    status open',
      '    milestone @milestone release-milestone-fixture',
      '    action "Qualify the 9.7.2 npm release."',
      '  relationships',
      '    requires @decision release-policy-fixture',
    ].join('\n');
    const findings = checkReleaseWork(compiled(hierarchy));
    expect(findings.map((finding) => [finding.code, finding.field])).toEqual([
      ['IA-NATIVE-RELEASE-COUNT-LITERAL', 'work.exit'],
      ['IA-NATIVE-RELEASE-VERSION-LITERAL', 'work.action'],
    ]);
    expect(codes(hierarchy, SYSTEM).filter((code) => code === 'IA-NATIVE-RELEASE-WORK-PLACEMENT')).toHaveLength(4);
  });
});
