import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKernel } from '../../packages/compliance/src/kernel.js';
import type { KernelSource } from '../../packages/compliance/src/kernel.js';
import { isEntry } from '../entry/is-entry.mjs';
import { checkWrite } from '../shared/check-write.mjs';
import { generationMode } from '../shared/args.mjs';

export { generateKernel };
export type { KernelSource };
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function readKernel(root: string): readonly KernelSource[] {
  return readdirSync(resolve(root, '.ia/src/floor'))
    .filter((p) => p.endsWith('.ia'))
    .sort(compare)
    .map((name) => ({
      path: `.ia/src/floor/${name}`,
      text: readFileSync(resolve(root, '.ia/src/floor', name), 'utf8').replaceAll('\r\n', '\n'),
    }));
}

export function checkKernel(root: string, write = false): { digest: string; records: number } {
  const result = generateKernel(readKernel(root));
  const compared = checkWrite(root, new Map([['packages/language/src/kernel.generated.ts', result.text]]), {
    write,
    normalizeNewlines: true,
  });
  if (!write && compared.changed.length)
    throw new Error('Kernel output drift: run pnpm kernel:generate and review the result');
  return result;
}
if (isEntry(process.argv[1], import.meta.url)) {
  let mode: 'check' | 'write' | undefined;
  try {
    mode = generationMode(process.argv.slice(2));
  } catch (error) {
    console.error('Usage: generate.ts [--check|--write]');
    console.error(String(error));
    process.exitCode = 2;
  }
  if (mode)
    try {
      const result = checkKernel(fileURLToPath(new URL('../../', import.meta.url)), mode === 'write');
      process.stdout.write(`Validated ${result.records} kernel records; digest ${result.digest}.\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
