# Contributing to IA

Thank you for considering a contribution. This document explains how the repository is organised, what a change must satisfy before it merges, and the terms that apply to what you contribute.

## Before you start

- For a bug, a question or a proposal, open an issue first using the templates. Small, obvious fixes can go straight to a pull request.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.
- Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Build from source

The declared support target is Linux x64, Windows x64 and macOS arm64, on Node.js `>=22.22.0 <23`, with the pnpm version pinned in `packageManager` in [package.json](package.json) (currently `12.9.0`). `ia doctor` reports whether your machine matches that target.

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/main.js --version
```

To use that build in another project, run `node /path/to/ia/apps/cli/dist/main.js` wherever the [guide](docs/guide/README.md) says `ia`.

## Checks

All commands below are root [package.json](package.json) scripts. Run focused checks while working; `pnpm platform:qualify` runs the full qualification gate that continuous integration runs.

| Command | What it checks |
| --- | --- |
| `pnpm build` | Bundled language base, kernel and public vocabulary checks, package builds and host payload |
| `pnpm test` | Builds first, then runs package and repository-tool test suites |
| `pnpm typecheck` | Package and tool TypeScript |
| `pnpm lint` / `pnpm format:check` | Biome lint and formatting checks |
| `pnpm docs:audit` | Documentation structure, link integrity and owner contract coverage |
| `pnpm platform:qualify` | Tests, types, static checks, native validation, documentation and emitted-resource qualification |

<details>
<summary>More checks: native records, generated files, installed packages and releases</summary>

| Command | What it checks |
| --- | --- |
| `pnpm native:check` | Native source closure and repository lints |
| `pnpm public-language:check` | Public schema and reference closure and harness compilation |
| `pnpm compliance:check` / `pnpm systems:check` | Compliance fixtures and local system scenarios |
| `pnpm dependencies:check` | Package dependency direction |
| `pnpm tests:inventory` | Test ownership and qualification task coverage |
| `pnpm docs:check --all` | Local link targets across tracked Markdown files |
| `pnpm vocabulary:check` / `pnpm vocabulary:generate` | Check or regenerate the vocabulary catalogue |
| `pnpm authoring:check` / `pnpm authoring:generate` | Check or regenerate authoring resources |
| `pnpm projections:check` / `pnpm projections:generate` | Check or regenerate `CLAUDE.md` (this repository's position packet) and the `ia-authoring` skills |
| `pnpm public:qualify` | Public records, guides and host artifacts, plus package qualification |
| `pnpm packages:qualify` | Package exports, installed CLI consumers and VSIX packaging |
| `pnpm resources:qualify` / `pnpm projections:qualify` | Emitted resource and projection behavior |
| `pnpm release:note` / `pnpm release:check` / `pnpm release:version` | Add a pending release note, check that changed packages have notes, and compute the next coordinated version |
| `pnpm npm:setup` | Report, and with `--apply` fix, the npm names, trusted publishers and GitHub settings publication needs |
| `pnpm npm:prepare` / `pnpm npm:consumer` / `pnpm npm:plan` | Prepare and check npm release archives; see the [publishing guide](tools/distribution/NPM-PUBLISHING.md) |

</details>

Tie every validation claim to the checks that ran and the environment they exercised.

## How the repository is organised

| Folder | Holds | Start at |
| --- | --- | --- |
| `packages/` | Compiler, graph, compliance, database, knowledge, runtimes and service contracts | [Package reference](docs/reference/packages/README.md) |
| `apps/` | CLI, MCP server, runner, edit-guard hook, distribution tooling and VS Code extension | [Architecture reference](docs/reference/architecture/README.md) |
| `.ia/src/floor/` | The closed language kernel: domains, predicate pairs and routing vocabulary | [Kernel README](.ia/src/floor/README.md) · [contract](.ia/src/floor/SPEC.md) |
| `.ia/src/systems/` | The eleven public vocabulary owners, their canonical schemas and system implementations | [Architecture reference](docs/reference/architecture/README.md#native-systems-and-executable-owners) |
| `docs/` | The user guide, the language, architecture and package references, and implemented specifications | [Documentation](docs/README.md) |
| `examples/` | Authoring examples, the walkthrough's finished records, and the public language corpus | [Examples](docs/guide/examples.md) |
| `distributions/` | The optional product-structure distribution | [Distribution README](distributions/product-structure/README.md) |
| `releases/`, `tools/` | Release inputs, and the build, generation, documentation and qualification tools | [Release process](releases/README.md) · [repository contract](SPEC.md) |

- [SPEC.md](SPEC.md) is the repository contract. Every package, app, tool directory and native system has its own colocated `SPEC.md`, and `pnpm docs:audit` fails when a file has no owning contract. Read the nearest contract before changing behaviour, and update it in the same change.
- Native records live under `.ia/src/`. The language reference is [docs/reference/language/README.md](docs/reference/language/README.md) and the vocabulary catalogue is [vocabulary.md](docs/reference/language/vocabulary.md). Choose the word before writing the record, satisfy its canonical schema, and run `ia validate`.
- Several files are generated from records and must not be edited by hand: the vocabulary pages, `.ia/authoring.resources.json`, `CLAUDE.md` (this repository's position packet) and the `ia-authoring` skills under `.claude/skills/` and `.agents/skills/`. No per-system steward agent is generated any more; `pnpm projections:generate` deletes only exact known 1.x steward files at their original paths under `.claude/agents/`; all other files remain for manual review. Edit the source record, then run `pnpm vocabulary:generate`, `pnpm authoring:generate` or `pnpm projections:generate`. The matching `*:check` commands fail on drift.
- Markdown shipped from `.ia/src/` is installed into consumer workspaces. A relative link from one of those files must point inside `.ia/src/`; a link to anything else must be an absolute URL. `pnpm authoring:check` enforces this.
- The legacy per-system steward guard is retired. The unreleased generation changes let Claude registration install owned groups for authored `@hook` records; those hooks enforce the governing `@mandate` over their selected paths. A source folder does not protect itself: declare and register a protective hook, and use `ia doctor` to check source protection. Have changes to a system's records reviewed by its steward. Host removal remains available when source admission fails; missing or damaged ownership state may require the specific manual repair named by its refusal.

## Tests

Every test file must be assigned to a task in [tools/testing/tasks.json](tools/testing/tasks.json). `pnpm tests:inventory` fails on an unassigned file, so add the assignment in the same change as the test. The task manifest contract is [tools/testing/SPEC.md](tools/testing/SPEC.md).

Tests run per package with `pnpm --filter <package> test`, and the repository tooling tests run with `vitest run --config vitest.tools.config.mts`.

## Release notes

Public npm packages are released together by automation; see the [publishing guide](tools/distribution/NPM-PUBLISHING.md). A pull request never edits package versions, `releases/current.json`, `releases/changesets/` or `CHANGELOG.md` by hand.

- If your change touches a public package, add a release note: `pnpm release:note --bump patch|minor|major --title "…" --summary "…"`. It drafts `releases/pending/<id>.json` from your branch diff. Write the summary for package consumers. Use `--bump none` for a package change consumers cannot observe, such as tests; it does not start a release. Changes outside package directories, such as tooling, workflows and repository docs, need no note.
- `pnpm release:check` runs in CI and names any changed package that still needs a note. Between a release's merge and its tag, it also refuses native version metadata the prepared release does not cover, including selections made by `pnpm native:version --write`; wait for the release tag, then update your branch from main, retarget native notes to the new tag, and regenerate native selections.

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

Tooling owners document their module map, command behavior, input/output contract, prerequisites and limits in each `tools/<owner>/SPEC.md`. `pnpm tools:typecheck-js` checks no-install JavaScript implementations; `pnpm tests:inventory` and the cold-start/cache suites verify declared execution contracts. Release setup is described in [SETUP.md](tools/distribution/SETUP.md); the release sequence is in [NPM-PUBLISHING.md](tools/distribution/NPM-PUBLISHING.md).
