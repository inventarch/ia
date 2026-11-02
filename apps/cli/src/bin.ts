#!/usr/bin/env node
/**
 * The `ia` executable. consumer-cli-contract §1.2's hand-off is decided here, before any command module loads: deciding
 * reads only directories and `package.json` files, so a command the workspace's own copy answers never pays for loading
 * this copy's. When this copy answers, main.js runs the invocation.
 */
import { realpathSync } from 'node:fs';
import { iaHomeOf } from './discovery.js';
import { handOff, handoffTarget } from './handoff.js';
import type { LocalCli } from './local-cli.js';
import { EXTENSIONS, packageRoot, version } from './self.js';

/**
 * The exit code of the workspace's own installed copy when this invocation went to it, or undefined when this copy
 * answers. A copy that is there but cannot be started is reported on stderr and passed over.
 */
async function handedOff(argv: readonly string[]): Promise<number | undefined> {
  const extensions = EXTENSIONS.map((extension) => extension.token);
  // Only an extension can claim a core token, which dispatch refuses it; this table is empty, so the command table that
  // names the core tokens loads only when there is an extension to check.
  const coreTokens = extensions.length === 0 ? new Set<string>() : (await import('./commands.js')).CORE_TOKENS;
  let target: LocalCli | null;
  try {
    target = handoffTarget({
      argv,
      cwd: process.cwd(),
      env: process.env,
      packageRoot,
      iaHome: iaHomeOf(process.env),
      extensions,
      coreTokens,
    });
  } catch {
    // Nothing the decision reads throws but the working directory itself, when it is gone; main.js reports that.
    return undefined;
  }
  if (target === null) return undefined;
  try {
    return handOff(target, argv, process.env, realpathSync(packageRoot));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `ia: could not start this workspace's @inventarch/cli ${target.version} (${message}); running ${version()} instead\n`,
    );
    return undefined;
  }
}

const argv = process.argv.slice(2);
const handed = await handedOff(argv);
if (handed !== undefined) process.exitCode = handed;
else await (await import('./main.js')).main(argv);
