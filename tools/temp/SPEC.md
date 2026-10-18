# temp tooling contract

## Purpose

Canonicalize temporary storage before callers allocate owned fixtures.

## Modules

- [canonical-temp.mjs](canonical-temp.mjs).
- [physical-temp.mjs](physical-temp.mjs).
- [physical-temp.test.ts](physical-temp.test.ts) — behavior and refusal coverage.

## Commands

No public pnpm entry; callers import the modules or use the manual contract below.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Operating-system temporary directory variables; canonical-temp also reads the GitHub runner environment-file path.

## Outputs

physical-temp changes only this process TMPDIR on POSIX. canonical-temp appends physical TEMP/TMP settings for subsequent runner steps.

## Prerequisites

Import physical-temp before allocation. canonical-temp requires an absolute GITHUB_ENV and a stable directory identity.

## Validation

Task ownership: `tools:test-temp`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Selection does not weaken downstream alias refusal. Only the allocating owner may delete its temporary directory.

## Limits

Physical path selection does not grant ownership of arbitrary existing files; failed canonicalization is left for the real operation to diagnose.

## Detailed behavior

`physical-temp.mjs` sets `TMPDIR` to the canonical path of the selected temporary directory whenever the two differ. Usually that is a link in the path: macOS reaches `/var/folders` through `/var`, and its `/tmp` fallback through `/tmp`, a link to `/private/tmp`. A non-canonical spelling of a real directory is rewritten too. Every Vitest configuration and the task runner (`tools/testing/run.ts`) import it before anything else. So does each entry point under `tools/` that creates temporary roots under `tmpdir()` and so do the plain-node scripts beside `apps/vscode`'s tests. `physical-temp.test.ts` parses those files and checks three things: the first import of every Vitest configuration a task runs; the first import of every script that makes a temporary root, recognized by its `tmpdir()` and `mkdtemp` calls (a root made with `mkdirSync` is not recognized); and, for the listed modules that are not entry points, that every script loading one is named with it and is listed too or imports the selector first. Their fixtures then sit under a path the toolchain's alias refusal accepts, and children inherit the variable. It relaxes no alias refusal. It changes nothing on Windows, where `TEMP` and `TMP` select the directory and `canonical-temp.mjs` covers the runners, and it leaves an unreadable `TMPDIR` for the operation that uses it to report.

The selector is its own Nx project, `tools-temp`, through the `tools:test-temp` task that owns `physical-temp.test.ts`, and it imports only Node built-ins. A project that imports it therefore hashes this project's owned files, and the two packages its test imports, `vitest` and `typescript`, which every other task hashes already; not the testing tools, their task manifest or their dependencies, as it would if the file lived in `tools/testing`. `nx.json` also lists it in `sharedGlobals`, beside the runner's own files, because the runner imports it for every task. Keep that entry although the file has an owning project: the graph reaches it only from projects that import it, and a task in any other project still runs it through the runner.
