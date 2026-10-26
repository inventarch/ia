# Checks and evidence

**IA checks in three layers. Every `ia validate` admits or refuses every record. A `@check` asks IA to evaluate something specific and keep the result. An `@observation` records evidence, whether IA produced it or something else did, such as a test run.**

| Layer | Written as | Who evaluates | Result kept as |
| --- | --- | --- | --- |
| Admission | Nothing; it always runs | `ia validate` | The findings it prints |
| Checks | `@contract`, `@case`, `@check` | A built-in evaluator during `ia validate` | An observation under `.ia/work/evidence/` |
| Evidence | `@observation` | You, an agent, CI, a reviewer | The observation itself, in `.ia/src/` |

## Admission

Every run of `ia validate` checks every record: its syntax, its schema and its references. It also checks that each relationship is one the systems allow, and that no two records share an identity. The workspace is **Admitted** when nothing is an error, and **Refused** otherwise. `ia validate` exits `0` or `1` to match.

Warnings do not refuse the workspace. One kind of warning appears on every new workspace:

```text
  ▲  (whole workspace)  COMP-KERNEL
     IA-COMP-NOT-EVALUATED  matching-revision verification evidence was not
     supplied
```

`COMP-KERNEL` and `COMP-FIXTURES` are self-tests of the language. They are not run by default, so they report **not-evaluated**. Run them with `ia validate --verify-conformance`, which takes a second or two, and both report `pass, verified`.

## Contracts, cases and checks

### Contracts

A `@contract` names requirements. Each requirement is a clause whose key starts with `REQ-`:

```ia
@contract pantry-records
  version "1.0.0"
  meaning
    says "What Pantry's own records must satisfy."
    answers "Which requirement do Pantry's records adopt?"
  outputs
    REQ-RECORDS-CONFORM "Every Pantry record conforms to its word's schema."
  relationships
    governs @workspace pantry
```

- `version` is required and comes before the first section.
- Requirements go in any of `inputs`, `outputs`, `preconditions`, `invariants`, `failures`, `authority`, `context` and `evolution`, whichever reads best.
- A contract must say what it governs. One without a `governs` relationship is refused with `IA-LANG-CONTRACT-UNBOUND`.
- `@contract pantry-records#REQ-RECORDS-CONFORM` points at one requirement.

### Cases

A `@case` describes one scenario for a requirement:

```ia
@case records-conform-failure
  meaning
    says "A workspace with a record that breaks its schema."
    answers "What does a failing run look like?"
  scenario
    kind failure
    given "A task in .ia/src has a work.status its schema does not allow."
    request "Run ia validate."
    expected "The records-conform check fails and ia validate refuses the workspace."
    evaluator "COMP-SCHEMA"
  relationships
    implements @contract pantry-records#REQ-RECORDS-CONFORM
```

IA enforces **coverage**:

- every requirement needs at least one case that `implements` it, or validation refuses with `IA-COMP-COVERAGE-MISSING`;
- every contract needs at least one case of `kind success` and one of `kind failure` or `kind refusal`, or it refuses with `IA-COMP-COVERAGE-KIND`.

A case is a description, not a test run. It says what should happen; it does not show that anything ran.

### Checks

A `@check` asks IA to evaluate something during `ia validate`:

```ia
@check records-conform
  meaning
    says "Every record in the workspace conforms to its schema."
    answers "Do the Pantry records conform?"
  check
    runs COMP-SCHEMA
    scope "*"
  relationships
    enforces @contract pantry-records#REQ-RECORDS-CONFORM
```

| Field | Says |
| --- | --- |
| `check.runs` (or `check.implementation`) | Which evaluator to use. If you give both, they must be equal. |
| `check.scope` | Which of the evaluator's results to look at: `"*"` for all of them, or one scope the evaluator reports, such as a record identity |
| `check.covers` | Optional file paths the check is about. This documents the check; it does not change what is evaluated. |

`enforces` says which requirement or rule the check stands for.

## Built-in evaluators

IA runs these evaluators itself, in every `ia validate`. A check that names one gets a real result. Each reports its results per **scope**, and `check.scope` picks which to count:

