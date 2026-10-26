# Authoring the IA language

[![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../../../LICENSE) [![Vocabulary](https://img.shields.io/badge/vocabulary-44%20words-blue)](vocabulary.md)

> This guide explains how to write `.ia` records: syntax and identity, fields and allowed values, relationships, defining vocabulary of your own, and reading what `ia validate` reports. The [vocabulary catalogue](vocabulary.md) lists every public word with its owner, schema, fields and relationship cardinality rules; [vocabulary.json](vocabulary.json) carries the same data for tools, and `ia preview <word>` lists the consent rows that permit its relationships.

Ask the CLI about a word before you write one:

```sh
ia vocabulary decision --schema
ia preview decision
```

The first prints the word's sections, fields, allowed values and relationships, and works anywhere. The second runs inside an initialized workspace and adds the file a new record goes to and the consent rows that let it relate to other records. Write records by hand and run `ia validate`, or preview one with `ia preview` and write it with `ia author --digest`, as the [walkthrough](../../guide/walkthrough.md#5-make-the-decision) shows. The [guide](../../guide/README.md) explains each part of the language in plainer terms; this reference is the exact grammar. If the file changed since the preview, `ia author` refuses with `IA-CLI-EDIT-STALE`; preview again.

## Syntax and identity

```ia
#! ia 1.0

# A line that starts with a hash is a comment.
@decision storage-engine
  meaning
    says """
      Choose a storage engine for the event log.
      Prose may span several lines.
      """
  work
    title "Storage engine"
    status open
    due "2026-11-01"
  decision
    question "Which storage engine do we use?"
    options ["SQLite", "PostgreSQL"]
```

- The first line is the pragma `#! ia 1.0`. A file without it is refused with `IA-LANG-PRAGMA-MISSING`.
- `@decision storage-engine` starts a record: the word, then a name that starts with an ASCII letter. The word selects the record's schema and its owning system.
- Indent two spaces per level. A tab is refused with `IA-LANG-INDENT-TAB`.
- Sections such as `meaning` and `work` hold fields. Head fields, such as a contract's `version`, come before the first section.

Every value has one of the kernel's six value types, or is a list of one:

| Type or form | Write it as | Example |
| --- | --- | --- |
| `text` | A quoted string, or triple quotes for prose over several lines | `title "Storage engine"` |
| `id` | A bare identifier: a letter, then letters, digits and hyphens | `status open` |
| `number` | A decimal number | `limit-model-calls 1` |
| `flag` | `true` or `false` unquoted, or the bare field key | |
| `ref` | `@word name`, plus `#REQ-NAME` to name one requirement of a contract | `@contract storage-rules#REQ-STORAGE-BACKUP` |
| `qname` | A canonical four-slot identity | `work-system/definition/decision/storage-engine` |
| `list of T` (list form) | Items of type T, comma-separated in brackets | `options ["SQLite", "PostgreSQL"]` |

Every record has a four-slot identity, `system/kind/facet/name`. The word's registration supplies the system and kind. The facet is the word's first registered facet unless a `facet` head field selects another; each public word registers one. The name is lowercased for identity and keeps its authored spelling for display, so `@decision Storage-Engine` is `work-system/definition/decision/storage-engine`. Two records with one identity at the same authority band both fail with `IA-GRAPH-IDENTITY-TIE`; within one file the language layer reports them as `IA-LANG-IDENTITY-COLLISION`. Moving a record to another file does not change its identity.

Keep your records under `.ia/src/`, outside `.ia/src/floor/`, which replaces the language floor. A record outside every system folder is owned by its word's system. A record inside a system folder may use only that system's own words, `@system` and `@schema`, and the words of systems its `@system` lists in `requires`; any other word is refused with `IA-COMP-DISCRIMINATOR-FOREIGN`.

## Fields and allowed values

Each word's schema states which sections and fields a record needs:

- `must have` means exactly once and `may have` at most once. Only a `list of T` field may be written more than once.
- Every public schema except `@system` is closed: it refuses a body section or field it does not declare. Head fields are not checked against the schema, so a misspelled optional head field is kept without a finding.
- A field type may carry one narrowing. `id in [open, made]` admits only those ids, `ref to plan` requires a reference to a `@plan`, and `text form iso-date` requires a `YYYY-MM-DD` date.
- `governance.severity`, on `@law`, `@principle` and `@convention`, is read as a kernel dimension and takes `blocking`, `advisory` or `informational`; any other value is `IA-GRAPH-DIMENSION-UNKNOWN`.
- Relationship rows and contract `REQ-*` clauses follow shared language rules, not schema field rows.

| Finding | Severity | Cause |
| --- | --- | --- |
| `IA-COMP-SECTION-MISSING` | error | A required section is absent; its field rows are not reported separately |
| `IA-COMP-FIELD-MISSING` | error | A required field is absent |
| `IA-COMP-FIELD-TYPE` | error | A value of another type than the field declares, such as a bare string where a list is required |
| `IA-COMP-FIELD-DUPLICATE` | error | A field that is not a list is written twice |
| `IA-COMP-SECTION-UNKNOWN`, `IA-COMP-FIELD-UNKNOWN` | error | The closed schema declares no such section or field |
| `IA-COMP-FIELD-VALUE` | error | A value outside an `id in [...]` set |
| `IA-COMP-FIELD-FORM` | error | A value that does not match its text form, such as a date not written `YYYY-MM-DD` |
| `IA-COMP-FIELD-REF-TARGET` | error | A reference to another word than a `ref to <word>` field requires |
| `IA-COMP-FIELD-REF-MISSING` | warning | A typed reference that no admitted record declares |

## Relationships

A `relationships` section holds one row per relation: a predicate spelling, then a reference. The kernel defines eighteen predicates (`cite`, `constrain`, `consume`, `enforce`, `forbid`, `govern`, `grant-access-to`, `ground`, `implement`, `land`, `produce`, `record-lineage-from`, `require`, `route`, `run-before`, `supersede`, `trigger` and `use`), and each has an inverse and a present phrase:

```ia
  relationships
    supersedes @decision api-response-format
```

`supersede` and `supersedes` both state that this record supersedes the target. The inverse, `superseded-by`, states the same relation from the other side: the target supersedes this record. The authored spelling is kept. `ia inspect` shows an edge on the record that states it, and `ia inspect --edges both` also shows it on the other record as a derived inverse.

- **Consent.** Both systems must consent to a relation, through the `edges` rows of their `@system` records. A relation either side does not consent to is refused with `IA-GRAPH-EDGE-UNCONSENTED`, or `IA-LANG-EDGE-UNCONSENTED` when both records are in one file. `ia preview <word>` lists the rows that apply.
- **Resolution.** A target that no admitted record declares is a warning. When the word's schema has no `edges` rule for the relation, the finding is `IA-GRAPH-TARGET-MISSING` and the edge stays unresolved. When a rule limits the relation to one target, such as `may supersede decision one`, or requires a target that does not resolve, the finding is `IA-COMP-EDGE-UNRESOLVED`, and the record is withheld from admission until the target exists. The example above does this until `@decision api-response-format` exists, so write the target first. A `#REQ-NAME` fragment that the contract does not declare is an error, `IA-COMP-FRAGMENT-MISSING`.
- **Cardinality.** A schema's `edges` rules state how many of a relation a record may or must hold, such as `may supersede decision one`. More relations than a rule allows, or fewer than it requires, is an error, `IA-COMP-EDGE-CARDINALITY`.
- **Adoption and coverage.** A `requires @contract` relation adopts the contract's requirements. A `@case` that `implements` a requirement and a `@check` that `enforces` it declare coverage, not a passing run.

## Defining vocabulary

A system registers words, gives each a schema and names a steward accountable for them. `ia init . --id local/my-project --system --host none --apply --yes` writes `.ia/src/systems/my-project/system.ia`, holding an `@system` and its steward `@agent`, and a release `@distribution` in `records/distribution.ia` beside it. It also writes the starter records in `.ia/src/workspace.ia` and the release descriptor `.ia/release.json` that `ia pack` reads. To add a `@risk` word, add a `discriminators` entry and consent rows to `system.ia`, and extend the steward's `governance.applies`:

```ia
#! ia 1.0

@system my-project
  provider "local"
  version "0.1.0"
  describes "The authored records of the my-project workspace."
  steward @agent my-project-steward
  requires
    - agent-system
    - work-system
    - workspace-system
  discriminators
    risk lowers to definition
      category state
      facets [risk]
      schema @schema risk
  edges
    cite * using *

@agent my-project-steward
  meaning
    says "Owns the my-project system and its records."
    answers "Who owns this system?"
  governance
    applies [risk]
```

Then declare its schema in `.ia/src/systems/my-project/schemas/risk.schema.ia`:

```ia
#! ia 1.0

@schema risk
  lowers to definition
  sections
    must have meaning
    must have risk
    may have relationships
    closed
  fields
    must have meaning.says as text
    must have risk.likelihood as id in [low, medium, high]
    may have risk.mitigation as text
```

`ia preview risk` now prints the new word's schema, its default file `.ia/src/risk.ia` and its consent row, and `ia preview risk vendor-lock-in "meaning.says=The storage API ties us to one vendor." "risk.likelihood=medium"` previews a record of it. `ia author` with the same arguments and `--digest` writes it as `my-project/definition/risk/vendor-lock-in`. `ia pack --descriptor .ia/release.json` builds a digest-named archive of the system folder under `.ia/work/dist/`; records outside the folder stay in the workspace.

- **Lowering.** `lowers to` names a kernel kind, and `category`, `facets` and `schema` are required. An entry may add `artifact-set`, `primitive` and `move` rows, each a closed kernel value. A new word extends the vocabulary, never the closed kernel.
- **One owner per word.** The steward's `governance.applies` must cover every word the system registers (`IA-COMP-STEWARD-MISSING`), and a word whose schema no visible file declares is refused with `IA-LANG-SCHEMA-MISSING`. Prefer an existing word when it represents the concept.
- **Consent rows.** Each `edges` row reads `<predicate> <target words> using <source words>`. A side may be `*`, or `any-adopter` for the words of every system that requires this one. A system with no rows admits no relation, and a registered word that no row names is reported with the warning `IA-COMP-CONSENT-EMPTY`.
- **Owner edits.** `ia author` refuses to write `@system` and `@schema` records (`IA-CLI-EDIT-AUTHORITY`), as it refuses the other administrative words `workspace`, `agent`, `mandate`, `agent-profile` and `hook`. Edit them in source and run `ia validate`.

The [language package contract](../../../packages/language/SPEC.md) defines the declaration grammar (L14–L20). The catalogue's `@system` entry lists its head fields only.

## Composition and execution

| Word | What it declares |
| --- | --- |
| `@agent` | A participant. It grants no host permission. |
| `@mandate` | The participant's bounded authority: the moves it allows, the workspaces it scopes, the words it excludes and the paths it covers. |
| `@capability` | Operations, procedures, templates, checks and included capabilities, with execution bounds, and optionally how a host invokes it (`invocation`: by the model, by the user, delegated or not at all). |
| `@agent-profile` | An agent with its capabilities and an optional mandate, voice and delegates, and optionally its invocation and presentation. |
| `@harness` | Profiles and execution bindings composed in a workspace under a host contract. |
| `@execution-binding` | A native target connected to a host-installed entry or operation. |
| `@voice` | Communication attributes, separate from authority and procedure. |

Declaring these records installs and runs nothing. `ia validate` reports each `@execution-binding` as bound, unavailable or revoked against the installed implementation catalog a host has joined. `compileHarness` from `@inventarch/agent-composition-system` compiles a harness without calling a model, and refuses a missing profile, a recursive capability or an unavailable host implementation. A `@playbook` holds procedure cells at kernel phase and primitive coordinates; `ia position` delivers the cells that apply within its budget and executes none. A `@template` describes rendering, a `@hook` describes an event binding that a host adapter registers, and a `@run` describes execution state without starting it. A `@distribution` with a `product` section describes a host plugin: `ia init --from` writes these records when it lowers a plugin, and `ia project claude --product plugin --out <directory>` renders them back. The [composition package contract](../../../.ia/src/systems/agent-composition-system/SPEC.md) names the compiler's exports.

## Quality, architecture and evidence

- A `@contract` has a `version` head field and states `REQ-*` clauses in sections such as `outputs` or `invariants`. It needs a `governs` relationship to the record it governs (`IA-LANG-CONTRACT-UNBOUND`).
- A record adopts the contract with `requires @contract <name>`.
- A `@check` names its evaluator in `check.runs`, selects verdicts with `check.scope` (`*` selects every verdict its evaluator reports) and `enforces` a requirement.
- A `@case` declares a scenario, names its evaluator and `implements` a requirement. Every requirement needs an unconditional implementing case (`IA-COMP-COVERAGE-MISSING`), and its cases must include a success and a failure or refusal (`IA-COMP-COVERAGE-KIND`).
- An `@observation` records evidence: origin, actor, locator, revision and availability, and optionally the subject, evaluator, move and a `success`, `refusal` or `inconclusive` verdict. Field typing does not verify a digest, a timestamp or a retention transition.

Architecture uses the same words: workspaces for boundaries, relationship edges such as `uses` for dependencies, and adopted contract requirements for constraints. The [quality](../../../examples/public-language/records/quality.ia), [architecture](../../../examples/public-language/records/architecture.ia) and [evidence](../../../examples/public-language/records/evidence.ia) examples show each pattern; they are toy requirements, not a prescribed standard.

## Reading validation results

`ia validate` prints one status line, the errors and warnings, then the checks, bindings and evidence when the workspace has any, and ends with the next command to run. **Admitted** with **0 errors** exits 0; **Refused** means at least one error and exits 1. Warnings never refuse the workspace, but one can withhold a single record, as `IA-COMP-EDGE-UNRESOLVED` does; the summary's record count shows it. Each finding names its code, source path and line, and the record identity when there is one; `--json` returns them as `findings` beside `status`, `reportOutcome` and `counts`.

The code's prefix names the layer that raised it:

| Prefix | Layer | Codes you may see |
| --- | --- | --- |
| `IA-LANG-` | Reading the source and registering vocabulary | `IA-LANG-PRAGMA-MISSING`, `IA-LANG-INDENT-TAB`, `IA-LANG-STRING-UNTERMINATED`, `IA-LANG-DISCRIMINATOR-UNREGISTERED`, `IA-LANG-SCHEMA-MISSING`, `IA-LANG-IDENTITY-COLLISION` |
| `IA-GRAPH-` | Identity and relationship resolution | `IA-GRAPH-IDENTITY-TIE`, `IA-GRAPH-EDGE-UNCONSENTED`, `IA-GRAPH-DIMENSION-UNKNOWN`, `IA-GRAPH-TARGET-MISSING` (warning) |
| `IA-COMP-` | Schemas, ownership, coverage and checks | `IA-COMP-FIELD-VALUE`, `IA-COMP-DISCRIMINATOR-FOREIGN`, `IA-COMP-STEWARD-MISSING`, `IA-COMP-COVERAGE-KIND`, `IA-COMP-EDGE-UNRESOLVED` (warning), `IA-COMP-NOT-EVALUATED` (warning) |

Fix the source the finding names, or supply the missing record, then validate again.

A requirement or check has three outcomes: `pass` means its evaluator observed the requirement satisfied, `fail` means it observed a violation, and `not-evaluated` means no supported observation was made. A missing or throwing evaluator gives `not-evaluated`, and admission never turns it into a pass. A new workspace reports two `IA-COMP-NOT-EVALUATED` warnings, `COMP-KERNEL` and `COMP-FIXTURES`, because no verification evidence was supplied, so its run outcome is `not-evaluated`. `ia validate` binds each `@check` to a built-in or installed-catalog evaluator and records the checks that passed or failed as `@observation` evidence under `.ia/work/evidence/`; when none passed or failed, or admission was refused, it records nothing.

## Learn more

- [Vocabulary catalogue](vocabulary.md) and [language reference contract](SPEC.md)
- [Language](../../../packages/language/SPEC.md), [graph](../../../packages/graph/SPEC.md) and [compliance](../../../packages/compliance/SPEC.md) package contracts
- [Public-language examples](../../../examples/public-language/README.md), the [architecture reference](../architecture/README.md) and the [package reference](../packages/README.md)
- [Root README](../../../README.md) and the [CLI guide](../../../apps/cli/README.md)

## Compatibility guidance for floor vocabulary

For a new optional singleton relationship, write `may cite <word> one` (or the needed predicate). Both `may … optional` and `must … optional` remain valid compatibility spellings for zero or one target; `must … optional` does not require presence. No existing schema needs rewriting.

The `projection` artifact set includes an authored rendering or packaging specification, such as a template or distribution, as well as its generated output. The authored sources remain authoritative over the output. A registration's artifact-set describes its role; it does not assert that the record was generated or that rendering or packaging ran.

A position may explicitly select any kernel primitive with `--primitive`, including Memory and Escalation. Without it, shape supplies the primitive; an omitted phase follows the selected primitive's anchor. Legacy coordinate-based context and select requests still declare the primitive themselves.
