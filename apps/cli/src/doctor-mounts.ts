import { adoptedBindings, readInputs } from '@inventarch/db';
import type { Check } from './doctor.js';
import { quote } from './render.js';

/** A mount is healthy only when the pinned native sources still match, independent of registry availability. */
export function sourceBindingRows(root: string): readonly Check[] {
  try {
    const bindings = adoptedBindings(root);
    if (!bindings.length) return [];
    readInputs(root);
    return bindings.map((binding) => ({
      id: `source-${binding.id}`,
      section: 'Workspace',
      title: 'Source mount',
      status: 'ok',
      detail: `${binding.tree}/.ia/src @${binding.placement ?? 'adopted'} (band ${binding.placement === 'open' ? 50 : 90}); pinned ${binding.revision}`,
      remedy: null,
    }));
  } catch (error) {
    return [
      {
        id: 'source-bindings',
        section: 'Workspace',
        title: 'Source mounts',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
        remedy: `ia validate --root ${quote(root)}`,
      },
    ];
  }
}
