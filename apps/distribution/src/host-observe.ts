import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDistributionJson } from '@ia/db/distribution';
import { bytes, json, utf8, workspace } from './files.js';
import { reconcileConfig } from './config.js';
import {
  derivedCommand,
  HOST_CONFIG,
  HOST_REGISTRATION,
  recordedNode,
  saved as readHostState,
  verifyHostCache,
} from './host.js';
import { currentGuardForm, guardNode, saved as readGuardState } from './guard-registration.js';
import type { WorkspaceHost as Host } from './hosts.js';
import { WORKSPACE_HOSTS, workspaceRow } from './hosts.js';

type Element = 'mcp' | 'hooks' | 'projection';
export type StaleReason =
  | 'release'
  | 'launcher-missing'
  | 'launcher-unverified'
  | 'mcp-modified'
  | 'guard-modified'
  | 'guard-form'
  | 'guard-release'
  | 'guard-launcher'
  | 'node-missing'
  | 'state-invalid';
export interface HostObservation {
  readonly host: Host;
  readonly status: 'registered' | 'stale';
  readonly release: string | null;
  readonly cache: string | null;
  readonly launcher: string | null;
  readonly launcherExists: boolean;
  readonly reasons: readonly StaleReason[];
  readonly elements: readonly Element[];
}
const area = '.ia/distributions/hosts';
/** Our own state files: written only by `applyHost`/`applyGuardRegistration`/`applyProjection`. */
const readOwned = (root: string, path: string): string | null => {
  const value = bytes(root, path, 1024 * 1024);
  return value === null ? null : utf8(value);
};
/**
 * `.mcp.json`, `.codex/config.toml` and `.claude/settings.local.json` are user-owned surfaces this authority only
 * partially controls. Observation must survive a hand-corrupted or non-UTF-8 file: unreadable bytes are reported
 * as drift, never an exception (spec §7/§9: doctor never claims more than it observed, and never crashes on it).
 */
