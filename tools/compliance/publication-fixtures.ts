import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { PUBLICATION_CODES, portableDraftPath, preparePublication } from '../../packages/runtime/src/index.js';
import type { Finding, FixtureResult } from '../../packages/compliance/src/index.js';
import { assess } from '../../packages/compliance/src/types.js';

/** Unsupported hosts cannot reach ownership/effect refusals past root qualification. */
export function publicationFixtureCodes(): readonly string[] {
  return PUBLICATION_CODES.filter(
    (code) => process.platform === 'win32' || (code !== 'IA-PUBLICATION-BUSY' && code !== 'IA-PUBLICATION-CONFLICT'),
  );
}
function contents(root: string): string {
  return JSON.stringify(
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .sort()
      .map((path) => {
        const file = resolve(root, path);
        return [path, lstatSync(file).isFile() ? readFileSync(file).toString('base64') : null];
      }),
  );
}

/** Execute each publication refusal; declared expectations never count as observations. */
export function runPublicationFixtures(): readonly FixtureResult[] {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-publication-fixture-')),
    destination = '.ia/work/generated/fixture',
    files = [{ path: 'draft.ia', text: 'draft' }];
  const unavailable = (existing: boolean): void => {
    if (existing) {
      mkdirSync(resolve(root, destination), { recursive: true });
      writeFileSync(resolve(root, destination, 'authored.txt'), 'Preserve existing bytes');
    }
    const before = contents(root);
    try {
      preparePublication(root, destination, files, '{}').close();
    } finally {
      if (contents(root) !== before) throw new Error('Unsupported publication changed its root');
    }
  };
  const fixtures = [
    { name: 'invalid', expected: 'IA-PUBLICATION-INVALID', run: () => preparePublication(root, destination, [], '{}') },
    { name: 'unsafe', expected: 'IA-PUBLICATION-PATH-UNSAFE', run: () => portableDraftPath('../escape') },
    {
      name: 'unavailable',
      expected: 'IA-PUBLICATION-UNAVAILABLE',
      run: () => preparePublication('\\\\unqualified\\share', destination, files, '{}'),
    },
    ...(process.platform === 'win32'
      ? [
          {
            name: 'busy',
            expected: 'IA-PUBLICATION-BUSY',
            run: () => {
              const held = preparePublication(root, destination, files, '{}');
              try {
                preparePublication(root, destination, files, '{}').close();
              } finally {
                held.close();
              }
            },
          },
          {
            name: 'conflict',
            expected: 'IA-PUBLICATION-CONFLICT',
            run: () => {
              const first = preparePublication(root, destination, files, '{}');
              try {
                first.publish();
              } finally {
                first.close();
              }
              preparePublication(root, destination, files, '{}').close();
            },
          },
        ]
      : [
          { name: 'local-unavailable', expected: 'IA-PUBLICATION-UNAVAILABLE', run: () => unavailable(false) },
          { name: 'existing-unavailable', expected: 'IA-PUBLICATION-UNAVAILABLE', run: () => unavailable(true) },
        ]),
  ];
  try {
    return fixtures.map(({ name, expected, run }): FixtureResult => {
      let observed = '',
        detail = '';
      try {
        run();
      } catch (error) {
        observed = (error as { code?: string }).code ?? 'untyped-error';
        detail = error instanceof Error ? error.message : String(error);
      }
      const findings: Finding[] =
        observed === expected
          ? []
          : [
              {
                code: 'IA-COMP-FIXTURE-MISMATCH',
                severity: 'error',
                path: 'packages/runtime/src/publication.ts',
                line: 1,
                message: `${name}: expected ${expected}, observed ${observed || 'success'}${detail ? ` (${detail})` : ''}`,
              },
            ];
      return {
        assessment: assess('COMP-FIXTURES', `publication/${name}`, findings),
        observedCodes: observed ? [observed] : [],
      };
    });
  } finally {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !/^ia-publication-fixture-[\w-]+$/.test(path)) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
}
