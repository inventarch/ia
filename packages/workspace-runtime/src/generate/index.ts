// Host generators over authored records. The CLI's projection writer applies generateHostSet's set.
export { generateAgentProfiles } from './agent-profile.js';
export { generatePlaybookSkills } from './playbook.js';
export { generateCapabilitySkills } from './capability.js';
export { generateDefinitions, generateHostSet } from './definitions.js';
export type { HostSet } from './definitions.js';
export {
  generateHooks,
  generateHookSet,
  HOOK_IDENTITY,
  HOOK_IDENTITY_LIMIT,
  HOOK_LIMIT,
  HOOK_SELECTION_LENGTH,
  HOOK_SELECTION_LIMIT,
  hookDeclaration,
  registrableHook,
  registrableSelection,
} from './hook.js';
export type { HookSet } from './hook.js';
export type { GeneratedFile, GeneratedSet, GeneratedWord, UnsupportedRecord } from './format.js';
export { renderPlugin, type PluginAsset, type PluginFile, type PluginResource } from './plugin.js';
