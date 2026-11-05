# unicode tooling contract

## Purpose

Generate `apps/cli/src/console/width-table.ts`, the display-width tables the console's one width function (`apps/cli/src/console/width.ts`) reads, from pinned Unicode Character Database files, and prove the committed table equals its regeneration.

## Modules

- [generate-width-table.mjs](generate-width-table.mjs) — reads the sources, merges their ranges and writes or checks the table. It exports its pure `build(texts)` and `tables(texts)` so a test can run them.
- [16.0.0/](16.0.0/license.txt) — the three Unicode 16.0.0 source files, vendored unmodified at their paths under `https://www.unicode.org/Public/16.0.0/` (`ucd/EastAsianWidth.txt`, `ucd/emoji/emoji-data.txt`, `ucd/extracted/DerivedGeneralCategory.txt`), with the Unicode License v3 text beside them.

## Commands

No pnpm entry. Run the generator with Node:

- `node tools/unicode/generate-width-table.mjs` writes the table from the vendored sources.
- `node tools/unicode/generate-width-table.mjs --check` regenerates in memory and exits 1 when the committed table differs by one byte.
- `--from <dir>` reads the sources from another directory; `--download` first fetches them from `https://www.unicode.org/Public/16.0.0/` into the vendored directory, writing nothing unless every fetched file has its pinned byte count and SHA-256.

Exit 0 is success; exit 1 is a difference, a source whose byte count or SHA-256 is not the pinned one, or a table over 32 KiB.

## Inputs

The three source files under `16.0.0/` (or `--from`), each pinned in the script by byte count and SHA-256.

## Outputs

`apps/cli/src/console/width-table.ts` only, and only without `--check`. Its header names the Unicode version, each source's URL, byte count and SHA-256, each emitted set's range count and first and last code point, the file's own byte count and the license.

## Prerequisites

Node 22. No network, unless `--download` is given.

## Validation

`apps/cli/tests/console-width.test.ts` (task `cli:test-unit`) checks that `build()` over the vendored files is byte-identical to the committed table, that the header's hashes and sizes match the vendored files, that small excerpts under `apps/cli/tests/fixtures/unicode/` merge into the expected ranges, and that the entry point refuses a source that is not the pinned one.

## Invariants

The vendored files are never edited. The emitted sets are sorted, merged and non-overlapping. `tools/` is not in any npm package, so the vendored files are never shipped; the shipped table's notice is `apps/cli/THIRD_PARTY_NOTICES.txt`.

## Limits

Moving to another Unicode version means vendoring its files, updating the pinned sizes and hashes and the version constant, and regenerating; the width rules in `width.ts` are not version-specific, but terminals that implement an older version may draw a newer emoji narrow.
