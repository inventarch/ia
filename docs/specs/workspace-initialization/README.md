---
id: spec-workspace-initialization
genre: spec
title: Workspace initialization
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-18"
owners: [inventarch]
---

# Workspace initialization

`ia init` creates an ordinary consumer workspace over the language base the CLI bundles. [init.ts](../../../apps/cli/src/init.ts) implements it. The [apply contract](../workspace-initialization-apply/README.md) fixes the order of its steps, its recovery, its plan JSON and how the bundled base artifact is built. The [CLI specification](../../../apps/cli/SPEC.md) gives the remaining migration detail.

## 1 Purpose

Create a workspace that admits with zero errors and holds only what its owner needs: an installed language base, three authored starter records and a release descriptor. Explicit initialization options retain the plan/apply contract: without `--apply` they print a plan and write nothing. `--apply` creates the workspace. Without a terminal, or with `--json`, it also needs `--yes`; otherwise it refuses with `IA-CLI-USAGE` (exit 2) and writes nothing.

### Guided agent setup

On an interactive terminal outside CI, plain `ia init [directory]` asks the user to choose Codex, Claude Code or CLI only. An empty answer or EOF cancels. After selection it shows one summary and asks for confirmation before writing or downloading. Explicit `--host`, `--apply`, `--yes`, migration, plugin lowering, adoption and decline options retain their existing behavior. `--setup --host <codex|claude|none>` is the explicit, resumable plan/apply form; JSON and noninteractive setup require the host choice as a flag. Setup does not combine with lowering, migration, adoption or `--system`.

The implementation in [setup.ts](../../../apps/cli/src/setup.ts) composes ordinary commands: initialize the base with no host; install `@inventarch/public-kits`; populate missing method bindings from the three public kits' declared recommendations; write the chosen host's portable bootstrap through `ia host --commit`; validate. The public package is acquired through the existing npm transport, integrity checks and installation lock. A retry uses its recorded version. It installs no host plugin and needs no account.

Existing instruction text and unrelated MCP configuration are preserved by the bootstrap writer. Conflicting MCP ownership is checked before initialization when the target directory exists. Existing exact, wildcard and default method choices are preserved; ambiguous bindings refuse. Every public kit must be present, and its recommended capabilities must exist. The work, knowledge and delivery lanes must all have bindings. New bindings are written atomically after the effect mandate check; a changed bindings file refuses rather than overwriting the observed version.

Setup resolves a representative work, knowledge and delivery method through the runtime from the installed releases and requires each to supply instructions. An unavailable preserved choice refuses rather than being replaced. A failure reports the failed step and completed steps and names the same setup command to resume. It leaves completed work in place. A successful report establishes local configuration and validation, not that the agent has loaded it: the user opens or restarts the agent and accepts the host's own repository trust and MCP prompts. CLI-only selection skips workflows, bindings and host discovery and retains offline initialization.

## 2 Inputs

- **Target.** `<directory>` is positional and defaults to the current directory; `--root` is refused. The directory need not exist yet, but its parent must: `ia init` creates at most one new directory and refuses any other target with `IA-CLI-USAGE` (exit 2). A target that holds, is or lies inside the IA home is refused with `IA-DIST-PATH-UNSAFE` (exit 3) before anything is written, in the plan as well as the apply.
- **Package id.** `--id <provider/name>` sets the release id. The default is `local/<name>`, where `<name>` is the directory name in lowercase, with each run of characters other than `a-z`, `0-9` and `-` turned into `-` and no leading or trailing `-`. A name must start with a letter and hold at most 64 characters. A name that does not normalize, is too long or is the name of a public system is a conflict that asks for `--id`; the CLI never invents one. An `--id` that is not `<provider/name>` is a usage error (exit 2). The name part names the starter records.
- **Host.** `--host claude|codex|none` selects host registration after initialization. The default is `none`.
- **Local system.** `--system` adds a local system and its distribution (§4).
- **Adoption.** `--adopt <id>[@version]`, with an optional `--registry`, mounts a source-only registry workspace (§4).
- **Plugin.** `--from <plugin-directory>` lowers a Claude Code, Codex or Grok plugin into the new workspace as a kit, in place of `--system` (§4). It takes `--id`; `--system`, `--migrate`, `--adopt` and the decline options are usage errors with it. A plugin directory that is missing or unreadable refuses with `IA-PLUGIN-INPUT`, and a construct that cannot be lowered refuses with `IA-LOWER-UNRESOLVED`; both exit 1 and write nothing. The [host plugin distribution contract](../host-plugin-distribution/README.md) defines the lowering.
- **Provenance.** The descriptor's `source` comes from Git: the `HEAD` commit and an HTTPS remote (`origin`, else the first remote). Without Git, a checkout, a commit or an HTTPS remote, `source.repository` and `source.commit` stay null, with `recipe` `ustar-v1` and `epoch` 0, and the plan says which fact was missing. Otherwise `epoch` is the commit's time. An SSH remote is never rewritten into an HTTPS one, and a URL that carries credentials is never copied.
- **Decline.** `--decline today|forever` records in the IA home that this repository should not be offered initialization, and `--forget-decline` removes that record. Neither writes the repository, and a later `ia init --apply` clears the decline.

