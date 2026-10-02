// H05: keep this source launcher usable even before the TypeScript host is built.
import { readFileSync } from 'node:fs';
const deny = (message) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `IA-HOOK-INPUT-INVALID: ${message}`,
  },
});
let output;
try {
  const { runHook } = await import('../../dist/main.js');
  output = runHook(process.argv.slice(2), readFileSync(0, 'utf8'));
} catch {
  output = deny('Steward hook unavailable; build the repository and retry');
}
process.stdout.write(JSON.stringify(output) + '\n');
