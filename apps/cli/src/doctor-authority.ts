import { pathKey } from '@inventarch/db';
import { governingMandates, MOVES } from '@inventarch/runtime';
import { generateHooks } from '@inventarch/workspace-runtime/internal/generate';
import type { Check } from './doctor.js';
import { quote } from './render.js';
import { codeOf, openEditor } from './session.js';

/**
 * Read declarations only. A literal directory or recursive selection covering all .ia/src is enough; a glob that
 * happens to match today's files is not proof that tomorrow's source is selected. Host registration and activation
 * are separate observations. No hook is silently extended to cover .ia/src.
 */
const SOURCE_TREES = new Set(['.ia/src/', '.ia/src/**', '.ia/', '.ia/**', '**']);
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit'] as const;

export function sourceProtectionCheck(root: string): Check {
  const row = { id: 'source-protection', section: 'Workspace', title: 'Source protection' } as const;
  const remedy = `ia position --shape governance --root ${quote(root)}`;
  try {
    const editor = openEditor(root);
    try {
      const reader = editor.snapshot,
        within = reader.resolveScope().token;
      // This also fails closed on unadmitted mandates and their authority dependencies.
      const mandates = governingMandates(reader, within).filter((mandate) => {
        const node = reader.get(mandate.identity, { within })!;
        const executionLimit = node.sections.some(
          (section) =>
            section.name === 'execution' &&
            section.fields.some((field) => 'key' in field && field.key.startsWith('limit-')),
        );
        return (
          executionLimit ||
          (mandate.excludedWords?.length ?? 0) > 0 ||
          (mandate.moves !== undefined && MOVES.some((move) => !mandate.moves!.includes(move)))
        );
      });
      if (mandates.length === 0)
        return {
          ...row,
          status: 'info',
          detail: 'No authored mandate declares a move, word or execution-limit restriction.',
          remedy: null,
        };
      const hooks = generateHooks(reader, within, 'claude').filter((hook) =>
        hook.paths.some((path) => SOURCE_TREES.has(pathKey(path))),
      );
      const missing = EDIT_TOOLS.filter((tool) => !hooks.some((hook) => hook.tools.includes(tool)));
      if (missing.length > 0)
        return {
          ...row,
          status: 'warn',
          detail: `${mandates.length} authored mandate(s) declare restrictions, but no supported hook explicitly covers all .ia/src sources for ${missing.join(', ')}. Direct source edits can change those restrictions. An owner can declare a PreToolUse hook with paths [".ia/src/**"] and tools [Write, Edit, MultiEdit], then register it for a supported host. Existing hook paths are never widened.`,
          remedy,
        };
      return {
        ...row,
        status: 'info',
        detail: `${mandates.length} authored mandate(s) declare restrictions; ${hooks.map((hook) => hook.identity).join(', ')} explicitly select .ia/src for all edit tools. This checks declarations only, not host registration or enforcement. The edit guard checks Synthesis; it does not enforce word exclusions or execution limits on file bytes.`,
        remedy: null,
      };
    } finally {
      editor.close();
    }
  } catch (error) {
    return {
      ...row,
      status: 'unknown',
      detail: `Not checked; ${codeOf(error, 'the workspace authority could not be read')}`,
      remedy,
    };
  }
}
