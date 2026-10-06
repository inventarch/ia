# Language package specification

**Owner:** `@inventarch/language`. **Current status:** Plans 1–4 are implemented: syntax, registration, structured and semantic compilation, native kernel generation and loss-checked formatting. Sections 1–9 retain the Plans 1–2 baseline at `69c75b7`; their statements of missing behavior are historical. Sections 10–12 supersede those limits and define the delivered semantic/format/kernel contracts. Downstream graph, compliance, database, runtime and local executable consumers have also shipped; current readiness and the audit map their evidence. Editor and development harness implementations have their own contracts and qualification; their existence does not change language ownership.

The shared language design defines the language and its numbered implementation refinements. The systems design defines package dependencies and consumer responsibilities. This file distinguishes delivered package behavior from those future obligations; it does not turn an implementation gap into permission to ignore a language rule.

## 1. Responsibility and dependencies

L01. The package owns the shared scanner, parser, vocabulary/schema declarations, identity and compilation. Public entrypoints are exported by [src/index.ts](src/index.ts). It has no runtime dependency on another workspace package, no filesystem access, clock, randomness, model client or implicit corpus. Callers supply text, paths, registries, locations and candidate records.

L02. The floor has exactly two reserved record discriminators: `system` and `schema`. Other words require a successful registration. The embedded taxonomy supplies seven kinds, fifteen categories, four phases, six primitives, five moves, eighteen active predicates with inverses, severity/provenance, placements, value types and cardinalities. Nine routing-axis names exist; lane/shape/artifact-set values and present-tense verb phrases are a Plan 3 addition.

L03. This package emits diagnostics, not compliance verdicts. Registry validation of a schema declaration is implemented; applying that schema to each ordinary instance is a compliance consumer obligation.

## 2. Public inputs and outputs

| Entry | Contract | Implementation/evidence |
| --- | --- | --- |
| `scan(text, path)` | One stream with source positions, trivia and scanner diagnostics | [scanner](src/scanner/index.ts), [scanner tests](tests/scanner/scan.test.ts) |
| `parse(text, path)` | `{ ast, diagnostics }`; AST includes records, typed fields/items, nesting and trivia | [parser](src/parser/index.ts), [record tests](tests/parser/records.test.ts) |
| `buildRegistry(sources)` | Each source supplies AST, parser diagnostics and location; returns resolved registry and stage diagnostics | [registry](src/registry/index.ts), [join tests](tests/registry/index.test.ts) |
| `compile(ast, registry, location, pool)` | Returns lowered records, compile diagnostics and source maps; baseline ignores pool | [compiler](src/compile/compile.ts), [compile tests](tests/compile/compile.test.ts) |
| Identity/path/taxonomy helpers | Explicit pure helpers and types; no location discovery | [identity tests](tests/identity.test.ts), [paths tests](tests/paths.test.ts), [taxonomy tests](tests/taxonomy.test.ts) |

L04. A location supplies placement kind, authority band, reach and provenance. Bands are the closed set 100, 90, 50, 10 and 0. The package does not discover a filesystem location or decide graph reach/authority winners between compiled records.

L05. The package exposes ESM runtime output and emitted TypeScript declarations. The `development` condition selects source; the ordinary package entry selects `dist/index.js`. [Smoke tests](tests/smoke.test.ts) pin public exports. Typechecking includes source and test projects.

## 3. Surface and AST

L06. A source starts with `#! ia 1.0`. The scanner normalizes supported line endings, measures two-space indentation, refuses tabs/odd indentation and maintains a single lexical interpretation of quotes, prose, lists, sigils and comments. The parser enforces structural indentation and consumes refused blocks without diagnosing their contents again.

L07. A record header names a lowercase discriminator and an ASCII letter-led name. Head fields precede sections. A nested header inside a section/field block defines a separate record; a header immediately beneath a header is invalid. Section names are syntactic, not an enumerated vocabulary in the parser.