| Evaluator | Checks | Scope values it reports |
| --- | --- | --- |
| `COMP-SCHEMA` | Each record against its word's schema | Each record's identity |
| `COMP-COVERAGE` | Each contract's cases, as described above | Each contract's identity |
| `COMP-CONSENT` | Every relationship is allowed and points at a real record | `graph` |
| `COMP-IDENTITY` | No two records share an identity | `graph` |
| `COMP-FRAGMENT` | Every `#REQ-…` or `#phase/Primitive` part exists | `graph` |
| `COMP-PARSE` | Every file parses | `sources` |
| `COMP-SELECTOR`, `COMP-VARIANT` | Selectors and variant clauses in records | Each record's identity |
| `COMP-CHECK` | Each check names an evaluator IA knows | Each check's identity |
| `COMP-SYSTEM`, `COMP-STEWARD`, `COMP-CONSENT-DECLARED` | System folders you define (see [Your own vocabulary](your-own-vocabulary.md)) | The system folder |
| `COMP-SCHEMA-ENROLLED`, `COMP-BOOTSTRAP` | Word registrations and system dependency order | `registry` |
| `COMP-ADOPTION` | Contracts a record adopts, with evaluators a host supplies | `<adopter>-><contract>` |
| `COMP-KERNEL`, `COMP-FIXTURES` | The language's self-tests | `floor`, `package-v1` |

Two examples:

- `runs COMP-SCHEMA` with `scope "*"` passes when every record conforms. With `scope "work-system/definition/task/write-exporter"`, it passes or fails on that one task.
- `runs COMP-COVERAGE` with `scope "compliance-system/contract/signature/pantry-records"` passes when that contract's requirements all have cases.

A scope that selects no results, such as a sentence of prose or a misspelled identity, gives **not-evaluated**, never an empty pass. A check on `COMP-KERNEL` stays not-evaluated even with `--verify-conformance`, because checks read the ordinary admission results.

### Results

When a check selects several results, the worst one wins: **fail**, then **not-evaluated**, then **pass**.

```text
Checks
  ✔  compliance-system/check/gate/records-conform
     COMP-SCHEMA: bound, pass
     built-in COMP-SCHEMA: 187 selected verdicts, pass
  •  Recorded 1 observation in
     .ia/work/evidence/3b9ee4d70b488ad9163a95e5adacec309102acebfd863d1ad17d1dea53c0731e.ia.
```

When the workspace is admitted, `ia validate` writes one `@observation` for each passing check to `.ia/work/evidence/<revision>.ia`. Each says what was checked, by which evaluator, at which revision, and what it does not cover:

```ia
@observation records-conform-3b9ee4d70b48
  …
  evidence
    origin check
    actor "ia validate"
    …
    subject @check records-conform
    evaluator "built-in COMP-SCHEMA"
    move Verification
    verdict success
  interpretation
    applies "The admitted records of authored revision 3b9ee4d70b48 that check.scope * selects."
    limits "The verdicts of a built-in evaluator in admission at one authored revision; no external evaluator ran and nothing was executed."
    …
```

These files are working state. They sit in the ignored `.ia/work/` folder, IA replaces them when the revision changes, and they never change your records. A failing check writes nothing, because the workspace is refused.

### Evaluators that are not built in

A check may name any evaluator, such as `runs npm-test`. **In this release IA does not run evaluators that are not built in.** Such a check:

- shows as `unavailable, not-evaluated` in `ia validate`, which still admits the workspace and warns you;
- counts as an `IA-COMP-CHECK-UNKNOWN` error everywhere else: `ia capture` records the error and exits `1`, and `ia host` and `ia project` refuse the workspace until you remove or replace the check.

To bring in results from your own tools, record them as observations, as the next section shows.

### Adopting a contract

A record can adopt a contract with `requires @contract <name>`, which makes the contract's requirements apply to it. `ia validate` reports each adopted requirement through `COMP-ADOPTION`. It supplies no evaluators for adopted requirements, so they report `not-evaluated` with "No structural evaluator is supplied". Programs built on IA's packages can supply their own; see the [compliance package](../../packages/compliance/README.md).

## Observations

