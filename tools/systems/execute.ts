import { validateIA, formatIA } from '../../.ia/src/systems/authoring-system/execute.js';
import { renderTemplate } from '../../.ia/src/systems/template-system/execute.js';
import type { Context, Handler, Result, Success } from './types.js';
import { executeOwned, executeCatalog } from '@inventarch/runtime/authoring-execution';

const catalog: Readonly<
  Record<string, { owner: string; handler: string; effects: 'read-only' | 'draft-only'; run: Handler }>
> = Object.freeze({
  'validate-ia': { owner: 'authoring-system', handler: 'ia-validate', effects: 'read-only', run: validateIA },
  'format-ia': { owner: 'authoring-system', handler: 'ia-format', effects: 'draft-only', run: formatIA },
  'render-template': {
    owner: 'template-system',
    handler: 'template-render',
    effects: 'draft-only',
    run: renderTemplate,
  },
});
export const OPERATION_NAMES = Object.freeze(Object.keys(catalog));
export function executeWithContext(context: Context, name: string, input: unknown): Success {
  return executeOwned(context, name, input, catalog);
}
export function execute(root: string, name: string, input: unknown): Result {
  return executeCatalog(root, name, input, catalog);
}
export { refusal } from '@inventarch/runtime/authoring-execution';
