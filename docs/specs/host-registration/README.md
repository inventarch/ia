---
id: spec-host-registration
genre: spec
title: Host registration
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-18"
owners: [inventarch]
---

# Host registration

This contract describes how `ia host` registers a workspace with an agent host and how `ia doctor` reports the result. The [host handler](../../../apps/cli/src/host.ts) plans and applies through the distribution services, and [host-projection.ts](../../../apps/cli/src/host-projection.ts) is the only writer of projection files. Supported hosts come from [hosts.ts](../../../apps/distribution/src/hosts.ts): `claude` and `codex` take a workspace registration, and `ia host cursor` refuses with `IA-DIST-HOST-UNSUPPORTED` and writes nothing. The user-level Claude plugin is described in [host plugin distribution](../host-plugin-distribution/README.md).

Section numbers are stable because source comments cite them; retired sections keep their numbers unused.

## 3 Payload and ownership

The CLI carries a generated host payload: a release identity, an inventory of its packages with byte digests, the runtime closure, a launcher and an installed-implementation catalog. `ia host --apply` materializes the payload in the IA home and verifies it. The MCP entry and each hook group run the payload's launcher with the Node that ran the apply, by absolute path. If that Node is removed, `ia doctor` reports the registration stale, and `ia host <host> --apply` records the running one.

When every element is applied, the registration records a join: the catalog of the payload it names, at the workspace's authored revision. `ia validate` reports each `@execution-binding` against that catalog as `bound`, `unavailable` or `revoked`, and `ia doctor` reports the catalog and the join. Neither registry content nor an authored binding loads or runs code.

### 3.2 Bundling

[host-payload.mjs](../../../tools/distribution/host-payload.mjs) follows the dependency closure of the public CLI, distribution, MCP server and edit-guard packages and of the implementation handlers the payload ships. It strips `development` export conditions, refuses a manifest or module that reaches an omitted capability, and refuses a runtime closure over 256 MiB. The public manifests must already describe the complete payload; apart from dropping development exports, the bundler does not change what they declare.

## 4 Commands

| Command | What it does |
| --- | --- |
| `ia host <claude\|codex>` | Plans the workspace registration. Nothing is written, the payload included. |
| `ia host <claude\|codex> --apply` | Materializes the payload, then applies the MCP entry and the projection, in that order. |
| `ia host <claude\|codex> --remove` | Plans removal of the owned host set; with `--apply` it removes it in reverse order. |
| `ia init --host <claude\|codex>` | Runs the same `--apply` path once the workspace is initialized. |
| `ia project <claude\|codex>` | Plans, or with `--apply` writes, the projection files alone, with no MCP entry and no hook registration of its own. Once `ia host` has registered, it keeps the registered groups in step with the authored `@hook` records, adding and removing groups against the payload that registration recorded; without a registration it lists every `@hook` as not taken. |

`ia host` and `ia project` need an initialized workspace with zero error findings. Without `.ia/release.json` they refuse with `IA-CLI-CONFLICT` and name `ia init`; a workspace that does not admit refuses with `IA-CLI-CONFLICT` and names `ia validate`. Both exit 3. `--remove` reads no record, so it still runs on a workspace that does not admit.

The plan lists three elements:

| Element | Claude | Codex |
| --- | --- | --- |
| `mcp` | `.mcp.json` | `.codex/config.toml` |
| `context` | not selected | unsupported by host |
| `projection` | the packet `.claude/rules/ia-workspace.md` and the `ia-authoring` skill; an agent per authored `@agent-profile` under `.claude/agents/`; a skill per authored `@playbook` under `.claude/skills/`; one `PreToolUse` group in `.claude/settings.local.json` per authored `@hook` for `PreToolUse` on `Write`, `Edit` or `MultiEdit` with at least one path and a message, registered by `ia host` only | the packet `AGENTS.md` and the `ia-authoring` skill under `.agents/skills/`; a skill per authored `@playbook`; each `@agent-profile` and `@hook` listed as not taken, with the reason |

On Claude, a record the host cannot take is listed as not taken, with the reason, and blocks nothing else. That covers a `@hook` outside those rules or past the 64th, every `@hook` while `disableAllHooks` is true in `.claude/settings.local.json` or `.claude/settings.json`, and an `@agent-profile` whose capabilities allow no host tool or whose name is not a portable file name.

The `context` element is not available in this release: `--context <identity>` refuses with `IA-DIST-HOST-UNSUPPORTED` for Claude and is a usage error for Codex.

