import type { Range } from '@ia/language/editor';
import type { Phase, Primitive } from '@ia/language';
export type { Position, Range } from '@ia/language/editor';
export type { Overlay, EditorSource } from '@ia/db/editor';
export type { Phase, Primitive } from '@ia/language';
export interface ViewStamp {
  readonly protocol: 1;
  readonly ownerSession: string;
  readonly generation: number;
  readonly savedRevision: string;
  readonly viewRevision: string;
  readonly location: string;
  readonly phase: Phase | null;
}
export interface SourceLink {
  readonly action: string;
  readonly path: string;
  readonly range: Range;
  readonly readOnly: boolean;
}
export interface SourceResult extends SourceLink {
  readonly text: string;
  readonly virtual: boolean;
}
export interface RecordSummary {
  readonly occurrence: string;
  readonly identity: string | null;
  readonly name: string;
  readonly discriminator: string;
  readonly system: string | null;
  readonly kind: string | null;
  readonly description: string;
  readonly status: 'admitted' | 'syntax-only' | 'refused' | 'shadowed' | 'tied' | 'inactive' | 'blocked';
  readonly source: SourceLink;
}
export interface EditorFinding {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly path: string;
  readonly range: Range;
}
export interface EditorView {
  readonly stamp: ViewStamp;
  readonly records: readonly RecordSummary[];
  readonly diagnostics: readonly EditorFinding[];
  readonly systems: readonly string[];
  readonly outcome: string;
  readonly health: readonly { check: string; outcome: string }[];
}
interface EditorDependencyBase {
  readonly id: string;
  readonly prefix: string;
  readonly files: number;
  readonly records: number;
  readonly systems: readonly string[];
}
export interface EditorAdoption extends EditorDependencyBase {
  readonly kind: 'adopted';
  readonly revision: string;
  readonly access: 'captured-source';
}
export interface EditorInstallation extends EditorDependencyBase {
  readonly kind: 'installed';
  readonly version: string;
  readonly archive: string;
  readonly access: 'installed-package';
}
export type EditorDependency = EditorAdoption | EditorInstallation;
export interface EditorDependencyUse {
  readonly occurrence: string;
  readonly dependency: string;
  readonly reason: 'schema' | 'registration' | 'reference';
  readonly target: SourceLink;
}
/** Presentation of the captured source and installed package composition; not a mount, publication or write grant. */
export interface EditorComposition {
  readonly stamp: ViewStamp;
  readonly localRevision: string;
  readonly dependencies: readonly EditorDependency[];
  readonly uses: readonly EditorDependencyUse[];
}
/** Design C04: what a completion item cites; its longer documentation is loaded only when the item is selected. */
export type CompletionCitation =
  | { readonly kind: 'record'; readonly identity: string }
  | { readonly kind: 'word'; readonly keyword: string }
  | { readonly kind: 'field'; readonly schema: string; readonly section: string; readonly key: string };
export interface Completion {
  readonly label: string;
  readonly insertText: string;
  readonly range: Range;
  readonly kind: 'keyword' | 'field' | 'reference' | 'value' | 'snippet';
  readonly detail: string;
  readonly documentation?: string;
  readonly citation?: CompletionCitation;
}
export interface Hover {
  readonly range: Range;
  readonly markdown: string;
}
export interface Symbol {
  readonly name: string;
  readonly detail: string;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly path: string;
}
export interface SemanticToken {
  readonly line: number;
  readonly character: number;
  readonly length: number;
  readonly type: string;
  readonly modifiers: readonly string[];
}
export interface Relationship {
  readonly from: string | null;
  readonly to: string | null;
  readonly predicate: string;
  readonly state: 'active' | 'conditional' | 'gated' | 'dangling';
  readonly source: SourceLink;
  readonly fromSource: SourceLink | null;
  readonly toSource: SourceLink | null;
  readonly condition: string;
}
/** Syntactic nesting of one admitted record inside another; presentation only, never semantic adjacency, reach or a traversal/semantic truncation input. */
export interface Containment {
  readonly parent: string;
  readonly child: string;
  readonly source: SourceLink;
}
/** N04 overlay: links touching a visible node; `nodes` holds structural-only endpoints absent from the semantic neighborhood. */
export interface ContainmentView {
  readonly links: readonly Containment[];
  readonly nodes: readonly RecordSummary[];
  readonly truncated: boolean;
}
export interface GraphView {
  readonly stamp: ViewStamp;
  readonly nodes: readonly RecordSummary[];
  readonly edges: readonly Relationship[];
  readonly containment: ContainmentView;
  readonly truncated: boolean;
  readonly totals: { readonly nodes: number; readonly edges: number };
  readonly groups: readonly { readonly system: string; readonly count: number }[];
}
export interface Inspection {
  readonly stamp: ViewStamp;
  readonly record: RecordSummary;
  readonly relationships: readonly Relationship[];
  readonly schema: {
    readonly name: string;
    readonly closed: boolean;
    readonly fields: readonly {
      readonly section: string;
      readonly key: string;
      readonly type: string;
      readonly must: boolean;
    }[];
    readonly source: SourceLink;
  } | null;
  readonly cells: readonly {
    readonly phase: Phase;
    readonly primitive: Primitive;
    readonly text: string;
    readonly primary: boolean;
    readonly source: SourceLink;
  }[];
  readonly selectedCell: { readonly kind: string; readonly text: string } | null;
  readonly checks: readonly {
    readonly check: string;
    readonly outcome: string;
    readonly messages: readonly string[];
  }[];
  readonly typedReferences: number;
  readonly incomingRelationships: number;
}
export interface ProposedFile {
  readonly path: string;
  readonly text: string;
}
export interface ProposalValidation {
  readonly stamp: ViewStamp;
  readonly allowed: boolean;
  readonly messages: readonly string[];
  readonly diagnostics: readonly EditorFinding[];
  readonly files: readonly (ProposedFile & { readonly hash: string })[];
}
export interface DraftShape {
  readonly discriminator: string;
  readonly system: string;
  readonly schema: string;
  readonly sections: readonly { readonly name: string; readonly must: boolean }[];
  readonly fields: readonly {
    readonly section: string;
    readonly key: string;
    readonly type: string;
    readonly must: boolean;
    readonly description?: string;
  }[];
}
