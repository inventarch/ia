// Test double for the claude CLI (behaviour observed in host plugin distribution spec §2.3). Every invocation, the
// `--version` probe and the lists included, is appended to $IA_CLAUDE_CALLS when that is set. `--version` prints a
// version and exits 0. `plugin list --json` and `plugin marketplace list --json` print $FAKE_CLAUDE_PLUGINS /
// $FAKE_CLAUDE_MARKETPLACES (default []). Those three are not written to $IA_CLAUDE_LOG; every other call is, and exits
// $IA_CLAUDE_EXIT (default 0), or 1 when its space-joined argv starts with $IA_CLAUDE_FAIL_ON.
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2),
  line = args.join(' ');
if (process.env.IA_CLAUDE_CALLS) appendFileSync(process.env.IA_CLAUDE_CALLS, JSON.stringify(args) + '\n');
if (line === '--version') {
  process.stdout.write('0.0.0 (fake claude)\n');
  process.exit(0);
}
if (line === 'plugin list --json') {
  process.stdout.write(process.env.FAKE_CLAUDE_PLUGINS ?? '[]');
  process.exit(0);
}
if (line === 'plugin marketplace list --json') {
  process.stdout.write(process.env.FAKE_CLAUDE_MARKETPLACES ?? '[]');
  process.exit(0);
}
appendFileSync(process.env.IA_CLAUDE_LOG, JSON.stringify(args) + '\n');
const failOn = process.env.IA_CLAUDE_FAIL_ON;
if (failOn !== undefined && failOn !== '' && line.startsWith(failOn)) {
  process.stderr.write(`fake claude: failing ${line}\n`);
  process.exit(1);
}
process.exit(Number(process.env.IA_CLAUDE_EXIT ?? 0));