An `@observation` is a piece of evidence: something was looked at, by someone, with some result. It is how IA records results from outside itself, such as a test run, a review or a CI job. A successful observation about a task is what makes the task done in `ia next` (see [Planning work](planning-work.md#when-a-task-is-done)).

```ia
@observation write-exporter-tests-pass
  meaning
    says "The exporter's unit test passed after the exporter was written."
    answers "Is the write-exporter task finished?"
  evidence
    origin test
    actor "node --test"
    observed-at "2026-10-26T09:12:00Z"
    captured-at "2026-10-26T09:12:00Z"
    workspace "pantry"
    locator "src/export.test.mjs"
    revision "2b3f89bec1dd33f5d44e6b1cb56678ecd7a20bc5288e3a27dee732e4a48f59c2"
    bundle "test-results/export.txt"
    digest "cae0526cbea5cfb44d6d1fdffe7bfdec2171b75814f2670e494bab187cc88d4d"
    availability available
    subject @task write-exporter
    subject-revision "2b3f89bec1dd33f5d44e6b1cb56678ecd7a20bc5288e3a27dee732e4a48f59c2"
    evaluator "node@22.22.2"
    move Verification
    verdict success
  interpretation
    applies "src/export.mjs as tested by src/export.test.mjs."
    limits "One unit test on one machine; the export button and the README are not covered."
    reason "The test feeds two recipes that share an ingredient and compares the exact list."
    basis evaluation
  retention
    status retained
```

| Field | Says |
| --- | --- |
| `evidence.origin` | What kind of source produced it: `test`, `check`, `review` |
| `evidence.actor` | Who or what produced it, in words |
| `evidence.observed-at`, `captured-at` | When it was observed, and when it was recorded |
| `evidence.workspace` | Which workspace it belongs to |
| `evidence.locator` | What was looked at: a file, a record, a URL |
| `evidence.revision` | Which version of that thing |
| `evidence.bundle` | Where the raw evidence is kept, such as a log file |
| `evidence.digest` | The sha256 of that raw evidence |
| `evidence.availability` | `available` if the raw evidence can be read, `unavailable` if not |
| `evidence.subject` | The record it is about, as a reference |
| `evidence.subject-revision` | That record's digest at the time; `ia next` compares it with the current one |
| `evidence.evaluator` | Who judged the result, as a name or `<tool>@<version>` |
| `evidence.move` | The kind of action, usually `Verification` |
| `evidence.verdict` | `success`, `refusal` or `inconclusive` |
| `interpretation.applies` | What the result covers |
| `interpretation.limits` | What it does not cover. Be honest here; it is the most useful field for a reader. |
| `interpretation.reason` | Why the result means what it says |
| `interpretation.basis` | `evaluation` if something was run or inspected, `inference` if it was reasoned |
| `retention.status` | Usually `retained` |

**IA checks an observation's shape, not its truth.** It does not rerun the test, read the log, recompute the digest or check the timestamps. An observation is a specific, attributable, versioned claim that a person or tool can verify. That is far more than "the agent said it passed", but it is still a claim. For stronger assurance, have CI or a reviewer write the observation rather than the agent that did the work.

## Improvements

An `@improvement` proposes a change to a record: what it targets, the text before, the candidate after, how to verify and reverse it, and its review and publication status. It is a structured proposal for people to review. IA stores and checks it but never applies it.

## Common mistakes

| You see | Because |
| --- | --- |
| `IA-COMP-COVERAGE-MISSING` | A requirement has no case that `implements` it |
| `IA-COMP-COVERAGE-KIND` | The contract lacks a success case, or a failure or refusal case |
| `IA-LANG-CONTRACT-UNBOUND` | The contract has no `governs` relationship |
| `IA-COMP-FRAGMENT-MISSING` | `#REQ-…` names a requirement the contract does not have |
| `IA-COMP-CHECK-CONFLICT` | `check.runs` and `check.implementation` disagree |
| `IA-COMP-CHECK-UNKNOWN` | A check names an evaluator IA cannot run, or none |
| A check stays `not-evaluated` | Its scope selects nothing. Use `"*"` or a scope the evaluator reports |
