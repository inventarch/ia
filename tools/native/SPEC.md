# native tooling contract

## Purpose

Compile and validate native corpora, repository architecture/work policy, public vocabulary and bundled language bases.

## Modules

- [check.test.ts](check.test.ts) — behavior and refusal coverage.
- [check.ts](check.ts).
- [compile.ts](compile.ts).
- [fixture-instances.ts](fixture-instances.ts).
- [language-base.test.ts](language-base.test.ts) — behavior and refusal coverage.
- [language-base.ts](language-base.ts).
- [public-fixture.test.ts](public-fixture.test.ts) — behavior and refusal coverage.
- [public-fixture.ts](public-fixture.ts).
- [public-language.test.ts](public-language.test.ts) — behavior and refusal coverage.
- [public-language.ts](public-language.ts).
- [public-systems.d.mts](public-systems.d.mts) — interface declaration; implementation checking is tracked separately.
- [public-systems.mjs](public-systems.mjs).
- [public-systems.test.ts](public-systems.test.ts) — behavior and refusal coverage.
- [public-vocabulary.ts](public-vocabulary.ts).
- [release-roots.ts](release-roots.ts).
- [release-work.test.ts](release-work.test.ts) — behavior and refusal coverage.
- [release-work.ts](release-work.ts).
- [repository-architecture.test.ts](repository-architecture.test.ts) — behavior and refusal coverage.
- [repository-architecture.ts](repository-architecture.ts).
- [work-example.test.ts](work-example.test.ts) — behavior and refusal coverage.

## Commands

- `pnpm native:check`: `node --conditions=development --import tsx tools/native/check.ts`.
- `pnpm release-roots:generate`: `node --conditions=development --import tsx tools/native/release-roots.ts --write`.
- `pnpm release-roots:check`: `node --conditions=development --import tsx tools/native/release-roots.ts --check`.
- `pnpm public-language:check`: `node --conditions=development --import tsx tools/native/public-language.ts`.
- `pnpm vocabulary:check`: `node --conditions=development --import tsx tools/native/public-vocabulary.ts --check`.
- `pnpm vocabulary:generate`: `node --conditions=development --import tsx tools/native/public-vocabulary.ts --write`.
- `pnpm language-base:generate`: `node --conditions=development --import tsx tools/native/language-base.ts --write`.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Authored .ia floor/systems/records, native release roots, selected example fixtures, language sources and explicit public-system package policy.

## Outputs

Check commands report diagnostics; explicit generation writes vocabulary, distribution roots or CLI language-base assets.

## Prerequisites

Source-aware Node/tsx and pinned package dependencies. Package APIs remain in their owning packages.

## Validation

Task ownership: `tools:test-native`, `native:check`, `public-language:check`, `vocabulary:check`, `language-base:generate`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

System payloads exclude repository maintenance work and neutral examples. Root lists come from the declared workspace composition; semantic schema admission and repository policy remain distinct.

## Limits

Native syntax validation does not attest host authorization or published archive readiness. Release selectors require their own compatibility evidence.

## Detailed behavior

`pnpm native:check` also evaluates this repository's architecture boundary: reusable system payloads contain no neutral examples or repository plans, milestones, tasks, decisions or specification instances. The specification boundary applies regardless of an optional source locator; schema declarations remain valid in their owning systems. This is repository policy, not a generic language restriction. Examples live under `examples/public-language` and tests materialize an explicitly selected fixture corpus. Maintenance work and repository policy live under `.ia/src/records`; `.ia/src/workspace.ia` is the single source-declaring repository workspace. Root release controls are selected explicitly by the native package-set packer.

`pnpm release-roots:generate` derives the live `language-distribution` system roots from that workspace's unique, unconditional `composition.systems` list. It preserves the distribution identity and direct system roots so repository maintenance records are not pulled into archives through a workspace root. `pnpm release-roots:check` and `pnpm native:check` refuse drift without writing. The isolated public-language fixture remains the bundled language builder's input.

The maintained release law explicitly governs all six release work records, with incoming consent from work-system. The repository gate refuses missing or conditional governing edges, and runtime regressions verify identity-seat and path-seat delivery. Generic `governance.applies` semantics remain unchanged.

The release-work lint reads compiled work records sourced from `releases/current.json` or the maintained system-package policy, following work hierarchy and require/ground links. Active intent cannot duplicate an explicit npm version or package count, even if it matches the current policy. Historical decisions may retain literal choices when bound to versioned release evidence. Public native artifact selectors follow the npm release target; syntax and protocol versions and unrelated fixtures retain their independent meanings. The language archive at artifact version 3.0.0 continues to declare syntax 1.0, format 1 and its existing engine requirement. This is a bounded repository lint, not an English semantic evaluator or a host authorization gate. Generic `ia validate` establishes admission; the repository's `pnpm native:check` and focused test suites establish these additional invariants.

The native law, contract, coverage check and success/refusal cases in `.ia/src/records/repository-policy.ia` describe these obligations. `COMP-COVERAGE` declares requirement coverage; the concrete functions in `release-work.ts` and `repository-architecture.ts`, invoked by `check.ts`, enforce the repository checks. A law record does not install a hook or activate a ledger.
