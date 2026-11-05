// A `git` reached through a link, for the console's batch tests (console/batch-run.ts): it runs the real git named by
// $FORWARD_GIT with its own arguments and stdio, and exits with its status.
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.env.FORWARD_GIT ?? 'git', process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
