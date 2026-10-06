import { fileURLToPath } from 'node:url';
import { installedImplementationDigest as workspaceRuntimeImplementationDigest } from '@inventarch/workspace-runtime/installed-catalog';

/** The generic workspace-runtime pin plus this package's own installed entrypoint, so the composition compiler and its
 * adapters stay pinned. Never a record- or model-supplied path. */
export function installedImplementationDigest(): string {
  return workspaceRuntimeImplementationDigest([['agent-composition-system', fileURLToPath(import.meta.url)]]);
}
