# shared tooling contract

## Purpose

Provide checked built-in-only arguments, bounded Git, stable versions, contained paths and idempotent output writing with multiple real callers.

## Modules

- [args.mjs](args.mjs) — strict named options and explicit, mutually exclusive check/write modes.
- [args.d.mts](args.d.mts) — generated from the checked implementation for package test consumers.
- [paths.mjs](paths.mjs) — bounded regular-file reads and contained, alias-free paths.
- [paths.d.mts](paths.d.mts) — generated from the checked implementation for package test consumers.
- [written-names.mjs](written-names.mjs) — the one switch for the names the repository tools write into shared documents.
- [written-names.d.mts](written-names.d.mts) — typed declaration of that switch for package test consumers.
- [check-write.mjs](check-write.mjs) — validates all output paths before atomic idempotent writes.
- [contracts.test.ts](contracts.test.ts) — behavior and refusal coverage.
- [git.mjs](git.mjs).
- [semver.mjs](semver.mjs).
- [qualification-path.mjs](qualification-path.mjs) — built-in-only pointer shared by distribution consumers and test orchestration.

## Commands

No public pnpm entry; callers import the modules or use the manual contract below.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Explicit argv/contracts, repository root/Git arguments, stable numeric version strings, portable relative paths and complete generated text maps.

## Outputs

Parsing/version functions are pure. Git effects are exactly the requested subcommand; timeout defaults to 60 seconds and output is bounded to 16 MiB. Path validation and bounded regular-file reads never write. Explicit check/write validates every output first, replaces changed files atomically and preserves unchanged timestamps. Later I/O failure may leave earlier validated replacements; this is not a multi-file transaction.

## Prerequisites

Node built-ins only. Type checks use the pinned workspace TypeScript installation.

## Validation

Task ownership: `tools:test-shared`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Unknown, repeated, missing and conflicting options refuse before effects. Git uses argv arrays, never a constructed shell command. No package production module imports shared tooling.

## Limits

Owner policy, archive trust, installation and fixtures are not generic helpers. Prerelease versions are outside the stable-version contract.

## Detailed behavior

This owner contains built-in-only mechanisms with multiple concrete callers. It does not decide release policy, install consumers, read package production code or import a test runner. Callers own their repository root and effects.

| Module | Contract and callers |
| --- | --- |
| `args.mjs` | `parseOptions` accepts named string/boolean options, required options and mutually exclusive groups. It refuses unknown, repeated, missing, conflicting and positional argv before effects. Explicit empty strings require a named allowance, such as absent CI commit coordinates; missing argv items always refuse. Testing's runner and orchestrator use it. |
| `git.mjs` | `gitText` invokes Git with an argument array, a finite positive timeout (60 seconds by default), a 16 MiB output limit and trimmed UTF-8 output. Release notes, changes and versioning use it. Callers distinguish expected Git failures from refusal. |
| `semver.mjs` | `stableVersion` and `compareVersions` preserve stable three-part numeric package-version semantics. Release notes and changes use them; prerelease/tag syntax is refused. |
| `paths.mjs` | Rejects traversal, aliases, hardlinks and nonportable names; reads stable regular-file descriptors up to explicit byte ceilings, rechecking identity, size, link count, modification time and change time. Authoring and output writing share these guards. |
| `check-write.mjs` | Validates complete output maps in check and write modes; public/standalone authoring and declaration generation share it. Reports changed/written paths and limits each text output to 32 MiB. |
| `contracts.test.ts` | Exercises parser refusals, bounded Git and paths containing spaces, launcher safety, no-install closure and a deliberately ill-typed JavaScript implementation. |

There are no public CLI entries. Output destinations belong to caller maps. `pnpm tools:typecheck-js` checks these implementations and the entry helpers through `tsconfig.tools-js.json`; sibling declarations do not mask them. `tools:test-shared` owns behavior tests on Linux, Windows and macOS. The tooling input profile hashes these sources; shared runtime/config coordinates remain in Nx's shared globals.

A helper enters this owner only with two real consumers (call sites may share a tooling owner). Git serves release-branch and release-notes; semver serves release-notes and release-changes. Owner-specific manifest schemas, artifact trust, fixture allocation and compatibility policy stay with their owners. JSON schema policy stays with its owner; path/check-write guards serve both authoring generators and entry declarations. Git child commands may themselves launch subprocesses; test process trees with cancellation belong to testing's subprocess owner.

Containment refuses aliased roots, including a platform temporary-directory alias; callers canonicalize their owned root before calling. The release extraction helpers remain separate because they admit directory targets and missing ancestors and enforce separation between source and output trees; `containedFile` instead requires a portable relative regular-file path. These contracts are not interchangeable.
