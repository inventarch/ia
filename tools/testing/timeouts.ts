import { readManifest, type TimeoutProfile } from './inventory.js';

/**
 * Named execution bounds. These are correctness ceilings derived from the allowances the suites
 * already carry, not performance targets; performance is reported separately. Raising one is an
 * execution-contract change, so it belongs in the manifest where it invalidates cached results.
 */

export interface VitestBounds {
  readonly testTimeout: number;
  readonly hookTimeout: number;
  readonly maxWorkers: number;
}

let cached: { readonly root: string; readonly profiles: Readonly<Record<string, TimeoutProfile>> } | undefined;

export function timeoutProfiles(root: string): Readonly<Record<string, TimeoutProfile>> {
  if (cached?.root !== root) cached = { root, profiles: readManifest(root).profiles ?? {} };
  return cached.profiles;
}

export function profileFor(root: string, name: string): TimeoutProfile {
  const profile = timeoutProfiles(root)[name];
  if (!profile) throw new Error(`Unknown timeout profile ${name}; declare it in tools/testing/tasks.json`);
  return profile;
}

/** Vitest options for a profile, with an optional task worker limit that may narrow but never widen it. */
export function vitestBounds(profile: TimeoutProfile, workerLimit?: number): VitestBounds {
  if (workerLimit !== undefined && (!Number.isSafeInteger(workerLimit) || workerLimit < 1))
    throw new Error('A worker limit must be a positive integer');
  if (workerLimit !== undefined && workerLimit > profile.workerLimit)
    throw new Error(`${workerLimit} workers exceeds the ${profile.workerLimit} this profile permits`);
  return {
    testTimeout: profile.testTimeoutMs,
    hookTimeout: profile.hookTimeoutMs,
    maxWorkers: workerLimit ?? profile.workerLimit,
  };
}

/**
 * The variable a test reads for the bound it may give one spawned process. Vitest receives the test and hook
 * bounds as options; a subprocess bound has no Vitest option, so the runner hands it over through the environment.
 */
export const SUBPROCESS_TIMEOUT_VARIABLE = 'IA_TEST_SUBPROCESS_TIMEOUT_MS';

/** The environment for a task's Vitest process: the caller's own, plus CI and the profile's subprocess bound. */
export function vitestEnvironment(profile: TimeoutProfile, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, CI: base['CI'] ?? '1', [SUBPROCESS_TIMEOUT_VARIABLE]: String(profile.subprocessTimeoutMs) };
}
