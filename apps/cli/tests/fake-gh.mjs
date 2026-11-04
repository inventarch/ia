// Test double for the GitHub CLI as the console's batch uses it (console/batch-next.ts). Every call is appended to
// $FAKE_GH_LOG as one JSON line {argv, cwd}. `gh auth status` exits 0 unless $FAKE_GH_AUTH is `fail`; `gh pr create`
// prints a pull request URL named after the --head branch and exits 0; anything else exits 1.
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.FAKE_GH_LOG)
  appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
if (argv[0] === 'auth' && argv[1] === 'status') process.exit(process.env.FAKE_GH_AUTH === 'fail' ? 1 : 0);
if (argv[0] === 'pr' && argv[1] === 'create') {
  const head = argv[argv.indexOf('--head') + 1] ?? 'unknown';
  process.stdout.write(`Creating pull request\nhttps://example.test/pull/${head}\n`);
  process.exit(0);
}
process.exit(1);
