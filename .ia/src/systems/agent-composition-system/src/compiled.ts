import type { Json } from '@ia/session-system';
import type { Profile, OperationDefinition } from '@ia/agent-system';
import type { ResourceLimits, EffectClass } from './catalog.js';

export type CompositionCode =
  | 'IA-COMPOSITION-REFERENCE'
  | 'IA-COMPOSITION-CYCLE'
  | 'IA-COMPOSITION-CONFLICT'
  | 'IA-COMPOSITION-UNAVAILABLE'
  | 'IA-COMPOSITION-ROLE';
export interface CompositionDiagnostic {
  code: CompositionCode;
  message: string;
  source?: { identity: string; path: string; line: number };
  field?: string;
  admission?: { code: string; path: string; line: number }[];
}
export class CompositionError extends Error {
  constructor(readonly diagnostic: CompositionDiagnostic) {
    super(diagnostic.message);
    this.name = 'CompositionError';
  }
}
export interface ComponentPin {
  identity: string;
  owner: string;
  physicalOwner: string | null;
  schema: string;
  source: { path: string; line: number; endLine: number; digest: string };
  digest: string;
}
export interface CompiledCapability {
  identity: string;
  includes: string[];
  operations: string[];
  playbooks: string[];
  templates: string[];
  checks: string[];
  effects: EffectClass[];
  limits: ResourceLimits;
  input: string;
  outcomes: string;
  context: string;
  mapping: string;
}
export interface CompiledProfile extends Profile {
  requestBytes?: number;
  native: string;
  mandate: string | null;
  mandateContracts: string[];
  inputContracts: { id: string; schema: Json }[];
  effects: EffectClass[];
  limits: ResourceLimits;
  contexts: string[];
  templates: string[];
  delegation: { profile: string; limits: ResourceLimits }[];
}
/** Compiler output remains distinct from the v1 development manifest.
 * executionManifest retains these obligations for engine and current host admission. */
export interface CompiledHarness {
  format: 'ia.compiled-harness.v1';
  digest: string;
  id: string;
  workspace: string;
  sourceDigest: string;
  entry: { binding: string; profile: string; mapping: string };
  profiles: Record<string, CompiledProfile>;
  capabilities: Record<string, CompiledCapability>;
  operations: Record<
    string,
    OperationDefinition & {
      native: string;
      owner: string;
      physicalOwner: string;
      maxOutputBytes: number;
      preflight: string;
    }
  >;
  bindings: { identity: string; kind: 'operation' | 'entry'; implementation: string; target: string; digest: string }[];
  provenance: {
    executableDigest: string;
    components: ComponentPin[];
    sources: { path: string; digest: string }[];
    installed: { group: string; id: string; digest: string }[];
    fields: Record<string, string[]>;
  };
}
export type Compilation = { ok: true; manifest: CompiledHarness } | { ok: false; diagnostics: CompositionDiagnostic[] };