## 3 Bundled language

The published `@inventarch/cli` package carries `assets/base.json`, a pin of `{id, version, archive, manifest}`, and exactly the one archive it pins, `assets/base/<archive digest>.ia.tgz`, so an installed CLI initializes offline. The pin is the only authority for those bytes: `ia init` verifies the archive against it and refuses, writing nothing, when they disagree.

[language-base.ts](../../../tools/native/language-base.ts) builds both from the floor, the public system contracts and schemas, and the language distribution root that [the public manifest](../../../examples/public-language/manifest.json) selects. Example records are excluded. The package is `inventarch/language`, which supplies the eleven public systems. Its artifact version is set in [versions.json](../../../examples/public-language/versions.json); within an npm major, native versions are chosen by content, so it need not equal the CLI version. Syntax, format and engine requirements are unchanged: 3.x artifacts still use the `.ia` syntax version `1.0`.

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

`--from` writes the three starter records, then the kit the plugin lowers to: its `@system`, its steward, `records/plugin.ia` and its resources under `.ia/src/systems/<name>/`. Init also writes `.ia/authoring.resources.json`, and writes the plugin's other files as assets under `assets/` at the workspace root, which the descriptor lists.

## 5 Persistent state

| Path | Holds |
| --- | --- |
| `.ia/src/workspace.ia` | The starter records (§4) |
| `.ia/release.json` | The release descriptor: `formatVersion` 1, the id, version `0.1.0`, `distribution` (with `--system` or `--from` only), the distribution engine range, syntax `1.0`, one dependency on the base at a caret range of its version with the systems it carries, `assets` (empty unless `--from`), license `UNLICENSED`, a description and the provenance (§2) |
| `.ia/distributions.lock.json` | The base as the one direct request, pinned by version, archive digest and manifest digest, under distribution engine `0.1.1` |
| `.ia/distributions/` | Install state, the cached archive and generations |
| `.ia/.gitignore` | `work/` and `distributions/`; written only where no ignore file exists |
| `.ia/work/snapshot/current.json` | The capture the init's capture effect writes |
| `.ia/authoring.resources.json`, `assets/` | The kit's authoring resources and the plugin's other files; with `--from` only |

The descriptor, the lock and `.ia/src/` stay in version control; a clone rebuilds `.ia/distributions/` with `ia restore`. An older CLI that reads only distribution engine `0.1.0` refuses a workspace whose lock this CLI wrote. `--adopt` adds `.ia/workspace.json` and the mount under `.ia/open/`. A selected host adds its registration as a separate effect: the MCP entry, the projection files and a receipt under `.ia/distributions/hosts/`, as [host registration](../host-registration/README.md) describes.

## 6 Migration

`ia init --migrate` rewrites a workspace that IA 1.0 or 1.1 initialized (the 1.1.0 starter) into the §4 starter. It takes `--system`, `--apply`, `--json` and `--yes`; `--id`, `--host`, `--adopt`, `--from` and the decline options are usage errors with it (exit 2). One preflight runs before anything is written. Any other shape, or a workspace that does not admit, refuses with `IA-CLI-CONFLICT` (exit 3), in the plan as well. Edited starter text (a changed `composition.systems` list is accepted), a destination or record identity that would collide, a kept record that refers to a local identity the migration deletes, and a 1.x base in a lock that holds anything else are conflicts that the plan lists and `--apply` refuses.

The apply keeps the descriptor id and every retained record identity. It installs the bundled base in place of an installed 1.x base, moves each retained source file byte for byte to `.ia/src/`, authors the three starter records, and deletes the local system unless `--system` keeps it as a packable system. It rewrites `.ia/release.json` with the bundled base's dependency row in place of the installed base's and keeps every other row, except that it drops `distribution` unless `--system` keeps it; without `--system`, `ia pack` then refuses until a distribution is authored. It then captures the workspace and refreshes each registered host projection. Migration is not a general corpus rewrite.

## 7 Acceptance

[Initialization tests](../../../apps/cli/tests/init.test.ts) cover the starter shape, admission, provenance, id normalization, repeat execution, conflicts, and the offline restore of the exact bundled base into a clone whose cache is empty. [Migration tests](../../../apps/cli/tests/init-migrate.test.ts) cover identity preservation, collisions and recovery. [Decline tests](../../../apps/cli/tests/decline.test.ts) and [adoption tests](../../../apps/cli/tests/adopt.test.ts) cover `--decline` and `--adopt`. A passing local run does not establish registry publication.
