/** The public registry API (spec §3-§5, §7): layout types and decoders, sources, configuration and resolution. */
export { decodePackageIndex, decodeRegistryInfo, packageIndexPath, REGISTRY_LIMITS } from './registry-layout.js';
export type { PackageIndex, RegistryDependency, RegistryInfo, RegistryRelease } from './registry-layout.js';
export { openRegistry, parseRegistryBase, registryBudget, registryLocation } from './registry-source.js';
export type { Registry, RegistryBase, RegistryBudget } from './registry-source.js';
export { DEFAULT_REGISTRIES, registryChooser, registryFor, userConfigDir } from './registry-config.js';
export type { RegistryChoice, RegistryLevel, RegistryOptions } from './registry-config.js';
export { registryWithdrawals, resolveFromRegistries, unpublishedPins } from './registry-resolve.js';
export type { Acquirer, RegistryResolution, RegistryResolveRequest } from './registry-resolve.js';
