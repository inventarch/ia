# @inventarch/distribution

[![npm](https://img.shields.io/npm/v/@inventarch/distribution?label=npm)](https://www.npmjs.com/package/@inventarch/distribution) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json)

> The distribution engine behind the `ia` CLI. It packs digest-named archives, installs them and registry kits into `.ia/distributions/`, adopts pinned source-only workspaces, restores and recovers installations, and registers Claude Code and Codex hosts. It also ships `ia-distribution`, a lower-level JSON interface to the same mechanisms.

## ⚡ Quick start

Most projects use this package through [`@inventarch/cli`](../cli/README.md), which depends on it. `ia install`, `adopt`, `update`, `remove` and `host` preview first and write only with `--apply`; `ia restore` needs `--apply` and has no preview yet:

```sh
ia install inventarch/language --offline   # preview from the local cache; writes nothing
ia restore --offline --apply --yes         # reinstall the locked generation from its pinned archives
ia recover --root .                        # finish or roll back an interrupted installation
```

The install preview compares the resolved set with the lock, lists the paths it would write (`.ia/distributions/store/…`, `.ia/distributions/generations/…`, `.ia/distributions.lock.json` and `.ia/distributions/active.json`) and states that authored sources under `.ia/src` are not touched.

To call the engine directly, install the package and pass an absolute root. Each command prints one JSON line:

```sh
npm install --global @inventarch/distribution
ia-distribution validate --root "$PWD"
```

`validate` reports `status`, the revision, the findings and the `bindings`, `checks` and `evidence` results. A relative `--root` is refused with `IA-DIST-INPUT-INVALID`.

## 🧭 What it does

| Area | Through `ia` | What the engine does |
| --- | --- | --- |
| Packing | `pack` | Builds a `<sha256>.ia.tgz` archive from a release descriptor that names a `@distribution`, with its pinned dependency closure. A descriptor that names none is refused. |
| Installation | `install`, `update`, `remove` | Resolves requests from a registry, a catalog file or the local cache, verifies archive integrity and native admission, and installs in one transaction that writes `.ia/distributions/` and the lock. |
| Kits | `install <id>` | Installs an id whose release index is empty as a kit: its members become ordinary distribution requests, and the lock pins them and their archives, so restore needs no kit metadata. |
| Source-only adoption | `adopt`, `init --adopt` | Pins a registry workspace's source files at `.ia/open/<binding-id>/<revision>`, records an `open` binding in `.ia/workspace.json` and adds `<tree>/.ia/src @open` to the authored `@workspace`'s `composition.sources`, where its records enter at band 50. |
| Restore | `restore` | Reinstalls the locked generation from its pinned archives, from a registry, a catalog or `--offline` from the cache. |
| Recovery | `recover [installation\|host\|guard\|lifecycle]` | Finishes or rolls back an interrupted installation, host registration, hook-group registration or lifecycle context-hook registration from its journal. |
| Host registration | `host`, `project` | Plans and applies the position packet and generated files at fixed Claude Code and Codex paths, one `PreToolUse` group per authored `@hook` in `.claude/settings.local.json` with its ownership state, and the installed-implementation catalog join `ia validate` binds against. Other hosts refuse with `IA-DIST-HOST-UNSUPPORTED`. |
| Registries | `--registry <url\|dir>` | Reads release, kit and workspace indexes from a credential-free HTTPS base or a local directory, with bounded reads and no redirects. |

The `ia-distribution` binary groups the same mechanisms, as `ia-distribution --help` lists them:

| Group | Commands |
| --- | --- |
| Workspace | `validate`, `format`, `render`, `project`, `explain`, `recover-projection`, `remove-projection` |
| Archives and installs | `pack`, `inspect`, `cache`, `list`, `doctor`, `plan install\|update\|remove\|rollback`, `apply`, `restore`, `recover`, `gc` |
| Hosts | `plan host\|host-remove\|lifecycle\|lifecycle-remove`, `recover-host`, `recover-guard`, `recover-lifecycle` |
| Registries and updates | `registry add\|withdraw`, `refresh-updates` |

A `plan` command returns reviewable data, saved with `--out`; `apply` rechecks every input and writes only install state. Recovery refusals and `ia doctor` remedies name `ia recover`, not `ia-distribution`, which installing the CLI does not put on your `PATH`. The library subpaths (`./pack`, `./install`, `./registry`, `./projection`, `./guard-registration`, `./implementations`, `./services` and the rest in `package.json`) expose the same mechanisms with TypeScript declarations.

## ⚖️ What it does not do

- **No publication.** `ia pack` writes a local archive (by default under `.ia/work/dist`), and installing or adopting publishes no release. Host activation and public publication are separate operations.
- **No code execution.** Reading the installed-implementation catalog never imports, loads or runs a handler, and [system-package verification](references/system-package.md) never imports package code or grants authority.
- **No authority from kits or adoption.** Kits confer no implementation catalog, registry override, credential or host permission. Adoption refuses source with `mandate`, `agent-profile`, `execution-binding`, `hook`, `capability` or `check` records, and copies no executable, host configuration, registry mapping or credential; author those records locally.
- **No automatic adoption crash recovery.** After a crash during `ia adopt --apply`, inspect the `@workspace` sources and the binding in `.ia/workspace.json` before removing a stale `.ia/adoption.lock`.
- **No proof a host is running.** A registration is written files; `ia doctor` reports it as written, not observed answering. Codex agents and hooks are unsupported.
- **No CLI upgrade.** Restore and recovery reinstate state; they never upgrade the running CLI, and no fallback rewrites a lock or lowers an archive's engine range.

## Distribution engine compatibility

The distribution engine has its own version, separate from the npm package and native archive versions. The 2.x CLI reads engine 0.1.0. IA 3.0 uses engine 0.1.1, which verifies pinned release-control sources outside system folders. IA 3.5 uses engine 0.1.2, which reads a lock's package entries: an npm package of kits that `ia install --package` records, whose kits it installs as ordinary releases (contract C7b).

- **Old locks.** IA 3.0 reads an exact 0.1.0 lock without rewriting its pins when the selected archives support the new engine. That is forward compatibility only.
- **What migrates a workspace.** An applied `ia init`, and every applied `ia install` or `ia update`, including one that changes nothing, writes an engine 0.1.1 lock, which the 2.x CLI refuses to read. `ia remove` keeps the existing engine marker, though its host refresh can still write newer host state.
- **Package entries.** A lock with an `entries` row declares `^0.1.2`. A lock without one is written and read exactly as 3.0 to 3.4 write and read it, under the 0.1.1 marker, and archives keep declaring `^0.1.1`, so a repository that records no package stays readable by every 3.x CLI. An engine from 0.1.2 on refuses a lock it cannot read with the `ia` release that reads it, such as "It needs ia >= 3.5.0"; a 3.4 or earlier CLI refuses a lock with entries as a contract error ("Unknown, missing or accessor field"), never ignoring the entry.
- **Refusals.** An incompatible lock is not corruption. IA 3.0 names the required and current engine: `IA-DB-SOURCE-UNAVAILABLE` with reason `engine-incompatible` for an installed lock or archive, and `IA-DIST-CONFLICT` for an installation plan. An older CLI may report a generic engine refusal.
- **Strict archives.** Never lower an archive's engine range, edit a lock's engine marker or delete a lock to silence a refusal.

Before upgrading, back up the authored source and the distribution and host state, including the lock and the exact cached archives, and note the CLI version that opens it. Validate the upgraded workspace with a compatible CLI. If its activation is missing, run that CLI's `ia restore` with the exact pinned archives.

To return to 2.x, use the newer CLI first: finish pending recovery (`ia recover guard --root .`, and `ia host <host> --apply` for pending projection evidence), then remove its host registrations (`ia host claude --remove --apply --yes`, and `ia host codex --remove --apply --yes` where registered). Restore the complete pre-upgrade backup and use the matching old CLI with the exact archive pins. Keep the upgraded workspace separately for later reconciliation. There is no in-place downgrade.

## 📚 Learn more

- [Package contract](SPEC.md) · [language summary](LANGUAGE.md)
- [Registry collections and source adoption](references/registry-collections.md) · [installed system-package verification](references/system-package.md)
- [Distribution registry](../../docs/specs/registry/README.md) and [host registration](../../docs/specs/host-registration/README.md) specifications
- [Root README](../../README.md) · [architecture reference](../../docs/reference/architecture/README.md) · [CLI guide](../cli/README.md)
- [`@inventarch/steward-hook`](../steward-hook/README.md), the edit guard whose hook groups this package registers
