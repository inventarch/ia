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
- `--from <dir>` reads the sources from another directory.
- Any other argument refuses with exit 1 before anything is read. The generator never fetches: there is no network path, so nothing from the network reaches the disk through it.

Exit 0 is success; exit 1 is an unknown argument, a difference, a source whose byte count or SHA-256 is not the pinned one, or a table over 32 KiB.

## Inputs

The three source files under `16.0.0/` (or `--from`), each pinned in the script by byte count and SHA-256.

## Outputs

`apps/cli/src/console/width-table.ts` only, and only without `--check`. Its header names the Unicode version, each source's URL, byte count and SHA-256, each emitted set's range count and first and last code point, the file's own byte count and the license.

## Prerequisites

Node 22. No network.

## Validation

`apps/cli/tests/console-width.test.ts` (task `cli:test-unit`) checks that `build()` over the vendored files is byte-identical to the committed table, that the header's hashes and sizes match the vendored files, that small excerpts under `apps/cli/tests/fixtures/unicode/` merge into the expected ranges, and that the entry point refuses a source that is not the pinned one and any argument it does not know, `--download` among them.

## Invariants

The vendored files are never edited. The emitted sets are sorted, merged and non-overlapping. `tools/` is not in any npm package, so the vendored files are never shipped; the shipped table's notice is `apps/cli/THIRD_PARTY_NOTICES.txt`.

## Limits

Moving to another Unicode version means fetching its files by hand from `https://www.unicode.org/Public/<version>/` and vendoring them, updating the pinned sizes and hashes and the version constant, and regenerating; the width rules in `width.ts` are not version-specific, but terminals that implement an older version may draw a newer emoji narrow.
