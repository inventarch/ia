# systems tooling contract

## Purpose

Host repository authoring operations, publication boundaries and system scenario checks.

## Modules

- [authoring-guides.test.ts](authoring-guides.test.ts) — behavior and refusal coverage.
- [authoring-manifest.test.ts](authoring-manifest.test.ts) — behavior and refusal coverage.
- [execute.test.ts](execute.test.ts) — behavior and refusal coverage.
- [execute.ts](execute.ts).
- [fixture.ts](fixture.ts).
- [generate-authoring.ts](generate-authoring.ts).
- [publish.ts](publish.ts).
- [run.ts](run.ts).
- [scenarios.ts](scenarios.ts).

## Commands

- `pnpm system:run`: `node --conditions=development --import tsx tools/systems/run.ts`.
- `pnpm authoring:check`: `node --conditions=development --import tsx tools/systems/generate-authoring.ts --check`.
- `pnpm authoring:generate`: `node --conditions=development --import tsx tools/systems/generate-authoring.ts --write`.
- `pnpm systems:check`: `node --conditions=development --import tsx tools/systems/scenarios.ts`.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Installed/public runtime authoring-execution contracts, authored operation/template records and explicit command inputs.

## Outputs

Operation preview is read-only; explicit application publishes only admitted outputs. Scenario and refusal effects use owned temporary repositories.

## Prerequisites

Source-aware Node/tsx; handlers import the public runtime authoring contract directly.

## Validation

Task ownership: `tools:test-systems`, `authoring:check`, `systems:check`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Runtime neutral helpers are not duplicated in tooling shims. Publication refuses escapes, aliases, unmanaged collisions and unsupported platform effects.

## Limits

This owner is a repository host, not a substitute for a consumer host authorization decision. Authoring generation is relocated in the generator milestone.

## Detailed behavior

Runs validate-ia, format-ia and render-template through fixed installed handlers. Native bindings, steward authority, input contracts and source freshness are checked. JSON requests return validation evidence or draft artifacts; --out uses the existing create-only publication primitive. No private factory or assessment operation is registered.
