# @inventarch/compliance

[![npm](https://img.shields.io/npm/v/@inventarch/compliance?label=npm)](https://www.npmjs.com/package/@inventarch/compliance) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.22.0%20%3C23-brightgreen)](package.json)

> Checks over compiled IA records and graphs: schema conformance, system admission, fragments, coverage, selectors, variants and contract adoption with supplied evaluators, assembled into one revision report. It also resolves obligations against an optional evaluator catalog and qualifies evidence receipts.
>
> It consumes [`@inventarch/graph`](../graph/README.md); [`@inventarch/db`](../db/README.md) uses its verdicts to admit a workspace.

## ⚡ Quick start

```sh
npm install @inventarch/language @inventarch/graph @inventarch/compliance
```

```js
import { buildRegistry, compile, KERNEL_DIGEST, KERNEL_SOURCES, LANGUAGE_VERSION, parse } from '@inventarch/language';
import { load } from '@inventarch/graph';
import { evaluate } from '@inventarch/compliance';

const location = { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' };
const sources = KERNEL_SOURCES.map((source) => ({ ...source, location }));
const parsed = sources.map((source) => ({ ...parse(source.text, source.path), location }));
const registered = buildRegistry(parsed);
const compiled = parsed.map((source) => compile(source.ast, registered.registry, location, []));
const graph = load(
  compiled.flatMap((result) => result.records),
  registered.registry,
  { sources, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' },
);

const report = evaluate(graph, {
  sourceDiagnostics: [...registered.diagnostics, ...compiled.flatMap((result) => result.diagnostics)],
});
console.log(report.outcome); // not-evaluated
for (const verdict of report.verdicts.filter((v) => v.outcome !== 'pass'))
  console.log(verdict.check, '|', verdict.findings[0].message);
// COMP-FIXTURES | COMP-FIXTURES: matching-revision verification evidence was not supplied
// COMP-KERNEL | COMP-KERNEL: matching-revision verification evidence was not supplied
// COMP-STEWARD | System folder discovery observations were not supplied
// COMP-SYSTEM | System folder discovery observations were not supplied
```

Every other verdict passes, yet the report is `not-evaluated`, not `pass`: the kernel and fixture checks need verification evidence at the graph's revision, and the system and steward checks need the discovered system folders (`folders`).

The package can produce the kernel and fixture evidence itself. It is opt-in: pass the graph's revision inputs with the evidence, and both checks are bound to that graph:

```js
import { verifyFixtures, verifyKernel } from '@inventarch/compliance';

const inputs = { sources, languageVersion: LANGUAGE_VERSION, kernelDigest: KERNEL_DIGEST, location: '' };
const verified = evaluate(graph, {
  sourceDiagnostics: [...registered.diagnostics, ...compiled.flatMap((result) => result.diagnostics)],
  conformance: { inputs, kernel: verifyKernel(), fixtures: verifyFixtures() },
});
for (const verdict of verified.verdicts.filter((v) => ['COMP-KERNEL', 'COMP-FIXTURES'].includes(v.check)))
  console.log(verdict.check, verdict.outcome, verdict.basis);
// COMP-FIXTURES pass verified
// COMP-KERNEL pass verified
console.log(verified.conformance.profile); // package-v1 (the released name, written until the follow-up release; `package` is read too)
```

`verifyKernel()` regenerates the kernel from the floor and compares it with the running `@inventarch/language`; `verifyFixtures()` runs the `package` profile of the fixtures this package ships (the profile id is read as `package` or `package-v1`; the released `package-v1` is written until the switch flips in the follow-up release, dec-008, A15). `verified.conformance.fixtures.outOfProfile` names the suites that profile does not run: hooks, the runtime, escalation, execution and publication.

## 🧭 What it does

| Area | Exports |
| --- | --- |
| Revision report | `evaluate(graph, options?)` returns an immutable report keyed to `graph.revision`: `outcome`, `verdicts`, `findings` and `shadows`. `fail` dominates `not-evaluated`, which dominates `pass`. |
| Schema checks | `validateSchema(record, registry, pool)` for bootstrap without a graph and `validateGraphSchema` on a graph: sections, fields, value types and narrowings (`matchesType`, `matchesForm`) and relationship cardinality. |
| System admission | `validateSystems(folders, registry, pool)`: one `@system` per folder, words from systems the folder does not require, steward coverage, schema enrolment and declared consent. |
| Graph checks | `validateFragments`, `validateCoverage`, `validateSelectors`, `validateVariants`, `validateConsent`, `validateIdentity`, `validateParse`, and `validateCheck` (built-in or catalog evaluator ids) or `validateCheckStructure` (any one named evaluator). `CHECK_IDS` lists the built-in evaluator ids a `@check` may name; `checkRunner(node)` reads `check.implementation`, else `check.runs`. |
| Contract adoption | `validateAdoption` calls the clause evaluators you supply, keyed by contract and requirement. |
| Evaluator catalog | `createEvaluatorCatalog`, `selectEvaluator` and `bindEvaluators` register a host's trusted, namespaced evaluators for the id a `@check` names. |
| Obligations and receipts | `resolveObligations`, `inspectObligations`, `profileOccurrences`, `validateReceipt`, `acceptEvaluatorOutput`, `adaptBuiltinVerdict` and `admitTransition` decide which obligations apply, whether a receipt is valid and current, and whether a transition may be admitted. |
| Fixtures | `runLanguageFixture` runs one conformance fixture you read yourself; `fixtureCoverage` checks that passing failing cases observe every required code. The package ships its conformance fixtures under `fixtures/`. |
| Conformance evidence | `verifyKernel`, `verifyFixtures` and `isConformanceEvidence` produce and recognise COMP-KERNEL and COMP-FIXTURES evidence; `evaluate`'s `conformance` option binds it to a graph. Evidence about another graph, floor or toolchain stays `not-evaluated`, and evidence the package did not produce is refused. A bound result that passed or failed carries `basis: 'verified'`; one left `not-evaluated` carries none. Results from the caller's own `evidence` map carry `basis: 'caller-asserted'`. |
| Host plugin | `renderClaudePlugin` returns the files of the user-level Claude Code plugin that `ia host claude --user` installs. |

`evaluate` takes these options:

- `sourceDiagnostics` and `folders`: the language diagnostics and the discovered system folders.
- `adoptionEvaluators`: clause evaluators keyed by contract identity, then requirement id, with an optional `coordinate` for conditional clauses.
- `catalog`, and `checks: 'structural'` for the structural COMP-CHECK.
- `admission`: prior non-pass assessments for subjects no longer in the graph.
- Either `conformance` or `evidence`, not both. `evidence` maps `COMP-KERNEL` or `COMP-FIXTURES` to a `Verdict` built with `verdict(assessment, graph.revision)`.

Finding codes are `COMP_CODES` and `EVIDENCE_CODES` (`IA-COMP-*`); language and graph findings keep their own codes. The `./internal/*` subpaths are published for IA's own toolchain; use the root entry point.

## ⚖️ What it does not do

- **No I/O or execution beyond its own files.** Apart from `verifyKernel` and `verifyFixtures`, which read only this package's own files and write nothing, it reads no files, network or clock, schedules and persists nothing, and calls only host functions you supply, such as evaluators, codecs and predicates. The caller also supplies source diagnostics, system folders, any other verification evidence and the current time.
- **Self-verification is not a trust root.** The conformance evidence is produced by the code it verifies. Pin `kernelDigest` and `inventoryDigest` and rely on npm integrity for the package itself.
- **`not-evaluated` is never a pass.** Missing evidence, a missing or throwing clause evaluator, an unavailable catalog evaluator and an unresolved relationship that could change an answer all leave a check `not-evaluated`.
- **Declarations are not results.** A `@case` establishes declared coverage, not an executed test, and coverage never satisfies adoption. A `@check` names an evaluator; it does not run it, and `bindEvaluators` invokes nothing.
- **Trust is never self-asserted.** A service-associated receipt counts only when the host's verifier accepts it, and a resolution digest is an integrity check, not authentication.
- **Conformance is not truth.** A passing report establishes that records conform to their schemas and that their relationships resolve with consent, not that their prose is true or complete.

## 📚 Learn more

- [SPEC.md](SPEC.md): the package contract, refusal codes, the evaluator catalog, obligation and receipt clauses, native conformance evidence (C31) and the host plugin renderer (C32)
- [LANGUAGE.md](LANGUAGE.md): the packaged summary of the words this release ships
- [Architecture reference](../../docs/reference/architecture/README.md#which-package-to-use) and the [host plugin specification](../../docs/specs/host-plugin-distribution/README.md)
- Neighbours in the dependency direction: [`@inventarch/language`](../language/README.md) and [`@inventarch/graph`](../graph/README.md) before it; [`@inventarch/db`](../db/README.md) after it
- In this repository, `pnpm compliance:check` runs these checks over the native corpus, the conformance fixtures and the `package` inventory
- [Root README](../../README.md)
