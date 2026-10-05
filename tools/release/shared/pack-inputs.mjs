import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { child, separate } from './paths.mjs';

/** Only receipt-owned bytes may become build or package inputs. Never copy incidental candidate files. */
export function copyPackInputs(candidate, staging, receipt) {
  separate(staging, candidate);
  if (readdirSync(staging).length) throw new Error('Packaging staging directory must be empty');
  const files = Array.isArray(receipt.files)
    ? receipt.files.map((file) => [file.path, file.sha256])
    : Object.entries(receipt.files);
  if (!files.length || new Set(files.map(([path]) => path)).size !== files.length)
    throw new Error('Invalid packaging receipt membership');
  for (const [path, expected] of files) {
    const bytes = readFileSync(child(candidate, path));
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      throw new Error(`Changed packaging input: ${path}`);
    const destination = child(staging, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}
