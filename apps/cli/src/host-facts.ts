/**
 * The facts this CLI tells a position's host note (packages/runtime `HostFacts`): itself as `ia@<version>`, and the
 * SHA-256 of its workspace's installed state, which only a host that can read the distribution store knows. The
 * machine route (main.ts) and the consumer command (position.ts) ask the same function, so both name the same state.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readInstalledState } from '@inventarch/distribution/services';
import type { HostFacts } from '@inventarch/runtime';

/** Canonical JSON: object keys sorted at every depth and absent ones left out, so equal values digest alike. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
          .join(',')}}`
      : JSON.stringify(value);
/**
 * `{format: 'ia-installed-state-1', status, pointer, lock, inputs}` in canonical JSON, hashed. An installed state that
 * cannot be read is left out, so the host note says null rather than the position being refused.
 */
export function hostFactsOf(root: string, version: string): HostFacts {
  let installedStateDigest: string | undefined;
  try {
    const { status, pointer, lock, inputs } = readInstalledState({ root: resolve(root) });
    installedStateDigest = createHash('sha256')
      .update(canonical({ format: 'ia-installed-state-1', status, pointer, lock, inputs }))
      .digest('hex');
  } catch {
    installedStateDigest = undefined;
  }
  return { cli: `ia@${version}`, ...(installedStateDigest === undefined ? {} : { installedStateDigest }) };
}