const readUser = (root: string, path: string): string | null => {
  try {
    const value = bytes(root, path, 1024 * 1024);
    return value === null ? null : utf8(value);
  } catch {
    return null;
  }
};
/** As `readUser`, but also swallows a JSON syntax error so a malformed `.mcp.json`/settings file yields a `*-modified` reason instead of a crash. */
function readUserJson(root: string, path: string): Record<string, unknown> | null {
  const text = readUser(root, path);
  if (text === null) return null;
  try {
    const value = decodeDistributionJson(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
/** Memoizes `verifyHostCache` per cache directory for the lifetime of one `observeHosts` call: the mcp and guard elements often (though not always) name the same cache, and re-scanning its whole payload twice buys nothing. Failures are cached too, so a repeated broken directory only scans once. */
function verifier(): (directory: string) => ReturnType<typeof verifyHostCache> {
  const cache = new Map<
    string,
    | { readonly ok: true; readonly value: ReturnType<typeof verifyHostCache> }
    | { readonly ok: false; readonly error: unknown }
  >();
  return (directory) => {
    let entry = cache.get(directory);
    if (!entry) {
      try {
        entry = { ok: true, value: verifyHostCache(directory) };
      } catch (error) {
        entry = { ok: false, error };
      }
      cache.set(directory, entry);
    }
    if (!entry.ok) throw entry.error;
    return entry.value;
  };
}
/** Spec §9: never a guess. A corrupted own state file is reported, not fabricated data for the fields it would have supplied. */
function invalid(host: Host): HostObservation {
  return {
    host,
    status: 'stale',
    release: null,
    cache: null,
    launcher: null,
    launcherExists: false,
    reasons: ['state-invalid'],
    elements: [],
  };
}
const ABSENT = 'absent',
  BROKEN = 'broken';
/**
 * Every read of one of *our own* files below is wrapped, not just the parse: `readOwned` itself can throw
 * (non-UTF-8 bytes, a file over the byte cap, a hardlinked or otherwise unaliased path, or a directory sitting at
 * the expected path), and a hostile or corrupted filesystem must degrade one host's row rather than abort the
 * whole call. `ABSENT` (no file — not a failure) and `BROKEN` (a file exists but could not be read or validated)
 * are kept distinct so an absent registration stays silently absent while a broken one is reported.
 */
function stateRow(
  root: string,
  host: Host,
): typeof ABSENT | typeof BROKEN | NonNullable<ReturnType<typeof readHostState>> {
  try {
    const text = readOwned(root, `${area}/${host}-${HOST_REGISTRATION}.json`);
    if (text === null) return ABSENT;
    return readHostState(text, host, HOST_REGISTRATION) ?? BROKEN;
  } catch {
    return BROKEN;
  }
}
function guardRow(root: string): typeof ABSENT | typeof BROKEN | NonNullable<ReturnType<typeof readGuardState>> {
  try {
    const text = readOwned(root, `${area}/claude-guard-${HOST_REGISTRATION}.json`);
    if (text === null) return ABSENT;
    return readGuardState(text, root, HOST_REGISTRATION) ?? BROKEN;
  } catch {
    return BROKEN;
  }
}
function hasProjection(root: string, host: Host): boolean | typeof BROKEN {
  try {
    return readOwned(root, `${area}/${host}-projection.json`) !== null;
  } catch {
    return BROKEN;
  }
}
/**
 * Spec §7. `currentRelease` is the running CLI's payload release, or null when it ships none. Never writes; never
 * throws. Two independent failure surfaces are both absorbed rather than propagated: a malformed or unreadable
 * *user* file (`.mcp.json`, `.codex/config.toml`, `.claude/settings.local.json`) reads as the corresponding
 * `*-modified` drift, and a corrupted or unreadable *own* file (`stateRow`/`guardRow`/`hasProjection` above) —
 * either our own `IA-DIST-*` refusal or the filesystem's/JSON codec's own error — degrades to `state-invalid`
 * rather than aborting `readInstalledState`/`ia inspect` for every host over one bad file.
 */
export function observeHosts(rootInput: string, currentRelease: string | null): HostObservation[] {
  const root = workspace(rootInput),
    out: HostObservation[] = [],
    verify = verifier();
  for (const host of WORKSPACE_HOSTS) {
    const found = stateRow(root, host);
    if (found === ABSENT) continue;
    if (found === BROKEN) {
      out.push(invalid(host));
      continue;
    }
    const state = found,
      launcher = join(state.cache, 'scripts/ia.mjs'),
      launcherExists = existsSync(launcher);
    const reasons: StaleReason[] = [],
      elements: Element[] = ['mcp'];
    const stale = (reason: StaleReason): void => {
      if (!reasons.includes(reason)) reasons.push(reason);
    };
    if (currentRelease !== null && state.release !== currentRelease) reasons.push('release');
    if (!launcherExists) reasons.push('launcher-missing');
    else {
      try {
        if (verify(state.cache).release !== state.release) reasons.push('launcher-unverified');
      } catch {
        reasons.push('launcher-unverified');
      }
    }
    // The recorded entry must be the one derived from the state's own cache and this root, run by a Node executable
    // that is still there: a state whose owned entry names another command is not a registration this authority wrote.
    const command = derivedCommand(state, root),
      node = command === null ? 'modified' : recordedNode(command);
    if (node === 'modified') stale('mcp-modified');
    else if (node === 'missing') stale('node-missing');
    if (HOST_CONFIG[host].format === 'json') {
      const servers = readUserJson(root, HOST_CONFIG[host].file)?.['mcpServers'],
        table =
          servers !== null && typeof servers === 'object' && !Array.isArray(servers)
            ? (servers as Record<string, unknown>)
            : {};
      if (json(table[`ia-${HOST_REGISTRATION}`]) !== state.owned) stale('mcp-modified');
    } else {
      // Mirrors what `planHost`'s codex branch enforces on apply: the owned block must be uniquely located, byte-identical, and its parsed role must carry no field beyond what this authority wrote (a sibling table extending the same key fails this the same way a hand edit does).
      try {
        reconcileConfig(
          readUser(root, '.codex/config.toml') ?? '',
          'host-' + HOST_REGISTRATION,
          state.owned,
          state.owned,
          'mcp_servers',
        );
      } catch {
        stale('mcp-modified');
      }
    }
    // The steward guard is a hooks element, so it is observed only for a host whose row declares hooks (spec §4).
    if (workspaceRow(host)?.hooks) {
      const guard = guardRow(root);
      if (guard !== ABSENT) {
        elements.push('hooks');
        if (guard === BROKEN) reasons.push('state-invalid');
        else {
          const settings = readUserJson(root, '.claude/settings.local.json');
          const hooksField = settings?.['hooks'],
            preToolUse =
              hooksField !== null && typeof hooksField === 'object' && !Array.isArray(hooksField)
                ? (hooksField as Record<string, unknown>)['PreToolUse']
                : undefined;
          const rows = Array.isArray(preToolUse) ? preToolUse : [];
          if (rows.filter((row) => json(row) === json(guard.group)).length !== 1) stale('guard-modified');
          // `readGuardState` already holds the group's arguments to the fixed derivation; the Node it runs must be Node's.
          const handler = guard.group.hooks[0] ?? {},
            node = recordedNode(guardNode(handler, join(guard.cache, 'scripts/ia.mjs'), root));
          if (node === 'modified') stale('guard-modified');
          else if (node === 'missing') stale('node-missing');
          // An owned group in a form this release no longer writes (the fail-open direct form on POSIX, an earlier script).
          if (node !== 'modified' && !currentGuardForm(handler)) stale('guard-form');
          // The guard pins its own cache/release independently of the mcp element; the two can drift apart (e.g. one re-applied, the other not).
          if (guard.release !== state.release) reasons.push('guard-release');
          if (!existsSync(join(guard.cache, 'scripts/ia.mjs'))) reasons.push('guard-launcher');
          else {
            try {
              if (verify(guard.cache).release !== guard.release) reasons.push('guard-launcher');
            } catch {
              reasons.push('guard-launcher');
            }
          }
        }
      }
    }
    const projection = hasProjection(root, host);
    if (projection === BROKEN) reasons.push('state-invalid');
    else if (projection) elements.push('projection');
    out.push({
      host,
      status: reasons.length ? 'stale' : 'registered',
      release: state.release,
      cache: state.cache,
      launcher,
      launcherExists,
      reasons,
      elements,
    });
  }
  return out;
}
