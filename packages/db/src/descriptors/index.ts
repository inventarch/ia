/**
 * OS09 descriptor producer (docs/specs/domain-and-app-descriptors/README.md): bounded, versioned, pure
 * codecs and compilers for domain-model, storage-binding and app-composition resources. No I/O, DDL or code
 * execution; compilation joins resources only to their native envelope and a host-built trusted registry.
 */
export { DESCRIPTOR_FORMAT, DESCRIPTOR_LIMITS } from './codec.js';
export type {
  ContractRef,
  DecodedResource,
  DescriptorCode,
  DescriptorDiagnostic,
  DescriptorKind,
  DescriptorResult,
} from './codec.js';
export { decodeDescriptorResource, envelopeFromRecord } from './envelope.js';
export type { DescriptorEnvelope, DisclosedResources } from './envelope.js';
export { createDescriptorRegistry, isTrustedRegistry } from './registry.js';
export type {
  ContractKind,
  DescriptorRegistry,
  EffectClass,
  RegisteredContract,
  TransactionBoundary,
} from './registry.js';
export { classifyModelChange, compileDomainModel, isCompiledDomainModel } from './domain.js';
export type {
  BoundInvariant,
  BoundOperation,
  ChangeKind,
  CompiledDomainModel,
  DefinitionDigests,
  DomainEntity,
  DomainField,
  DomainInput,
  ExternalReference,
  FieldType,
  IdCodec,
  ModelChange,
  ModelChangeReport,
  ModelEntityRef,
  ScalarType,
} from './domain.js';
export { compileStorageBinding } from './storage.js';
export type { CompiledStorageBinding, EntityMapping, FieldMapping, StorageCodec, StorageInput } from './storage.js';
export { activateTarget, compileAppComposition } from './app.js';
export type {
  AppInput,
  CompiledAction,
  CompiledAppComposition,
  CompiledConfiguration,
  CompiledScreen,
  ConfigurationValue,
  ContractBinding,
  LayoutValue,
  TargetSupport,
} from './app.js';
