import { resolve } from 'node:path';
import { isEntry } from '../entry/is-entry.mjs';
import { checkWrite } from '../shared/check-write.mjs';
import { authoringResources, AUTHORING_MANIFEST } from './authoring-resources.mjs';
export { authoringResources } from './authoring-resources.mjs';

if (isEntry(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0]!)) {
    console.error('Usage: generate-authoring.ts --check|--write');
    process.exitCode = 2;
  } else
    try {
      const root = resolve(import.meta.dirname, '../..'),
        { output, files, total, links } = authoringResources(root);
      const result = checkWrite(root, new Map([[AUTHORING_MANIFEST, output]]), { write: args[0] === '--write' });
      if (args[0] === '--check' && result.changed.length)
        throw Error('Authoring resources changed; review the explicit library and run pnpm authoring:generate');
      console.log(
        `PASS: ${files} explicitly selected authoring resources; ${total} bytes; ${links.required} required local links; ${links.external} external references.`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
