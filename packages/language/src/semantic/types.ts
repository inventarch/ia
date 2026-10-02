import type { Span } from '../ast.js';
import type { CompiledValue } from '../compile/values.js';
import type { Axis, Phase, Predicate, Primitive } from '../taxonomy.js';

export type ConditionAxis = Axis | 'severity' | 'provenance';
export interface Term {
  readonly axis: ConditionAxis;
  readonly value: string;
}
export interface SelectorTerm {
  readonly axis: Axis;
  readonly value: string;
}
export type Selector = readonly SelectorTerm[];

export type EdgeReference =
  | { readonly kind: 'ref'; readonly discriminator: string; readonly name: string; readonly fragment?: string }
  | { readonly kind: 'identity'; readonly identity: string; readonly fragment?: string };

export interface CompiledEdge {
  readonly predicate: Predicate;
  readonly direction: 'out' | 'in';
  readonly reference: EdgeReference;
  readonly target: string | null;
  readonly fragment?: string;
  readonly condition?: readonly Term[];
  readonly span: Span;
}

export interface Cell {
  readonly phase: Phase;
  readonly primitive: Primitive;
  readonly primary: boolean;
  readonly text: string;
  readonly condition?: readonly Term[];
  readonly span: Span;
}

export interface Variant {
  readonly key: string;
  readonly value: CompiledValue;
  readonly condition?: readonly Term[];
  readonly span: Span;
}

export const REQUIREMENT_KINDS = [
  'inputs',
  'outputs',
  'preconditions',
  'invariants',
  'failures',
  'authority',
  'context',
  'evolution',
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
export interface Requirement {
  readonly id: string;
  readonly kind: RequirementKind;
  readonly text: string;
  readonly condition?: readonly Term[];
  readonly span: Span;
}
