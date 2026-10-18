# compliance tooling contract

## Purpose

Evaluate repository compliance using subject-bound evidence and concrete success/refusal fixtures.

## Modules

- [check.test.ts](check.test.ts) — behavior and refusal coverage.
- [check.ts](check.ts).
- [evidence-fixtures.ts](evidence-fixtures.ts).
- [execution-fixtures.ts](execution-fixtures.ts).
- [fixture-authoring.ts](fixture-authoring.ts).
- [foundation-adoption.test.ts](foundation-adoption.test.ts) — behavior and refusal coverage.
- [foundation-adoption.ts](foundation-adoption.ts).
- [hook-fixtures.ts](hook-fixtures.ts).
- [inventory.ts](inventory.ts).
- [publication-fixtures.test.ts](publication-fixtures.test.ts) — behavior and refusal coverage.
- [publication-fixtures.ts](publication-fixtures.ts).
- [runtime-fixtures.ts](runtime-fixtures.ts) — compatibility exports for the named runners.
- [corpus.ts](corpus.ts) — root-relative conformance source selection shared by the gate and inventory.
- [door-fixtures.ts](door-fixtures.ts) — runtime door boundaries.
- [actor-fixtures.ts](actor-fixtures.ts) — actor evidence.
- [mandate-fixtures.ts](mandate-fixtures.ts) — mandate evidence.
- [read-fixtures.ts](read-fixtures.ts) — read evidence.
- [next-fixtures.ts](next-fixtures.ts) — next-step evidence.

## Commands

- `pnpm compliance:check`: `node --conditions=development --import tsx tools/compliance/check.ts`.

`compliance:check` accepts only optional `--json`; inventory accepts mutually exclusive `--check` and `--write`, defaulting to check. Parsing refuses unknown or duplicate flags before evaluation. Shared inventory writes preserve unchanged bytes and validate the complete output set.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Compiled native graph, current floor, canonical language fixture corpus, declared evaluator inventory and host/publication observations.

## Outputs

Check reports verdicts and exits nonzero for fail or not-evaluated. Inventory generation owns its explicit catalog output; fixture effects stay inside owned scratch roots.

## Prerequisites

Source-aware Node/tsx; emitted host artifacts are required where a fixture actually launches a host.

## Validation

Task ownership: `tools:test-compliance`, `compliance:check`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Kernel verification and graph revision share the evaluated floor. No caller-asserted map becomes verified evidence. Required unavailable evaluation cannot pass.

## Limits

A declaration of coverage does not execute behavior. Platform-specific publication observations remain limited to the platform actually run.

## Detailed behavior

Runs all language fixtures and graph, evaluator evidence, runtime, hook, execution and publication refusal boundaries. Every evaluator evidence code requires a successful producer observation; these synthetic local receipts qualify pure APIs, not live writer or service authority.

## Foundation authoring adoption

Adoption evidence uses the neutral conformance system corpus with the repository's current floor. `native:check` separately validates shipped defaults. The adopter-specific evaluator is test composition, not an installed default. Publication qualifications retain their actual platform limits.

Kernel and package fixture evidence use the compliance package's verified conformance path, bound to the exact source inputs of the evaluated graph. The floor digest must match the verified floor; generated kernel drift and repository boundary failures are additional admission failures. Evidence for a different floor cannot provide a kernel PASS. This repository gate exits 0 only for a complete `pass`; both `fail` and `not-evaluated` exit 1. `--json` includes the verified conformance summary and actual platform limits.

The published compliance package includes `fixtures/language` for runtime fixture verification. Repository-only refusal runners are not shipped; they are neither exported package API nor installed runtime prerequisites.

## Package-v1 inventory

`inventory.ts --check|--write` regenerates `packages/compliance/src/conformance/inventory.generated.ts` from the language fixtures, the conformance corpus, the boundary suites and the code inventories ([compliance C31](../../packages/compliance/SPEC.md)). `compliance:check` runs the check: any fixture, companion or corpus edit fails COMP-FIXTURES until `--write` runs.
