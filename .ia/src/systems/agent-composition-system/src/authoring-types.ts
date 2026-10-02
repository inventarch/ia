import type { ReadHandle } from '@ia/db';
import type { Phase, Primitive } from '@ia/language';
import type { ResourceKey, ResourceOccurrence } from './resource-format.js';

export interface AuthoringCriterion {
  readonly id: string;
  readonly version: string;
  readonly basis: 'structural' | 'semantic';
  readonly text: string;
}
export interface SystemReferenceInput {
  readonly system: ResourceOccurrence;
  readonly authoring: readonly ResourceKey[];
  readonly architecture: readonly ResourceKey[];
  readonly extensions: readonly ResourceKey[];
  readonly methods: readonly ResourceOccurrence[];
  /** Null is permitted only for the verified native taxonomy bootstrap declaration. */
  readonly steward: ResourceOccurrence | null;
  readonly base: ResourceOccurrence | null;
}
export type ArtifactSource =
  | { readonly kind: 'native'; readonly occurrence: ResourceOccurrence }
  | {
      readonly kind: 'resource';
      readonly key: ResourceKey;
      readonly range: { readonly start: number; readonly end: number } | null;
    };
export interface LifecycleCoordinate {
  readonly model: string;
  readonly version: string;
  readonly workflow: string;
  readonly iteration: number;
  readonly stage: string;
  readonly role: 'created' | 'refined' | 'consumed' | 'evaluated';
  readonly maturity: string;
  readonly phase: Phase | null;
  readonly primitive: Primitive | null;
}
export interface ArtifactInput {
  readonly id: string;
  readonly source: ArtifactSource;
  readonly purpose: string;
  readonly contract: ResourceKey | null;
  readonly dependencies: readonly string[];
  readonly lifecycle: readonly LifecycleCoordinate[];
}
export interface CapturedArtifact extends ArtifactInput {
  readonly revision: string;
}
export interface DocumentProfile {
  readonly id: string;
  readonly version: string;
  readonly roles: readonly {
    readonly id: string;
    readonly min: number;
    readonly max: number;
    readonly context: 'required-input' | 'expected-output' | 'optional';
    readonly contract: ResourceKey | null;
  }[];
  readonly criteria: readonly AuthoringCriterion[];
}
export interface DocumentInput {
  readonly id: string;
  readonly version: string;
  readonly profile: { readonly id: string; readonly version: string };
  readonly members: readonly { readonly artifact: string; readonly role: string; readonly order: number }[];
  readonly gaps: readonly { readonly role: string; readonly reason: string }[];
}
export interface CapturedDocument extends Omit<DocumentInput, 'members'> {
  readonly members: readonly {
    readonly artifact: string;
    readonly revision: string;
    readonly role: string;
    readonly order: number;
  }[];
}
export interface LifecycleModel {
  readonly id: string;
  readonly version: string;
  readonly stages: readonly string[];
  readonly transitions: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    readonly feedback: boolean;
    readonly criteria: readonly AuthoringCriterion[];
  }[];
}
/** Closed author-controlled associations. Capture helpers derive occurrence lines and all revision pins. */
export interface AuthoringIndexInput {
  readonly systems: readonly SystemReferenceInput[];
  readonly artifacts: readonly ArtifactInput[];
  readonly profiles: readonly DocumentProfile[];
  readonly documents: readonly DocumentInput[];
  readonly lifecycles: readonly LifecycleModel[];
}
export interface CapturedAuthoringIndex extends Omit<AuthoringIndexInput, 'artifacts' | 'documents'> {
  readonly format: 'ia.authoring-index.v1';
  readonly nativeCaptureRevision: string;
  readonly resourceDigest: string;
  readonly artifacts: readonly CapturedArtifact[];
  readonly documents: readonly CapturedDocument[];
  readonly digest: string;
}
/** Host-selected native scope and independent metadata/resource disclosure grants. */
export interface AuthoringScope {
  readonly reader: ReadHandle;
  readonly within: string;
  readonly allowedResources: readonly ResourceKey[];
  readonly allowedSystems: readonly string[];
  readonly allowedRegistrations: readonly string[];
  readonly allowedArtifacts: readonly string[];
  readonly allowedDocuments: readonly string[];
}
export type AuthoringStatus = 'resolved' | 'missing' | 'conflict' | 'unavailable';
export type AuthoringTarget =
  | ResourceOccurrence
  | { readonly kind: 'word'; readonly word: string }
  | { readonly kind: 'system'; readonly name: string }
  | { readonly kind: 'artifact'; readonly id: string }
  | { readonly kind: 'document'; readonly id: string };
export type AuthoringLifecycleSelection = Omit<LifecycleCoordinate, 'role' | 'maturity'>;
export interface AuthoringTargetRequest {
  readonly target: AuthoringTarget;
  readonly document: string | null;
  readonly lifecycle: AuthoringLifecycleSelection | null;
}
export interface PrimaryGuide {
  readonly key: string;
  readonly owner: string;
  readonly word: string;
  readonly status: AuthoringStatus;
  readonly proof: string;
  readonly descriptor: ResourceOccurrence | null;
  readonly schema: ResourceOccurrence | null;
  readonly document: {
    readonly key: ResourceKey;
    readonly sha256: string;
    readonly content: string;
    readonly citation: string;
  } | null;
}
export interface AuthoringView {
  readonly format: 'ia.authoring-view.v1';
  readonly captureRevision: string;
  readonly resourceDigest: string;
  readonly indexDigest: string;
  readonly viewRevision: string;
  readonly scopeDigest: string;
  readonly proof: string;
  readonly guides: readonly PrimaryGuide[];
  readonly systems: readonly {
    readonly name: string;
    readonly status: AuthoringStatus;
    readonly system: ResourceOccurrence | null;
    readonly teaching: 'not-evaluated';
    readonly parts: readonly RequiredAuthoringPart[];
    readonly proof: string;
  }[];
  readonly artifacts: readonly {
    readonly id: string;
    readonly revision: string;
    readonly status: AuthoringStatus;
    readonly part: RequiredAuthoringPart | null;
    readonly dependencies: readonly string[];
    readonly lifecycle: readonly LifecycleCoordinate[];
  }[];
  readonly documents: readonly { readonly id: string; readonly status: AuthoringStatus; readonly proof: string }[];
  readonly catalogue: {
    readonly expectedKeys: readonly string[];
    readonly keys: readonly string[];
    readonly complete: boolean;
    readonly digest: string;
  };
}
export interface RequiredAuthoringPart {
  readonly id: string;
  readonly text: string;
  readonly citations: readonly string[];
}
export interface AuthoringRequirements {
  readonly parts: readonly RequiredAuthoringPart[];
  readonly missing: readonly { readonly id: string; readonly reason: string }[];
  readonly expectedOutputs: readonly { readonly role: string; readonly reason: string }[];
  readonly criteria: readonly {
    readonly id: string;
    readonly version: string;
    readonly basis: 'structural' | 'semantic';
    readonly status: 'satisfied' | 'unsatisfied' | 'not-evaluated';
  }[];
  readonly proof: string;
}
