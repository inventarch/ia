# shared tooling contract

## Purpose

Provide checked built-in-only argument, bounded Git and stable-version mechanisms with multiple real callers.

## Modules

- [args.mjs](args.mjs).
- [contracts.test.ts](contracts.test.ts) — behavior and refusal coverage.
- [git.mjs](git.mjs).
- [semver.mjs](semver.mjs).

## Commands

No public pnpm entry; callers import the modules or use the manual contract below.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Explicit argv/contracts, repository root/Git arguments, and stable numeric version strings.

## Outputs

Parsing/version functions are pure. Git effects are exactly the subcommand the caller requests; timeout defaults to 60 seconds and output is bounded to 16 MiB.

## Prerequisites

Node built-ins only. Type checks use the pinned workspace TypeScript installation.

## Validation

Task ownership: `tools:test-shared`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Unknown, repeated, missing and conflicting options refuse before effects. Git uses argv arrays, never a constructed shell command. No package production module imports shared tooling.

## Limits

Owner policy, archive trust, installation and fixtures are not generic helpers. Prerelease versions are outside the stable-version contract.

## Detailed behavior

This owner contains built-in-only mechanisms used by more than one tooling owner. It does not decide release policy, install consumers, read package production code or import a test runner. Callers own their repository root and effects.

| Module | Contract and callers |
| --- | --- |
| `args.mjs` | `parseOptions` accepts named string/boolean options, required options and mutually exclusive groups. It refuses unknown, repeated, missing, conflicting and positional argv before effects. Testing's runner and orchestrator use it. |
| `git.mjs` | `gitText` invokes Git with an argument array, a finite positive timeout (60 seconds by default), a 16 MiB output limit and trimmed UTF-8 output. Release notes, changes and versioning use it. Callers distinguish expected Git failures from refusal. |
| `semver.mjs` | `stableVersion` and `compareVersions` preserve stable three-part numeric package-version semantics. Release notes and changes use them; prerelease/tag syntax is refused. |
| `contracts.test.ts` | Exercises parser refusals, bounded Git and paths containing spaces, launcher safety, no-install closure and a deliberately ill-typed JavaScript implementation. |

There are no public CLI entries or generated source outputs. `pnpm tools:typecheck-js` checks these implementations and the entry helpers through `tsconfig.tools-js.json`; sibling declarations do not mask them. `tools:test-shared` owns behavior tests on Linux, Windows and macOS. The tooling input profile hashes these sources; shared runtime/config coordinates remain in Nx's shared globals.

A helper enters this owner only with two real consumers. Owner-specific manifest schemas, artifact trust, fixture allocation and compatibility policy stay with their owners. JSON formatting, path checks and check/write reporting are not generalized until their semantics and callers justify a shared contract. Git child commands may themselves launch subprocesses; test process trees with cancellation belong to testing's subprocess owner.