Each hook group decides the `Write`, `Edit` and `MultiEdit` edits its `@hook` selects. It first refuses an edit to a file IA manages, such as the projection files and `.ia/distributions/`, with `IA-HOOK-PROJECTION-MANAGED`, whatever the hook's paths. A subagent acts as the `composition.agent` of the authored `@agent-profile` its `agent_type` names; a subagent no profile names is refused at every selected path with `IA-HOOK-IDENTITY-UNAVAILABLE`, governed or not. For any other actor, a selected edit no `@mandate` governs is allowed, and a governed one is refused with `IA-HOOK-NOT-MANDATED` unless a governing mandate grants the acting agent Synthesis there. Mandates that cannot be read refuse the selected edit with `IA-HOOK-MANDATE-UNAVAILABLE`. `ia host` registers no per-system steward guard; applying the projection retires one that an earlier release registered.

A workspace `host --apply` writes the projection, so it is judged as Execution against the acting participant's mandates and takes `--actor <agent>`, as `ia project` does. The plan, `--remove` and `--user` are not judged.

After `install`, `update`, `remove` or `adopt` changes the workspace, each projection the workspace owns, including one `ia project` wrote, is re-rendered; `restore` re-renders none, and the MCP entry is not touched. `--apply` refuses before it writes when an owned projection file was edited by hand. A refresh that fails after the change committed refuses at exit 3 and says the installation, or for `adopt` the adoption (`IA-CLI-ADOPTION-APPLIED`), is applied.

Every file these commands write is machine-local. Do not commit them; commit the bootstrap `ia host <host> --commit` writes instead: an instruction block that names `ia_session` and the lanes `ia:work`, `ia:knowledge` and `ia:delivery`, and an `ia` MCP server that runs `npx -y @inventarch/mcp-door@<this CLI's exact version>` from the project folder, with no machine-local path (host plugin distribution spec §4).

## 5 Plan safety

A plan records the owned paths, their current state and the expected payload. A file without the generated marker at a path the projection writes, or an owned file or hook group changed by hand, makes the element refused: the plan still exits 0 and names the file and its repair, and `--apply` refuses with the same code before it writes anything. A pending host journal refuses the plan itself and names its recovery. Applying plans again and rechecks its inputs. The IA home and the workspace may not contain each other, and an IA home that holds `src/` refuses, so it can never pass for a workspace root.

A file without the marker, or an owned file or group changed by hand, is `IA-DIST-LOCAL-MODIFICATION`. A pending journal is `IA-DIST-RECOVERY-REQUIRED`, and a held host lock is `IA-DIST-INSTALL-BUSY`; each names `ia recover host --root <directory>`. An unusable IA home is `IA-DIST-PATH-UNSAFE`, or `IA-DIST-INPUT-INVALID` when `IA_HOME` is relative. Each apply refusal exits 3.

## 6 Recovery

Host registration and installation keep journals. `ia recover host --root <directory>` (and `installation`, `guard` or `lifecycle`) repairs an interrupted transaction, and while a journal is pending, `ia host` and `ia project` refuse and name that recovery. A partially applied host action is never reported as registered. No cross-file atomicity is claimed; a rerun converges. Removal respects ownership and leaves foreign files in place.

Projection recovery also keeps unowned hook registrations and foreign generated files. A legacy or unowned guard is never adopted or deleted during a recovery; the refusal names the exact settings file and the safe removal or repair. A projection receipt is reused only when its render inputs, owned-file digests and removal evidence still match, so an interrupted apply cannot turn an external change into owned state.

## 7 Doctor and support

[Doctor](../../../apps/cli/src/doctor.ts) only observes and writes nothing. A matching registration is reported as written, not observed answering. A stale registration is `fail`, and doctor then exits 1.

Projection rows read the receipt the last apply wrote. A listed file that is missing is `warn` and one that changed is `fail`; records that now render a different packet are `warn` (outdated); with none of these, one `ok` row reports no drift. An owned hook group deleted or changed by hand is `fail`. A malformed state file is a `fail` row, never a crash. The `implementations` and `join-<host>` rows inspect pinned bytes without importing or running a handler. The receipt is `.ia/distributions/hosts/<host>-receipt.json`; without one the projection row is `unknown`. A pending host journal is a `fail` row naming its recovery, and a held host lock is `warn`. The `source-protection` row warns when an authored `@mandate` declares restrictions but no registered `@hook` covers `.ia/src/**` for `Write`, `Edit` and `MultiEdit`.

The declared target is Linux x64, Windows x64 and macOS arm64 on Node 22, from 22.22.0, as the package's `engines` field states. The `support-target` row compares the observed Node and platform with it. Matching the target is not qualification. A platform outside the declaration is a warning, and a check that cannot run stays `unknown`. Test evidence is platform-specific.

## 8–10 Qualification boundaries

[Host tests](../../../apps/cli/tests/host-registration.test.ts), [generated-set tests](../../../apps/cli/tests/host-generated.test.ts), [recovery tests](../../../apps/cli/tests/host-recovery.test.ts) and [doctor tests](../../../apps/cli/tests/host-doctor.test.ts) establish local write, read and refusal behavior. A written configuration does not prove that a fresh host session loaded it or invoked a handler.
