# Contributing to IA

Thank you for considering a contribution. This document explains how the repository is organised, what a change must satisfy before it merges, and the terms that apply to what you contribute.

## Before you start

- For a bug, a question or a proposal, open an issue first using the templates. Small, obvious fixes can go straight to a pull request.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.
- Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Prerequisites

The declared support target is Linux x64, Windows x64 and macOS arm64, on Node.js `>=22.22.0 <23`, with the pnpm version pinned in `packageManager` in [package.json](package.json) for contributors. `ia doctor` reports whether your machine matches that target.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`pnpm platform:qualify` runs the full qualification gate that continuous integration runs. The [README](README.md#-contributing-and-verification) lists what each command checks.

## How the repository is organised

- [SPEC.md](SPEC.md) is the repository contract. Every package, app, tool directory and native system has its own colocated `SPEC.md`, and `pnpm docs:audit` fails when a file has no owning contract. Read the nearest contract before changing behaviour, and update it in the same change.
- Native records live under `.ia/src/`. The language reference is [docs/reference/language/README.md](docs/reference/language/README.md) and the vocabulary catalogue is [vocabulary.md](docs/reference/language/vocabulary.md). Choose the word before writing the record, satisfy its canonical schema, and run `ia validate`.
- Several files are generated from records and must not be edited by hand: the vocabulary pages, `.ia/authoring.resources.json`, `CLAUDE.md` and the agent files under `.claude/`. Edit the source record, then run `pnpm vocabulary:generate`, `pnpm authoring:generate` or `pnpm projections:generate`. The matching `*:check` commands fail on drift.
- Markdown shipped from `.ia/src/` is installed into consumer workspaces. A relative link from one of those files must point inside `.ia/src/`; a link to anything else must be an absolute URL. `pnpm authoring:check` enforces this.
- If you work in this checkout with Claude Code and the IA plugin registered, the steward guard refuses direct edits to records under `.ia/src/systems/<name>/` unless they come from that system's steward subagent. That is intended; use the steward.

## Tests

Every test file must be assigned to a task in [tools/testing/tasks.json](tools/testing/tasks.json). `pnpm tests:inventory` fails on an unassigned file, so add the assignment in the same change as the test. The task manifest contract is [tools/testing/SPEC.md](tools/testing/SPEC.md).

Tests run per package with `pnpm --filter <package> test`, and the repository tooling tests run with `vitest run --config vitest.tools.config.mts`.

## Release notes

Public npm packages are released together by automation; see the [publishing guide](tools/distribution/NPM-PUBLISHING.md). A pull request never edits package versions, `releases/current.json`, `releases/changesets/` or `CHANGELOG.md` by hand.

- If your change touches a public package, add a release note: `pnpm release:note --bump patch|minor|major --title "…" --summary "…"`. It drafts `releases/pending/<id>.json` from your branch diff. Write the summary for package consumers. Use `--bump none` for a package change consumers cannot observe, such as tests; it does not start a release. Changes outside package directories, such as tooling, workflows and repository docs, need no note.
- `pnpm release:check` runs in CI and names any changed package that still needs a note.

## Pull requests

1. Branch from `main` and keep the change focused on one concern.
2. Run the checks that cover what you changed, and `pnpm platform:qualify` before requesting review when the change is more than documentation. Add a release note when a public package changed.
3. Fill in the pull request template. Name the checks you ran and the platform you ran them on. A claim that something passes must be backed by a run you did.
4. The `main` branch ruleset in [.github/rulesets/main.json](.github/rulesets/main.json) requires the **Emitted platform (ubuntu-latest)** check from the [Public quality](.github/workflows/platform-quality.yml) workflow to pass and every review thread to be resolved before merging.
5. Match the existing commit style: a short type prefix and summary, for example `feat: release ia 1.0.0`.

Pull requests from forks run the public workflow without any privileged cache or service access.

## Licence of contributions

This repository is licensed under [Apache-2.0](LICENSE). Under section 5 of that licence, any contribution you intentionally submit for inclusion is licensed under Apache-2.0, without additional terms, unless you explicitly state otherwise. There is currently no separate contributor licence agreement or developer certificate of origin. Section 6 of the licence grants no trademark permission; the InventArch name and marks remain with their owner.

Keep [NOTICE](NOTICE) and the package-local licence files intact, and add third-party attribution where you introduce third-party material.
