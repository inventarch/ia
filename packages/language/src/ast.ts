import type { Diagnostic } from './diagnostics.js';

/** 1-based, inclusive source line range. */
export interface Span {
  readonly line: number;
  readonly endLine: number;
}

/**
 * A field's value. `scalar` is an unquoted run of words; `string` a `"..."` literal; `prose` a
 * `"""..."""` value after folding; `ref` a `@discriminator name[#fragment]` target; `list` a
 * `[...]`; `block` a bare key that opens an indented block (derived: a `none` value whose field
 * has children and whose line produced no diagnostic); `none` a bare key with nothing under it.
 */
export type Value =
  | { readonly kind: 'scalar'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string; readonly raw: string }
  | { readonly kind: 'prose'; readonly text: string; readonly raw: string }
  /** `raw` is the canonical rendering `@discriminator name[#fragment]`, not the authored bytes. */
  | {
      readonly kind: 'ref';
      readonly discriminator: string;
      readonly name: string;
      readonly fragment?: string;
      readonly raw: string;
    }
  | { readonly kind: 'list'; readonly items: readonly ListItem[] }
  | { readonly kind: 'block' }
  | { readonly kind: 'none' };

/** A list item is a scalar, a string or a ref; derived from `Value` so the shapes cannot drift. */
export type ListItem = Extract<Value, { kind: 'scalar' | 'string' | 'ref' }>;

/** A `key value` line. `words` is every unquoted word before any string, prose, list or ref, in order. */
export interface FieldNode {
  readonly kind: 'field';
  readonly key: string;
  readonly words: readonly string[];
  readonly value: Value;
  /** Words after a trailing ` when `, when present: the condition, uninterpreted here. A quoted string keeps its quotes; a reference is its `@discriminator` and name words. */
  readonly when?: readonly string[];
  /** Set when the whole line was words in the form `<key> is <value>`. */
  readonly assertive?: boolean;
  readonly span: Span;
  readonly children: readonly ChildNode[];
}

/** What a `- value` line may hold: one list item, or `none` when its value was refused. */
export type ItemValue = ListItem | Extract<Value, { kind: 'none' }>;

/** A `- value` line under a field or a section. */
export interface ItemNode {
  readonly kind: 'item';
  readonly value: ItemValue;
  readonly span: Span;
}

export interface RecordNode {
  readonly kind: 'record';
  readonly discriminator: string;
  readonly name: string;
  readonly head: readonly FieldNode[];
  readonly sections: readonly SectionNode[];
  /**
   * Every record whose nearest enclosing record is this one. Each is also present at its structural
   * position under a section or a field's `children` (a header directly under a header is refused);
   * a record nested inside one of these appears in that record's own `nested`, not here.
   */
  readonly nested: readonly RecordNode[];
  readonly span: Span;
}

export interface SectionNode {
  readonly kind: 'section';
  readonly name: string;
  readonly span: Span;
  readonly children: readonly ChildNode[];
}

export type ChildNode = FieldNode | ItemNode | RecordNode;

interface TriviaBase {
  readonly line: number;
  /** Index into `FileNode.records` of the top-level record this trivia precedes or lies within, or 'file' when none follows. Position inside that record, including before a nested record, is by `line`. */
  readonly attachedTo: number | 'file';
  /** True for a comment that followed content on a single-line value's line. A comment on any line of a multi-line list or prose value is trivia at its own line and is never trailing. */
  readonly trailing: boolean;
}

export type TriviaNode =
  | (TriviaBase & { readonly kind: 'comment'; readonly text: string })
  | (TriviaBase & { readonly kind: 'blank' });

export interface FileNode {
  readonly kind: 'file';
  readonly path: string;
  /** The pragma's version; the empty string only for a refused file with no pragma. */
  readonly version: string;
  readonly records: readonly RecordNode[];
  readonly trivia: readonly TriviaNode[];
  /** Parser-owned errors, including omitted lines. Absent for a clean parse; consumers must not re-emit them. */
  readonly syntaxDiagnostics?: readonly Diagnostic[];
  /** Structural extents of attempted records, including refused headers; present with parse-error ownership metadata. */
  readonly syntaxRecordSpans?: readonly Span[];
}