L08. Values are scalar, string, prose, ref, list, block or none. A scalar joins its parsed words with single spaces. Strings preserve content with the admitted quote/backslash escapes; prose folds continuation whitespace and paragraph breaks. Lists contain scalar/string/ref items, permit one trailing comma and forbid nested lists or prose items. A dash item has one such item value, no key or block.

L09. The key rule is structural. Words preceding a quoted/list/ref value form its key; an all-words field uses the first word as key and the rest as scalar, with the `key is value` form recorded as assertive. `FieldNode.words` preserves the word run for later multi-word spelling resolution. Structural words inside quoted content never change record identity.

L10. References retain discriminator, name and optional fragment. Baseline parsing admits a single alphanumeric/hyphen fragment segment. Cell addresses containing `phase/Primitive` are specified centrally but not admitted yet; Plan 3 must repair that gap without making the parser validate fragment existence.

L11. Inline `when` is retained as a word array, including quote markers where needed. The parser judges its lexical form only. Empty/list/prose inline conditions are parser errors. A standalone child `when` is an ordinary field in `children`; it is not stored in the parent's inline `when` slot.

L12. Parser-refused values can retain a field/item with a partial value or none for tools. Dropped lines/blocks do not create AST nodes. At this baseline the AST has no complete syntax-refusal provenance channel for downstream semantics. Plan 3 must add that channel before interpreting partial condition carriers.

L13. Every AST span is an inclusive 1-based line range. Tokens include 1-based UTF-16 columns. Comments and blank lines are trivia with source positions and attachment to a top-level record index or file. A trailing comment on an accepted single-line value is distinguished from comments on multi-line values. Filtering records does not preserve those positional trivia indexes automatically.

Evidence: [values](tests/parser/values.test.ts), [fields](tests/parser/fields.test.ts), [trivia](tests/parser/trivia.test.ts), [tokenization](tests/scanner/tokenize.test.ts), [logical lines](tests/scanner/lines.test.ts), [folding](tests/fold.test.ts) and the parser clause fixtures under [language fixtures](../compliance/fixtures/language).

## 4. System extraction and consent declarations

L14. System discovery walks declarations including nested records without needing a vocabulary. Required provider/version are quoted, once-only fields. Semver core and numeric prerelease identifiers cannot have leading zeros; build identifiers may. Optional steward values must be fragment-free references. Optional describes/steward use the first occurrence, with every supplied steward checked for validity.

L15. Requires is a section of bare name items. Names, including system/schema/steward names used for lookup, are lowercased. A malformed item drops itself. Missing/refused dependencies subsequently refuse their dependent systems transitively. Floor and taxonomy are always satisfied built-ins.

L16. A discriminator entry declares keyword, closed kind/category, nonempty facets and a schema reference. It may add `artifact-set`, `primitive` and `move` rows, each a bare closed kernel value, which the registration carries as its lowering extras; a present row outside the kernel refuses the entry, an absent row leaves the registration without it. Keywords match the lowercase spelling rule, cannot be reserved and occur once per system. Head faults refuse the system; entry/item/consent-row faults refuse that element. Registry checks do not repeat a parser-owned fault. Conditions on the system's forbidden positions are extraction-owned.

L17. Consent rows have an active predicate, a target side, exactly one `using`, and a source side. Each side is a comma-separated keyword list or a wildcard; malformed/dangling members are refused. A row's two sides must both match; combining separate rows cannot manufacture consent. An absent ledger admits nothing.

L18. `consentFor` checks the logical source system first and the target system second, returning one refusing side. An unregistered endpoint also produces undefined because registration owns that refusal; undefined alone is not proof of consent unless both endpoints are registered. Ordinary compiled edge checking is not implemented at this baseline.

Evidence: [system extraction](tests/registry/extract.test.ts), [field readers](tests/registry/fields.test.ts), [consent](tests/registry/consent.test.ts).

## 5. Schema dialect and registry join

