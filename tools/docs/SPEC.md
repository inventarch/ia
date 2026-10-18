# docs tooling contract

## Purpose

Parse Markdown once and enforce documentation ownership, links, catalog identity and installed teaching-link policy.

## Modules

- [audit.test.ts](audit.test.ts) — behavior and refusal coverage.
- [audit.ts](audit.ts).
- [catalog.d.mts](catalog.d.mts) — interface declaration; implementation checking is tracked separately.
- [catalog.mjs](catalog.mjs).
- [check.ts](check.ts).
- [link-parity.test.ts](link-parity.test.ts) — behavior and refusal coverage.
- [markdown.d.mts](markdown.d.mts) — interface declaration; implementation checking is tracked separately.
- [markdown.mjs](markdown.mjs).
- [teaching-links.ts](teaching-links.ts).

## Commands

- `pnpm docs:structure`: `node tools/docs/catalog.mjs`.
- `pnpm docs:links`: `node tools/docs/catalog.mjs --links`.
- `pnpm docs:catalog`: `node tools/docs/catalog.mjs --write`.
- `pnpm docs:audit`: `pnpm docs:structure && pnpm docs:links && node --import tsx tools/docs/audit.ts`.
- `pnpm docs:check`: `node --import tsx tools/docs/check.ts`.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Tracked and nonignored files, docs/documentation.json, Markdown/frontmatter, source package manifests and selected installed teaching closure.

## Outputs

Audit/check/link commands read only. Catalog --write updates docs/catalog.json and applicable genre indexes after structural validation.

## Prerequisites

Pinned yaml/TypeScript dependencies for installed tools. No sibling repository, missing roadmap configuration or private portfolio registry is required.

## Validation

Task ownership: `tools:test-docs`, `docs:audit`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Owner Commands and Validation sections declare root pnpm script references. The audit accepts direct and explicit `run` forms with `--silent`/`-s` before the script and arbitrary trailing script arguments; leading directory/filter switches refuse because they change script ownership. Direct `exec`, `install` and `store` are pnpm subcommands; explicit `run` always requires a root script. Task ownership declarations resolve against the task manifest. These checks establish reference existence, not command behavior.

Duplicate identities, missing owner contracts, aliases, unsafe local links and stale generated catalogs refuse. catalog accepts no flag, --links or --write; duplicate/conflicting/unknown flags exit 2 before writes.

## Limits

Structural checks cannot establish prose accuracy. External links are classified without treating remote availability as source truth.
