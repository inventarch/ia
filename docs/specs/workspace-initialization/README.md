---
id: spec-workspace-initialization
genre: spec
title: Workspace initialization
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-14"
owners: [inventarch]
---

# Workspace initialization

`ia init` creates an ordinary consumer workspace over the language base the CLI bundles. [init.ts](../../../apps/cli/src/init.ts) implements it. The [apply contract](../workspace-initialization-apply/README.md) fixes the order of its steps and its recovery, and the [CLI specification](../../../apps/cli/SPEC.md) gives the full plan, JSON and migration detail.

## 1 Purpose

Create a workspace that admits with zero errors and holds only what its owner needs: an installed language base, three authored starter records and a release descriptor. Without `--apply`, `ia init` prints the plan and writes nothing. `--apply` creates the workspace; without a terminal to confirm it, it also needs `--yes`.

## 2 Inputs

- **Target.** `<directory>` is positional and defaults to the current directory; `--root` is refused. The directory need not exist yet. A target that holds, is or lies inside the IA home is refused before anything is written.
- **Package id.** `--id <provider/name>` sets the release id. The default is `local/<name>`, where `<name>` is the directory name in lowercase, with each run of characters other than `a-z`, `0-9` and `-` turned into `-` and no leading or trailing `-`. A name that does not normalize, is too long or is the name of a public system is a conflict that asks for `--id`; the CLI never invents one. The name part names the starter records.
- **Host.** `--host claude|codex|none` selects host registration after initialization. The default is `none`.
- **Local system.** `--system` adds a local system and its distribution (§4).
- **Adoption.** `--adopt <id>[@version]`, with an optional `--registry`, mounts a source-only registry workspace (§4).
- **Provenance.** The descriptor's `source` comes from Git: the `HEAD` commit and an HTTPS remote (`origin`, else the first remote). Without Git, a checkout, a commit or an HTTPS remote, it stays null and the plan says which fact was missing. An SSH remote is never rewritten into an HTTPS one, and a URL that carries credentials is never copied.
- **Decline.** `--decline today|forever` records in the IA home that this repository should not be offered initialization, and `--forget-decline` removes that record. Neither writes the repository, and a later `ia init --apply` clears the decline.

## 3 Bundled language

The published `@inventarch/cli` package carries `assets/base.json`, a pin of `{id, version, archive, manifest}`, and exactly the one archive it pins, `assets/base/<archive digest>.ia.tgz`, so an installed CLI initializes offline. The pin is the only authority for those bytes: `ia init` verifies the archive against it and refuses, writing nothing, when they disagree.

[language-base.ts](../../../tools/native/language-base.ts) builds both from the floor, the public system contracts and schemas, and the language distribution root that [the public manifest](../../../examples/public-language/manifest.json) selects. Example records are excluded. The package is `inventarch/language`, which supplies the eleven public systems. Its artifact version, in [versions.json](../../../examples/public-language/versions.json), aligns to the npm version at each breaking major and otherwise changes only with the archive's content. Syntax, format and engine requirements are unchanged: 3.x artifacts still use the `.ia` syntax version `1.0`.

## 4 Authored starter

The starter is three records in `.ia/src/workspace.ia`, at authored placement (band 100):

| Record | Holds |
| --- | --- |
| `@workspace <name>` | `composition.systems` naming every system the base installs, `composition.sources [".ia/src @authored"]` and `composition.steward @agent <name>` |
| `@agent <name>` | The participant: the IDE agent operating in this workspace, whatever its vendor |
| `@mandate <name>-mandate` | `authority.participant @agent <name>`, `authority.moves [Observation, Verification, Synthesis, Delegation, Execution]` and `authority.scope [@workspace <name>]` |

The default starter defines no local `@system` and no `@distribution`, so `ia pack` refuses until one is authored. The `@mandate` is a cooperative restriction that IA's mandate-checked commands apply. It claims no host permission, and it is not authentication or a sandbox.

`--system`, for a repository that will publish vocabulary of its own, also writes `.ia/src/systems/<name>/system.ia` (`@system <name>`, requiring `agent-system`, `work-system` and `workspace-system`, and its steward `@agent <name>-steward`) and `.ia/src/systems/<name>/records/distribution.ia` (`@distribution <name>-distribution`, rooted at `@system <name>`). The `@workspace` composes the local system after the base's systems, and the descriptor names the distribution, so `ia pack` releases the system folder.

`--adopt` adds the pinned mount's `.ia/open/<binding>/<revision>/.ia/src @open` entry to `composition.sources`; the mounted records enter at band 50. An adoption binding the target already holds is reflected in the starter without `--adopt`. The [registry collections contract](../../../apps/distribution/references/registry-collections.md) defines adoption.

## 5 Persistent state

| Path | Holds |
| --- | --- |
| `.ia/src/workspace.ia` | The starter records (§4) |
| `.ia/release.json` | The release descriptor: the id, version `0.1.0`, the distribution engine range, syntax `1.0`, one dependency on the base at a caret range of its version with the systems it carries, license `UNLICENSED` and the provenance (§2) |
| `.ia/distributions.lock.json` | The base as the one direct request, pinned by version, archive digest and manifest digest, under distribution engine `0.1.1` |
| `.ia/distributions/` | Install state, the cached archive and generations |
| `.ia/.gitignore` | `work/` and `distributions/`; written only where no ignore file exists |
| `.ia/work/snapshot/current.json` | The capture the init's capture effect writes |

The descriptor, the lock and `.ia/src/` stay in version control; a clone rebuilds `.ia/distributions/` with `ia restore`. An older CLI that reads only distribution engine `0.1.0` refuses a workspace whose lock this CLI wrote. `--adopt` adds `.ia/workspace.json` and the mount under `.ia/open/`. A selected host adds its projection as a separate effect.

## 6 Migration

`ia init --migrate` rewrites a workspace that IA 1.0 or 1.1 initialized (the 1.1.0 starter) into the §4 starter. It takes `--system`, `--apply`, `--json` and `--yes`; `--id`, `--host` and the decline options are usage errors with it. One preflight runs before anything is written. It refuses any other shape, edited starter text (a changed `composition.systems` list is accepted), a workspace that does not admit, a destination or record identity that would collide, a kept record that refers to a local identity the migration deletes, and a 1.x base in a lock that holds anything else.

The apply keeps the descriptor id and every retained record identity. It installs the bundled base in place of an installed 1.x base, moves each retained source file byte for byte to `.ia/src/`, authors the three starter records, and deletes the local system unless `--system` keeps it as a packable system. It then captures the workspace and refreshes each registered host projection. Migration is not a general corpus rewrite.

## 7 Acceptance

[Initialization tests](../../../apps/cli/tests/init.test.ts) cover the starter shape, admission, provenance, id normalization, repeat execution, conflicts, and the offline restore of the exact bundled base into a clone whose cache is empty. [Migration tests](../../../apps/cli/tests/init-migrate.test.ts) cover identity preservation, collisions and recovery. [Decline tests](../../../apps/cli/tests/decline.test.ts) and [adoption tests](../../../apps/cli/tests/adopt.test.ts) cover `--decline` and `--adopt`. A passing local run does not establish registry publication.
