import type { FileNode, Span } from '../ast.js';
import type { Diagnostic } from '../diagnostics.js';
import type {
  ArtifactSet,
  Band,
  Cardinality,
  Category,
  FieldType,
  Kind,
  Move,
  PlacementKind,
  Predicate,
  Primitive,
  Provenance,
  TextForm,
} from '../taxonomy.js';

/** Where a source sits in the authority model (graph spec 3.3). `reach` is the path prefix the placement covers; '' is everywhere. */
export interface Placement {
  readonly kind: PlacementKind;
  readonly band: Band;
  readonly reach: string;
}

/** The location a file is read at: its placement and provenance. Both are copied onto every record it compiles. */
export interface Location {
  readonly placement: Placement;
  readonly provenance: Provenance;
}

/** A parsed file with the location it was read at. */
export interface Source {
  readonly ast: FileNode;
  /** Parser diagnostics for this AST; retained once by the registry, never re-reported by extraction. */
  readonly diagnostics: readonly Diagnostic[];
  readonly location: Location;
}

/** One `<predicate> <targets> using <sources>` row of a system's consent ledger (spec 4.2). A side is `*` or discriminator keywords. */
export interface ConsentRow {
  readonly predicate: Predicate;
  readonly targets: readonly string[] | '*';
  readonly sources: readonly string[] | '*';
  readonly span: Span;
}

/** One `<keyword> lowers to <kind>` entry with its block, as authored. */
export interface Entry {
  readonly keyword: string;
  readonly kind: Kind;
  readonly category: Category;
  readonly facets: readonly string[];
  /** The `@schema` name the entry points at; resolved by the registry, not here. */
  readonly schema: string;
  /** Lowering extras (spec 4.2): the artifact set, primitive and move the word's records carry; absent when not declared. */
  readonly artifactSet?: ArtifactSet;
  readonly primitive?: Primitive;
  readonly move?: Move;
  readonly span: Span;
}

/** One `requires` item: a system name and where it was written. */
export interface RequiredSystem {
  readonly name: string;
  readonly span: Span;
}

/** `steward @<discriminator> <name>`: the reference as written, its name lowercased for the identity slot. */
export interface Steward {
  readonly discriminator: string;
  readonly name: string;
}

/** A `@system` record read off the AST. `name` is lowercased for the identity slot; `displayName` is the authored spelling. */
export interface SystemDeclaration {
  readonly name: string;
  readonly displayName: string;
  readonly provider: string;
  readonly version: string;
  readonly describes?: string;
  readonly steward?: Steward;
  readonly requires: readonly RequiredSystem[];
  readonly entries: readonly Entry[];
  readonly consent: readonly ConsentRow[];
  readonly path: string;
  readonly span: Span;
  readonly band: Band;
}

export interface SchemaSection {
  readonly name: string;
  readonly must: boolean;
  readonly span: Span;
}

export interface SchemaField {
  readonly section: string;
  readonly key: string;
  readonly type: FieldType;
  readonly must: boolean;
  readonly description?: string;
  /** `as id in [a, b]`: the closed set every value, or every list item, must belong to (W0-L1). Only an `id` type carries it. */
  readonly values?: readonly string[];
  /** `as ref to <word>`: the discriminator every reference must carry (W0-L2). Only a `ref` type carries it; the target's existence is a compliance concern. */
  readonly target?: string;
  /** `as text form <form>`: the closed text form every value must match (W0-L5). Only a `text` type carries it. */
  readonly form?: TextForm;
  readonly span: Span;
}

export interface SchemaEdge {
  readonly predicate: Predicate;
  /**
   * The rule's direction relative to the record: `out` counts the record's active edges with the predicate (the active
   * and present spellings), `in` the edges whose active target is the record (the inverse spelling).
   */
  readonly direction: 'out' | 'in';
  /** The verb as authored: the active predicate, its inverse or the present phrase. */
  readonly spelling: string;
  /** A closed kind or a discriminator; which one is decided when the edge is checked, not here. */
  readonly target: string;
  readonly must: boolean;
  readonly cardinality: Cardinality;
  readonly span: Span;
}

/** A `@schema` record read off the AST (spec 4.3). */
export interface SchemaDeclaration {
  readonly name: string;
  readonly displayName: string;
  readonly kind: Kind;
  readonly sections: readonly SchemaSection[];
  /** True under `closed`: an instance section the schema does not list is a compliance diagnostic. */
  readonly closed: boolean;
  readonly fields: readonly SchemaField[];
  readonly edges: readonly SchemaEdge[];
  readonly path: string;
  readonly span: Span;
  readonly band: Band;
}

/** A joined discriminator: the winner for its keyword after band merge and schema resolution. */
export interface Registration {
  readonly keyword: string;
  readonly system: string;
  readonly kind: Kind;
  readonly category: Category;
  readonly facets: readonly string[];
  readonly schema: string;
  /** The entry's lowering extras, carried unchanged into the catalogue. */
  readonly artifactSet?: ArtifactSet;
  readonly primitive?: Primitive;
  readonly move?: Move;
  readonly band: Band;
}

/** The resolved vocabulary at a location. Read-only by type; `buildRegistry` freezes the object shallowly, and nothing in this package mutates a map it did not build. */
export interface FrozenRegistry {
  /** The systems in force, by lowercased name; a system a cycle or a missing requirement refused is absent. */
  readonly systems: ReadonlyMap<string, SystemDeclaration>;
  /** Bootstrap order: the built-in systems first, then `requires` topologically, ties by name. */
  readonly order: readonly string[];
  /** Joined discriminators by keyword, the floor's two words included. */
  readonly registrations: ReadonlyMap<string, Registration>;
  /** Keywords two systems registered at the winning band; unusable at this location. */
  readonly blocked: ReadonlySet<string>;
  /** Schemas in force, by lowercased name. */
  readonly schemas: ReadonlyMap<string, SchemaDeclaration>;
  /** Consent ledgers by system name. */
  readonly consent: ReadonlyMap<string, readonly ConsentRow[]>;
}
