import type { LifecycleProfile } from './lifecycle-profile.js';
import { frozen, metadataDigest } from './resource-format.js';

/** Each available Claude Code row, keyed by its literal version, and its closed UserPromptSubmit fields. */
export const claudeCodeRows: ReadonlyMap<string, readonly string[]> = new Map([
  ['2.1.278', ['prompt']],
  ['2.1.285', ['prompt', 'session_title']],
]);
/**
 * The closed exception to folding a row's field table into its digested profile body. Bindings already written,
 * recorded host evidence and a recorded decision pin these two digests, which predate the fold, so a component test
 * pins their tables instead. Every row added from here folds; never add a version to this set.
 */
export const UNFOLDED_CLAUDE_CODE_ROWS: ReadonlySet<string> = new Set(['2.1.278', '2.1.285']);
/** One host/version profile against a row table. `lifecycleProfile` validates its strings and passes the installed table. */
export function profileFromRows(
  rows: ReadonlyMap<string, readonly string[]>,
  host: string,
  version: string,
): LifecycleProfile {
  const native = host === 'ia-native' && version === '1',
    fields = host === 'claude-code' ? rows.get(version) : undefined,
    available = fields !== undefined || native;
  const body = {
    format: 'ia.lifecycle-profile.v1' as const,
    host,
    version,
    available,
    reason: available
      ? null
      : host === 'codex' && version === '0.116.0'
        ? 'Installed Codex 0.116.0 hooks are unavailable: the feature is under development and disabled.'
        : 'This host version has no qualified lifecycle profile.',
    maxContextCharacters: native ? null : 10_000,
    maxContextParts: native ? 1 : 12,
    events: native ? ['NativeContext'] : available ? ['SessionStart', 'UserPromptSubmit'] : [],
    maxInputBytes: 1024 * 1024,
    maxPromptBytes: 256 * 1024,
    ...(fields === undefined || UNFOLDED_CLAUDE_CODE_ROWS.has(version) ? {} : { promptFields: [...fields] }),
  };
  return frozen({ ...body, digest: metadataDigest(body) });
}
