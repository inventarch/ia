import { copyPublicLanguageFixture } from '../../../tools/native/public-fixture.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readInputs, type InputSnapshot } from '@inventarch/db';
import { packDistribution } from '../src/pack.js';

export const repository = resolve(import.meta.dirname, '../../..');
export const descriptor = {
  formatVersion: 1,
  id: 'fixture/foundation',
  version: '0.1.0',
  distribution: 'workspace-system/definition/distribution/public-language',
  engine: '^0.1.0',
  language: ['1.0'],
  dependencies: [],
  assets: [{ path: 'LICENSE', role: 'license' }],
  source: {
    repository: 'https://fixture.example/source-workspaces/foundation',
    commit: 'a'.repeat(64),
    recipe: 'ustar-v1',
    epoch: 1_700_000_000,
  },
  license: 'UNLICENSED',
  description: 'Original bounded snapshot qualification fixture',
};
export const sourceInput = (input: InputSnapshot) => ({
  sources: input.sources,
  folders: input.folders,
  floorOrigin: input.floorOrigin,
  ...(input.activation ? { activation: input.activation } : {}),
});

export function snapshotFixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'ia-snapshot-core-')),
    root = join(temporary, 'source');
  mkdirSync(root);
  const put = (directory: string, path: string, content: string | Uint8Array) => {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  copyPublicLanguageFixture(repository, root);
  const license = Buffer.from('Original fixture only; no external publication.\r\n');
  put(root, 'LICENSE', license);
  const packed = packDistribution(root, descriptor),
    input = readInputs(root);
  let serial = 0;
  return {
    root,
    input,
    packed,
    license,
    put,
    target() {
      const target = join(temporary, `target-${serial++}`);
      mkdirSync(target);
      return target;
    },
    close() {
      if (dirname(temporary) !== resolve(tmpdir()) || !temporary.includes('ia-snapshot-core-'))
        throw new Error('Unsafe fixture cleanup');
      rmSync(temporary, { recursive: true, force: true });
    },
  };
}
