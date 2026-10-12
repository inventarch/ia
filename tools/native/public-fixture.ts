import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stableSerialize } from '@inventarch/graph';
import { digest } from '@inventarch/session-system';
import type { AdoptedSource } from '@inventarch/db';
import { verifyCapture } from '@inventarch/workspace-runtime';
import type { Capture } from '@inventarch/workspace-runtime';
import type { NativeInput } from './compile.js';
import { publicLanguageInputs } from './public-language.js';

const additions = [
  [
    '.ia/src/systems/workspace-system/records/system-packages.ia',
    'examples/public-language/fixtures/system-packages.ia',
  ],
  [
    '.ia/src/systems/workspace-system/records/repository-distribution.ia',
    'examples/public-language/fixtures/repository-distribution.ia',
  ],
  [
    '.ia/src/systems/authoring-system/operations/validate-ia.ia',
    '.ia/src/systems/authoring-system/operations/validate-ia.ia',
  ],
  [
    '.ia/src/systems/authoring-system/operations/format-ia.ia',
    '.ia/src/systems/authoring-system/operations/format-ia.ia',
  ],
  [
    '.ia/src/systems/template-system/operations/render-template.ia',
    '.ia/src/systems/template-system/operations/render-template.ia',
  ],
] as const;

/** An explicit test corpus: public vocabulary and neutral examples, never repository maintenance work. */
export function publicFixtureInputs(repository: string): ReturnType<typeof publicLanguageInputs> {
  const base = publicLanguageInputs(repository);
  const location: NativeInput['location'] = {
    placement: { kind: 'authored', band: 100, reach: '' },
    provenance: 'workspace',
  };
  return {
    folders: base.folders,
    inputs: [
      ...base.inputs,
      ...additions.map(([path, source]) => ({
        path,
        text: readFileSync(resolve(repository, source), 'utf8').replace(/\r\n/g, '\n'),
        location,
      })),
    ].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Materialize the explicit corpus at its original native paths inside a caller-owned test directory. */
export function copyPublicLanguageFixture(repository: string, target: string): void {
  for (const input of publicFixtureInputs(repository).inputs) {
    const path = resolve(target, input.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.text);
  }
}

export function publicFixtureCapture(repository: string, id = 'project'): Capture {
  const input = publicFixtureInputs(repository);
  const body = {
    version: 1 as const,
    id,
    sources: input.inputs,
    folders: input.folders,
    floorOrigin: 'local' as const,
  };
  return verifyCapture({ ...body, revision: digest(body) });
}

export function publicFixtureAdoption(repository: string, id = 'foundation'): AdoptedSource {
  const sources = publicFixtureInputs(repository)
    .inputs.filter((input) => !input.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  return { id, sources, revision: createHash('sha256').update(stableSerialize(sources)).digest('hex') };
}
