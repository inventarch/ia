// Test double for `npm view <spec> --json` (src/kits-package.ts). Each call's argv is appended to $IA_NPM_LOG when that
// is set. It prints $FAKE_NPM_VIEW, a JSON manifest, with `version` set to the spec's exact version when it names one,
// and exits 0; with $FAKE_NPM_VIEW unset it prints an npm E404 on stderr and exits 1.
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.IA_NPM_LOG) appendFileSync(process.env.IA_NPM_LOG, JSON.stringify(args) + '\n');
const view = process.env.FAKE_NPM_VIEW;
if (args[0] !== 'view' || args[2] !== '--json' || view === undefined || view === '') {
  process.stderr.write(
    `npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${args[1] ?? ''}\n`,
  );
  process.exit(1);
}
const manifest = JSON.parse(view);
const exact = /@(\d+\.\d+\.\d+)$/.exec(args[1] ?? '');
process.stdout.write(JSON.stringify(exact ? { ...manifest, version: exact[1] } : manifest, null, 2) + '\n');
