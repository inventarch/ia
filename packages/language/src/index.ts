// The public surface is `parse`, `scan`, `buildRegistry` and `compile` with their types, the kernel
// embed, identity and paths. The pipeline stages behind them (logical lines, line tokenizer, key rule,
// field readers, spellings) are internal: spec 9.1 gives consumers the stream, spec 10 the records.
export { LANGUAGE_VERSION, parse, SUPPORTED_VERSIONS } from './parser/index.js';
export type { ParseResult } from './parser/index.js';
export { scan } from './scanner/index.js';
export type { ScanResult, StreamToken, Token, Trivia } from './scanner/index.js';
export { diag, isError, LANG_CODES } from './diagnostics.js';
export type { Diagnostic, LangCode, Severity } from './diagnostics.js';
export { foldProse } from './fold.js';
export type {
  ChildNode,
  FieldNode,
  FileNode,
  ItemNode,
  ItemValue,
  ListItem,
  RecordNode,
  SectionNode,
  Span,
  TriviaNode,
  Value,
} from './ast.js';
export {
  AXES,
  BAND_OF,
  BANDS,
  CARDINALITIES,
  CATEGORIES,
  INVERSE_OF,
  KINDS,
  MOVES,
  PHASES,
  PLACEMENT_KINDS,
  PREDICATE_PAIRS,
  PREDICATES,
  PRIMITIVES,
  PROVENANCES,
  SEVERITIES,
  TEXT_FORMS,
  VALUE_TYPES,
  fieldTypeOf,
  isAxis,
  isBand,
  isCardinality,
  isCategory,
  isKind,
  isMove,
  isPhase,
  isPlacementKind,
  isId,
  isPredicate,
  isPrimitive,
  isProvenance,
  isSeverity,
  isTextForm,
  isValueType,
} from './taxonomy.js';
export type {
  Axis,
  Band,
  Cardinality,
  Category,
  FieldType,
  Kind,
  Move,
  Phase,
  PlacementKind,
  Predicate,
  Primitive,
  Provenance,
  TextForm,
  ValueType,
} from './taxonomy.js';
export type { Severity as KernelSeverity } from './taxonomy.js';
export { canonicalPath } from './paths.js';
export { collisions, identityOf, renderIdentity } from './identity.js';
export type { Identity, IdentityOccurrence } from './identity.js';
export {
  admits,
  buildRegistry,
  consentFor,
  fieldTypeText,
  sortDiagnostics,
  BUILTIN_SYSTEMS,
  FLOOR_REGISTRATIONS,
  FLOOR_SYSTEM,
  RESERVED_KEYWORDS,
  TAXONOMY_SYSTEM,
} from './registry/index.js';
export type {
  ConsentRow,
  Entry,
  FrozenRegistry,
  Location,
  Placement,
  Registration,
  RegistryResult,
  RequiredSystem,
  SchemaDeclaration,
  SchemaEdge,
  SchemaField,
  SchemaSection,
  Source,
  Steward,
  SystemDeclaration,
} from './registry/index.js';
export { compile } from './compile/index.js';
export type {
  CompileResult,
  CompiledChild,
  CompiledEdge,
  CompiledField,
  CompiledItem,
  CompiledRecord,
  CompiledSection,
  CompiledValue,
  SourceMapEntry,
} from './compile/index.js';
export type {
  Cell,
  ConditionAxis,
  EdgeReference,
  Requirement,
  RequirementKind,
  Selector,
  SelectorTerm,
  Term,
  Variant,
} from './semantic/types.js';
export { ARTIFACT_SETS, LANES, SHAPES } from './taxonomy.js';
export type { ArtifactSet, Lane, Shape } from './taxonomy.js';
export { indexedResolver, resolveTarget, validatePool } from './semantic/resolve.js';
export type { Resolution, ResolutionCandidate } from './semantic/resolve.js';
export { requirementCollisions, isRequirementId } from './semantic/requirements.js';
export type { RequirementOccurrence } from './semantic/requirements.js';
export { REQUIREMENT_KINDS } from './semantic/types.js';
export { canonicalValue, valuesFor, verbOf, CONDITION_AXES, VERB_PHRASES } from './semantic/vocabulary.js';
export type { Verb } from './semantic/vocabulary.js';

export { KERNEL_DIGEST, SHAPE_ROWS, KIND_LANES, PRIMITIVE_ANCHORS, DIMENSION_PATHS } from './taxonomy.js';
export { format, checkFormatPreservation } from './formatter.js';
export type { FormatResult } from './formatter.js';
export { KERNEL_SOURCES } from './kernel.generated.js';
export { references } from './references.js';
export type { TypedReference } from './references.js';
