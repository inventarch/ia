export type { Manifest, Profile, OperationDefinition } from '@inventarch/agent-system';
export { compileHarness } from './compile.js';
export { executionManifest, compiledAliases } from './execution.js';
/** The workspace-runtime pin plus this package's own installed bytes; not the bare @inventarch/workspace-runtime export. */
export { installedImplementationDigest } from './installed-catalog.js';
export type { CompileOptions } from './compile.js';
export { installed } from './catalog.js';
export type {
  CatalogAliases,
  CompositionCatalog,
  Installed,
  HostContract,
  MandateContract,
  ContextContract,
  OperationContract,
  ResourceLimits,
  EffectClass,
  OutcomeContract,
} from './catalog.js';
export {
  INSTALLED_READ,
  INSTALLED_READ_LEGACY,
  installedReadAliases,
  installedReadCatalog,
  installedReadAdapters,
} from './installed-read.js';
export type { InstalledReadCatalog, InstalledReadOptions } from './installed-read.js';
export { CompositionError } from './compiled.js';
export type {
  Compilation,
  CompiledHarness,
  CompiledProfile,
  CompiledCapability,
  ComponentPin,
  CompositionDiagnostic,
  CompositionCode,
} from './compiled.js';

export {
  prepareTaskCapture,
  verifyTaskCapture,
  taskTeachingDigest,
  TaskCaptureError,
  TASK_CAPTURE_BYTES,
  TASK_CAPTURE_POLICY,
  taskCaptureRequest,
} from './task-capture.js';
export type {
  TaskContextDeclaration,
  TaskCaptureFullView,
  TaskCaptureRequest,
  TaskCaptureSelection,
  PreparedTaskCapture,
} from './task-capture.js';
