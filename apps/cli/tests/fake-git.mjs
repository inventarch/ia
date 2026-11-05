// A `git` planted inside a user's checkout, for the console's batch tests (console/batch-run.ts, console/batch-next.ts):
// the batch must never run it. If it is run, it appends {argv, cwd} to $FAKE_GIT_LOG as one JSON line and exits 1.
import { appendFileSync } from 'node:fs';

if (process.env.FAKE_GIT_LOG)
  appendFileSync(process.env.FAKE_GIT_LOG, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`);
process.exit(1);
