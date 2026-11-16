import { copy, digest } from '@inventarch/session-system';
import type { Json, Limits, Recovery } from '@inventarch/session-system';
import type { IndependentReviewPolicy, OutcomeKind, OperationDefinition } from '@inventarch/agent-system';
import type { Category, Phase, Primitive } from '@inventarch/language';

export type EffectClass = OperationDefinition['effects'][number];
/** Relative duration is compiled; the execution host establishes the absolute deadline. */
export type ResourceLimits = Partial<Omit<Limits, 'deadline'>> & { durationMs?: number };
export interface Installed<T> {
  /** The contract's version, a positive integer. It is part of the digest, so a pin on the digest pins it. */
  version: number;
  digest: string;
  value: T;
}
export interface HostContract {
  /** Installed complete inference-request bound, independent of cumulative resource limits. */
  requestBytes?: number;
  effects: EffectClass[];
  models: string[];
  limits: ResourceLimits;
  defaults: { model: string; input: string; outcomes: string; context: string; mapping: string };
}
export interface OutcomeContract {
  kinds: OutcomeKind[];
  completion: 'response' | 'proposal' | 'artifact';
}
export interface MandateContract {
  review?: IndependentReviewPolicy;
  input: string;
  outcomes: string;
  effects: EffectClass[];
  context: string;
  limits: ResourceLimits;
  checks: string[];
  models?: string[];
}
export interface ContextContract {
  scope: 'captured-workspace';
  coordinate: { phase: Phase; primitive: Primitive; category?: Category };
  tokens: number;
  records: number;
}
export interface OperationContract {
  identity: string;
  owner: string;
  handler: string;
  input: string;
  output: string;
  implementationDigest: string;
  effects: EffectClass[];
  recovery: Recovery;
  timeoutMs: number;
  maxOutputBytes: number;
  preflight: 'captured-workspace' | 'managed-draft';
  purpose?: 'candidate-validation';
}
/** Catalogs describe already installed implementations. Compilation never loads or calls them. */
export interface CompositionCatalog {
  hosts: Record<string, Installed<HostContract>>;
  models: Record<string, Installed<{ model: string }>>;
  validators: Record<string, Installed<{ schema: Json }>>;
  outcomes: Record<string, Installed<OutcomeContract>>;
  mandates: Record<string, Installed<MandateContract>>;
  contexts: Record<string, Installed<ContextContract>>;
  operations: Record<string, Installed<OperationContract>>;
  evaluators: Record<string, Installed<{ phases: ('before-effect' | 'completion')[] }>>;
  entries: Record<string, Installed<{ target: 'agent-profile'; mapping: string }>>;
  mappings: Record<string, Installed<{ kind: 'identity' }>>;
}
export type CatalogGroup = keyof CompositionCatalog;
/**
 * Names a catalogue no longer installs, mapped to the plain name of the entry that replaces each one. A record that
 * still names an old contract compiles to its replacement; the catalogue keeps the original entry, byte for byte, for
 * harnesses already pinned to it.
 */
export type CatalogAliases = Partial<Record<CatalogGroup, Readonly<Record<string, string>>>>;
export function installed<T>(value: T, version = 1): Installed<T> {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new RangeError('An installed contract version is a positive integer');
  const body = { version, value: copy(value) };
  return { ...body, digest: digest(body) };
}