L19. A schema declares one closed lowered kind; section obligations terminate with exactly one open/closed marker; field obligations declare a section/key path, admitted type and optional description; edge obligations declare predicate, kind-or-discriminator target and cardinality. Relationship fields are forbidden because edge obligations have their own dialect.

L19a. A field type MAY carry one narrowing after it (W0, 2026-09-25): `id in [a, b]` and `list of id in [...]` declare a closed set of distinct bare ids (the row's value is the set, so it carries no description); `ref to <word>` and `list of ref to <word>` name the discriminator every reference must carry, without resolving it; `text form <form>` and `list of text form <form>` name a member of the closed text-form table `TEXT_FORMS`, whose only member is `iso-date`. A narrowing on another type, a second narrowing, an unknown form, an empty or duplicated set, and a non-id set member are `IA-LANG-SCHEMA-MALFORMED`; words after a set are parser-owned trailing values. The narrowing is stored beside the type as `values`, `target` or `form` on the field, and `fieldTypeText` spells it back. Checking a value against a narrowing is a compliance obligation (`IA-COMP-FIELD-VALUE`, `-FIELD-REF-TARGET`, `-FIELD-REF-MISSING`, `-FIELD-FORM`). Adding a text form changes the table and the compliance predicate, never the kernel.

L20. A broken schema is refused whole. Duplicate declared sections, field paths or predicate/target pairs; malformed dialect rows; conditions; legacy prose dialect; wrong kinds/predicates; and unsupported row children are diagnosed by their own rules. Nested declarations own their faults separately.

L21. Registry construction retains input parser diagnostics once, extracts declarations, selects winning-band systems/schemas, orders surviving requirements, resolves keyword conflicts and joins registrations to schemas of the same lowered kind. Every cycle member receives one cycle diagnostic. Remaining ready systems are chosen alphabetically; input ordering does not select a winner.

L22. Same winning-band system/schema collisions have no winner. Same-band keyword conflicts block that keyword, while a higher band shadows lower entries. A missing schema emits a missing-schema diagnostic; a schema already refused does not create a second missing error. The floor's fixed schemas need not resolve during bootstrap.

L23. A successful registry contains system/order/registration/blocked/schema/consent collections. The outer object is frozen and interfaces are readonly; native Map internals are not deeply runtime-frozen. Callers must not mutate them. No runtime import reads an installed default vocabulary.

Evidence: [schema tests](tests/registry/schemas.test.ts), [merge tests](tests/registry/merge.test.ts), [order tests](tests/registry/order.test.ts), [registry tests](tests/registry/index.test.ts).

## 6. Identity and structured compilation

L24. Identity is `system/kind/facet/name`, using the registration's owner/kind and first facet unless a declared facet is authored. Name is lowercased and displayName retains its authored case. An undeclared facet refuses the record. Canonical paths normalize separators/dot segments lexically and preserve caller-supplied case.

L25. Compilation first checks registration and identity. An unregistered/blocked discriminator refuses the record and its descendants. A nested declaration has its own identity and a parent identity; it is not a body field or an implicit relationship.

L26. Fields preserve typed values without raw spellings. For an ordinary scalar, the longest schema/floor-spelled word prefix determines a multi-word key. Assertive and non-scalar fields keep the parser key. Section items stay beside fields, in source order. The fixed floor spelling table applies to reserved system/schema registrations, not every word owned by floor.

L27. The compiled facet head field is consumed into identity but keeps its field source-map entry. Records contain structured head/sections; there is no flat body or record comment field. Source, schema identity, provenance and placement are attached explicitly.

L28. The winning system declaration produces one outgoing ground edge for each distinct schema named by an accepted winning entry. Shadowed/refused entries do not produce these edges. At this baseline explicit relationship lines remain fields and are not semantically lowered.

L29. Same-identity, same-band occurrences within the file are all refused, including groups larger than two. Their descendants are removed by actual enclosing occurrence rather than parent-name matching. The public collision helper accepts arbitrary supplied occurrences for caller-level checks; cross-file discovery and cross-band authority selection are external responsibilities.

L30. Returned records and source maps are in source order. A source map includes the header line, section spans, all compiled field spans including consumed facet, and spans parallel to generated edges. Baseline semantic arrays cells/selectors/variants/requirements are empty; no map arrays for those products are claimed yet.

Evidence: [compiled values and key rule](tests/compile/values.test.ts), [compiler behavior](tests/compile/compile.test.ts), [identity](tests/identity.test.ts), [paths](tests/paths.test.ts), compile/identity/registry/schema conformance fixtures.

## 7. Diagnostics and refusal

L31. A diagnostic contains code, error/warning severity, path, line, message and optional endLine/identity. Kernel severity is a separate domain. Diagnostics are deterministic, ordered by path and source line when returned from registry/compile.

L32. A primary fault is diagnosed by its owning stage. Later extraction suppresses dependent errors for parser-refused elements, and refused schemas do not also become missing schemas. Distinct faults can each be reported; collisions report once on every participant. A file with any error is not loadable, even if compile returns surviving preview records.

L33. The caller combines registry diagnostics and compile diagnostics once; registry already contains parser diagnostics for its supplied sources. The baseline fixture harness only invokes registry/compile after a clean parse. Future semantic integration needs additional direct tests for partial ASTs rather than assuming this harness proves recovery safety.

Evidence: [diagnostics](tests/diagnostics.test.ts), [fixture harness](tests/fixtures.test.ts), stage-specific tests. Exported LANG_CODES includes reserved future semantic codes; inclusion in that constant does not establish an implemented diagnostic branch.

## 8. Historical Plans 1–2 consumer mapping

| Product | Current consumer | Delivered evidence | Pending consumer |
| --- | --- | --- | --- |
| Tokens/AST | Parser, registry and compiler | Syntax and source-position tests; malformed inputs | Formatter/editor |
| Registry | Identity and structured compiler | Native system/schema fixtures; missing/conflicting entries | Full system admission, instance validation and all host load paths |
| Compiled records/maps | Public package users and conformance runner | Minimal floor, nesting, identity/refusal and map fixtures | Graph/db/runtime |
| Consent ledger | Pure consent helper | Row matching and refusing-side tests | Ordinary edge lowering and graph load |
| Procedure/cell/selector text | Structured field storage | Preserved parsed/compiled fields | Semantic readers, graph indexing and runtime delivery |

Not implemented at this baseline: lane/shape/artifact-set value sets, full verb table, semantic cells/selectors/conditions/variants/requirements, case validation, ordinary target resolution/consent, cell-fragment parsing, whole-tree requirement uniqueness, formatting, kernel-source generation/migration, instance compliance, graph/db/runtime or executable system bindings. Planned work must not be described as established merely because the record parses.

## 9. Verification and change protocol

Run from this package: `pnpm test`, `pnpm typecheck`, `pnpm build`. Baseline review on 2026-09-17 reran 512 tests in 23 files, source/test typechecking and the build successfully.

Behavior changes must update this colocated spec, the owning shared clause when relevant, the linked implementation task and meaningful tests. Plans 1–2 retain their historical canonical code blocks; later task changes supersede those bytes. The continuation plan records stage scope and evidence. Plan 3 adds semantic behavior in numbered clauses without erasing this baseline's historical limits.

## 10. Plan 3 semantic contract

**Status:** semantic implementation delivered under the operator's continuation mandate; the baseline clauses above remain historical. Task evidence below records the additions and their verification.

S01. Language owns pure target resolution; graph delegates to it and owns candidate admission by location/reach/authority. Compilation preserves its four arguments. The pool contains externally compiled, admitted occurrences and excludes this source path; a same-path occurrence or a candidate with no matching registration/identity is a caller error (`TypeError`), not a source diagnostic. Local identities surviving syntax/identity refusal are discovered before relationships resolve. Sigil names are lowercased for matching; discriminator spelling is literal. Qualified targets use the exact canonical four-slot identity spelling.

S02. Reference fragments are nonempty alphanumeric/hyphen segments separated by slashes. Fragment case is preserved. A qualified relationship target may also carry a fragment. Parsing validates this shape, while compliance validates actual cell/requirement existence.

S03. A parsed AST with syntax errors carries optional serializable `syntaxDiagnostics`; clean ASTs omit it. Error-bearing ASTs also carry syntaxRecordSpans, the structural extents of attempted records, including refused headers, so a failed sibling header or stray top-level line cannot taint a preceding valid record. These diagnostics remain parser-owned and are not re-emitted by compile. Compile refuses the owning record and descendants for any syntax error, using structural record boundaries including omitted trailing lines; unaffected records survive. This conservative rule prevents a removed child condition or partial reference from becoming an unconditional product. Parser preview fields remain available on the AST.

S04. Terms use one closed value table. Selectors admit nine routing axes; conditions additionally admit severity and provenance (artifact-set shares its one routing/dimension domain). Axis/grammar spelling is literal and values match case-insensitively into canonical spelling. A conjunction requires one or more complete terms and cannot repeat a left-hand name. Stored term order follows the common axis/dimension order so condition identity does not depend on authored conjunction order.

S05. Cells, relationships, governance obligations and contract requirements accept one inline condition or one direct child when; mixed/repeated carriers are refused. No condition is permitted on a primary declaration, severity metadata, ordinary field or other forbidden position. A malformed condition refuses its complete carrier, with no unconditional fallback. Parser and registry ownership take priority; a refused system/schema dialect position is not diagnosed again by semantic readers.

S06. Cells preserve case-sensitive primitives and string/prose text. Repeated cognition sections are read together. Duplicate phase blocks refuse every participant once and produce no cells for that phase. An invalid primary declaration refuses its phase; duplicate means primitives refuse all duplicate occurrences. Invalid means lines refuse only themselves. If a line naming the primary primitive is itself refused (including malformed means syntax), suppress a derived missing-means error; other valid cells may survive without a primary. Nested declarations remain independent records.

S07. Edges retain `reference` as a typed sigil or qualified identity, active predicate, direction relative to the containing record, target identity or null, optional fragment/condition and span. Zero targets keeps a warning edge; multiple occurrences refuse it. Consent uses logical active-direction endpoints, checking both ledgers row-wise and reporting only the first refusing side. Generated ground assertions are structural: an equivalent unconditioned authored assertion is consumed without duplication or extra consent, and the generated entry span represents the edge; the authored field span remains. Other ground edges follow ordinary consent. Graph must check consent when a dangling edge later resolves.

S07a. The built-in floor ledger grants only incoming `cite` to an exact whole `schema` target. The logical source owner's independent consent still applies first. A fragment on the schema endpoint refuses; an inverse assertion's fragment on its other endpoint is not a schema fragment. This immutable built-in row participates in registry pins, cannot be replaced by an authored floor-named declaration and creates no synthetic system. It grants no citation to `system`, other predicate, resource read, write or evaluator authority. Conditional ordinary citations retain their semantics; a primary authoring-guide consumer separately requires an unconditional matching schema citation. S07's structural ground exemption is unchanged.

S08. Governance keys are open and schema-spelled; severity is metadata, not a variant. Identical canonical conditions (including two absent conditions) refuse every participant in that key's duplicate group. Nonidentical overlapping conditions are a compliance concern.

S09. Registered contract/case words have their specified semantic roles; lowered kind alone does not select those readers. Contracts lower eight clause sections with case-sensitive REQ IDs and string/prose text. Requirement uniqueness uses a pure whole-tree occurrence helper reporting/refusing every duplicate, without a band exception; local compile checks local occurrences and the future loader applies the helper across the tree. A retained outbound govern edge satisfies structural binding, including a dangling edge. A retained outbound implement edge to a registered contract reference/qualified contract identity with a syntactically valid REQ fragment satisfies case binding. An already-refused intended binding or legacy binds field suppresses a derived unbound error.

S10. Cases contain exactly one scenario block, one kind from success/failure/refusal/resumption/escalation, and exactly one string/prose value for each of given/request/expected/evaluator. A malformed scenario is refused as a unit. Authored verdict at head or scenario depth, including a record-level verdict block, is refused; the word in quoted prose is ordinary content. Compliance owns fragment existence and scenario execution. Case validation consumes a malformed scenario as one refusal unit (duplicate participants each receive a diagnostic). Raw structured fields remain preview data under S12; a case validation result never overrides earlier parser/edge errors. Other schema-governed fields are not forbidden merely because the five required fields are fixed.

S11. New refusal codes: CONDITION-MALFORMED (syntax, repeated names/carriers), CONDITION-VALUE-UNKNOWN, EDGE-MALFORMED, REQUIREMENT-MALFORMED, CONTRACT-BINDS-RETIRED and CASE-MALFORMED, each prefixed IA-LANG-. Existing unknown-name, selector, cell, verb, target, consent, variant, duplicate and binding codes retain their roles. A primary fault consumes its refusal unit without derived diagnostics. Duplicate groups emit once per involved occurrence.

S12. Compiled cells/selectors/variants/requirements become typed products. Source maps have parallel span arrays for every emitted semantic product. Raw structured fields remain for tools except fields already consumed by the baseline contract. Product readers use the AST and shared field spelling helpers, never lexical regexes over source text.

Integration ownership: a schema with registry-owned conditions produces no semantic products, preventing those forbidden conditions from being judged again or becoming unconditional behavior. Its raw structured preview and independently nested declarations remain available; registry diagnostics still prevent publication. Local identity/parent refusal precedes semantic products and target matching. Local requirement duplicates are removed from every participating record and its parallel map; the external pool is never mutated.

### Plan 3 delivery evidence

Task 0: scope reconciled against Plans 1–2, central dependency rules and the operator's delegated implementation mandate. S01–S12 specify the engineering decisions before source changes. Tasks 1–10 remain to implement and verify them.

Task 1 delivered: slash reference fragments in fields/lists/items; serializable syntax diagnostics; parser-tainted record/descendant refusal without duplicate reporting, including serialized nested ASTs; typed semantic products, retained generated-edge references and semantic source-map slots. Regression fixture expectations now include each ground edge's schema reference. Verified 529 tests in 25 files, typecheck and build. Semantic readers and pool resolution remain pending.

Task 2 delivered: exact lane/shape/artifact-set values, shared canonical value lookup and all 54 active/inverse/present verb spellings with direction. New table tests cover every spelling, unknown/partial/case variants, literal/prototype-safe axis lookup and the retained five moves. Verified 575 tests in 26 files, typecheck and build. No runtime donor dependency was added.

Task 3 delivered: canonical terms and inline/direct-child conditions, independent selector groups, forbidden ordinary condition placement and explicit registry/nested-record ownership. Verified 646 tests in 29 files, typecheck and build. Reader integration and specialized carrier validation remain with their later tasks.

Task 4 delivered: cognition cells with phase/primitive validation, primary and duplicate refusal boundaries, folded text, conditions and spans. Reviewed derived-error suppression with a failing regression before repair. Verified 683 tests/30 files, typecheck and build; compiler orchestration remains Task 9.

Task 5 delivered: pure deterministic resolver and admitted-pool validation, preserving ambiguity and fragments without authority selection or fragment-existence checks. Verified 706 tests/31 files, typecheck and build. Compiler and graph consumers remain assigned to their integration tasks.

Task 6 delivered: typed relationship targets and conditions, warning retention, cardinality refusal, active-direction two-sided consent, generated-ground equivalence, and refused-binding intent for dependent validation. All 778 tests/32 files, typecheck/build pass. No graph resolution or execution is claimed.

Task 7 delivered: governance variant families using schema-spelled keys and compiled values, normalized duplicate refusal, severity exclusion and no fallback from malformed conditions. Verified 793 tests/33 files, typecheck/build; coordinate overlap evaluation remains compliance-owned.

Task 8 delivered: eight requirement clause kinds, whole-tree duplicate helper without a band exception, contract binding/retirement checks and case scenario/binding validation. Registry/dialect owners suppress derived and duplicate errors. Verified 882 tests/36 files, typecheck/build. Integration/local aggregation is Task 9; tree loading and compliance execution remain later components.

Task 9 delivered: the public compiler now produces every semantic array and parallel source map, resolves local/external references independently of source order, validates the external pool, filters local duplicate requirements and preserves diagnostic ownership. A complete case-contract-playbook chain compiles without errors. Verified 899 tests/37 files, typecheck/build. Task 10 still owns conformance/public-surface closure and downstream handoff.

Conformance inputs: seven semantic fixture clauses run registry and compile. An optional `.pool.json` companion contains external `{ path, source, location }` sources, compiled under the same registry before the main file. Its purpose is realistic cross-file target ambiguity; language source syntax is unchanged. Diagnostic code/line fixtures are complemented by direct severity, refusal-unit, source-map and multiplicity tests. Public resolver, requirement occurrence and closed-vocabulary helpers supply the next graph/compliance consumers; private carrier readers remain internal.

## 11. Semantic conformance and consumer audit

| Contract | Direct evidence | Portable fixture clause |
| --- | --- | --- |
| S01 target cardinality, pool consistency and order | semantic/resolve and compile/semantic-integration tests; emitted declaration/runtime consumers | edges, including an explicit external pool |
| S02 fragments, S03 syntax ownership and sibling recovery | parser/fragments and compile/syntax-ownership, including serialized attempted-record extents | refs; existing parser refusal fixtures |
| S04 closed vocabulary, five moves and canonical terms | semantic/vocabulary, conditions and selectors tests | selectors, conditions, edges |
| S05 allowed carriers and stage ownership | semantic/placement, all carrier readers and compile integration | conditions; registry/schema refusal fixtures |
| S06 cells, optional primary and refusal units | semantic/cells and source-map integration | cells, including all 24 phase/primitive addresses |
| S07 retained targets, direction, consent and ground equivalence | semantic/edges and ground/source-map integration | edges, including all 54 spellings |
| S08 open keys, severity metadata and normalized duplicates | semantic/variants and compiler integration | variants |
| S09 clauses, tree duplicates and structural bindings | semantic/contracts, requirements, cases and a complete compiled chain | contracts, cases |
| S10 scenario fields/kinds, verdict refusal and deferred execution | semantic/cases and compiler integration | cases |
| S11 diagnostic codes, admitted-value messages and multiplicity | diagnostics inventory and explicit carrier/integration assertions | Every emitted code has a fail fixture; FORMAT-LOSSY remains reserved for Plan 4 |
| S12 structured previews and parallel surviving-product maps | compile integration and public type tests | All seven semantic pass clauses |

At the Plan 3 checkpoint, the package README mapped each product to an authored example and its then-future consumer. Those consumers have since shipped with their own tests; language tests alone do not establish their behavior. A registered 24-cell authoring playbook is compiled and resolved through the built package as a runtime API check, without claiming procedure execution.

Task 10 delivered: 89 semantic fixtures and a checked optional external-source pool format; public resolver/tree/vocabulary APIs; diagnostic/source ownership audit repairs; consumer mapping and published SPEC.md. Final verification: 995 tests/38 files, workspace typecheck/build, emitted-declaration consumer and built-runtime consumer. Every emitted code has a fixture; FORMAT-LOSSY is reserved until Plan 4. Semantic compilation is complete, with kernel generation/migration, formatting and downstream consumers still assigned to later stages.

Plan 4 scope-review correction to Plan 3 section 8.4 acceptance: interface, protocol and shape are retired registration keywords and receive KEYWORD-RESERVED. They do not become floor registrations. Three extraction regressions and three fail fixtures cover the correction. Verified 1001 tests/38 files, typecheck and build before migration.

## 12. Plan 4 contract (delivery evidence below)

P01. The native kernel under .ia/src/floor is the source of the generated closed-set data and digest. Build tooling uses the real parser, registry, compiler and compliance schema checker, validates every record plus closed memberships/routing references, and emits no bytes on refusal. The language runtime remains pure with no package dependency. Checked-in generated data bootstraps the validator; reproducibility/drift checks compare a fresh validated rendering against it. Colocated build-tool specification owns filesystem behavior.

P02. format(source,path) consumes scanner tokens and returns {text: string|null, diagnostics}. Syntax errors yield null with their original diagnostics. Ordinary line token spacing is canonical; multiline token raw bytes (after LF normalization), list continuation contents, comment and blank-line positions are preserved. The implementation never lexes IA text independently. A reusable checkFormatPreservation(source,output,path) compares ordered comment line/text inventory and non-layout token meaning and returns FORMAT-LOSSY on any mismatch. format calls this gate before exposing text. Invalid syntax is not partially reformatted.

P03. Formatter coverage includes every existing conformance source, strings/prose containing syntax-like words, lists with inline comments, nested records, exact trivia multiplicity, CRLF, no terminal newline and a deliberately lossy candidate. Valid inputs must be idempotent and preserve parsed content; invalid fixtures must be refused unchanged. This is formatting evidence, not semantic acceptance of invalid records.

Formatter refinement before implementation: the preservation gate also compares logical-line depth/boundaries, so indentation cannot change record ownership while preserving lexical token values. Comment inventories include exact physical line and text; blank-line positions remain unchanged. The format conformance clause alone admits .formatted.txt (expected success output) and .candidate.txt (a deliberately changed candidate supplied to the public write guard); these files are not IA input extensions.

Plan 4 Task 2 delivered: 118 native floor records validate through language and compliance before deterministic embed generation. Closed constants and all 54 verb spellings now consume generated data; shape defaults, kind lanes, primitive anchors, dimension paths and digest are public. Root build checks output drift. Evidence: 1001 language tests, 62 compliance tests and 21 build-tool mutation/reproducibility tests, workspace and tool typecheck/build. Migration ran through the shared parser from seven hashed donor inputs; normal build has no donor dependency. Formatter and native five-system corpus remain pending.

Plan 4 Task 4 delivered: pure scanner-driven format and preservation APIs, raw multiline/trivia retention, structural-depth guard and format conformance companions. Every conformance/native IA source is exercised for refusal or successful idempotence with unchanged parsed meaning. Verified 1241 language tests/39 files, 62 compliance tests and 40 tool tests, typecheck and build. Every emitted language code now has a fail fixture.

P04 (database bootstrap integration). Expose KERNEL_SOURCES, generated from the same validated native floor as KERNEL_DIGEST. Each path/text source and its array are frozen. This is an explicit data export for consumers needing floor records; parse/buildRegistry/compile still require explicit inputs and perform no filesystem access or implicit vocabulary loading. tools/kernel/SPEC.md K07 and the database plan Task1 own generation and consumption.

## 13. Editor projections

E01. Public `references(ast)` enumerates typed values, including head/list uses and qualified relationship targets, with enclosing record and authored span. It never interprets ordinary prose as references or turns typed uses into graph edges. The shared relationship target reader supplies qualified forms.

E02. Public `/editor` projects the existing scanner and AST to zero-based UTF-16 positions, retaining BOM, CRLF and continuation indentation. Reference ranges distinguish multiple uses on one physical line. Cursor recovery is presentation-only and never changes parse/admission results. Unsupported versions yield no semantic suggestions. Comments, strings and prose suppress structural completion.

E03. Editor formatting uses `format` and its preservation guard. Schema-guided new drafts serialize only supported typed values; unmodeled structures remain source-editable. No second lexer or parser is introduced in a host.
