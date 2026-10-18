---
id: spec-consumer-cli-contract
genre: spec
title: Consumer CLI contract
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-14"
owners: [inventarch]
---

# Consumer CLI contract

This contract describes the `ia` consumer shell: how it parses a command, which commands write, how it refuses and what it prints. The package [contract](../../../apps/cli/SPEC.md) records each command's detailed behavior. The [command table](../../../apps/cli/src/commands.ts), [parser](../../../apps/cli/src/args.ts) and [shell](../../../apps/cli/src/consumer.ts) are its executable owners.

## 1.2 Dispatch and discovery

The command table owns command names, arguments, options, help and handlers. Parsing runs before any workspace, cache or registry read. An unknown command is a usage error that names the nearest command, or `ia --help` when none is near; an unknown option names the command's `--help`. Operation help comes from the runtime's [machine protocol](../../../packages/runtime/src/machine-protocol.ts), so the supported operations and their input shapes have one owner. Workspace commands use the nearest ancestor that holds `.ia/src`; `--root` names another root where a command accepts it.

## 2 Commands and arguments

### 2.0 Grammar

Long options accept `--flag value` and `--flag=value`. Boolean options, an explicit `--`, repeatable options and repeated positionals follow each command's grammar. One-letter aliases such as `-y` and `-q` are exact tokens; a bundled form such as `-yq` is an unknown option. Closed value sets, integer bounds, conflicts and required arguments are checked before dispatch. Every parse refusal is `IA-CLI-USAGE` at exit 2.

### 2.1 Initialization

`init [directory]` previews. `--apply` installs the bundled language base, writes the three starter records and the release descriptor, and captures the workspace. The target is positional, so `--root` is refused. `--host claude` or `--host codex` also runs the host registration path, and `--host none` skips it. See [initialization](../workspace-initialization/README.md) and [apply](../workspace-initialization-apply/README.md).

### 2.2 Vocabulary and 2.3 formatting

`vocabulary` reads the word catalogue bundled with the CLI and opens no workspace, so `--root` is refused. `--schema` and `--example` require a word. `format` checks formatting by default and rewrites files only with `--write`.

### 2.4 Capture and 2.5 validation

`capture` admits the workspace and writes its snapshot to `.ia/work/snapshot/current.json` through the database service. `capture --preview` reports what it would write and writes nothing.

`ia compile` is removed. Every invocation returns `IA-CLI-USAGE` (exit 2) and names `ia capture --help` before it opens a workspace. It is absent from help and the catalog, and its token stays reserved so an extension cannot take it over. The published internal compile helpers keep their signatures for programmatic callers.

`validate` reports language and contract findings, then execution bindings and checks separately. A check with no bound evaluator is `not-evaluated`, never a pass. `validate` records the bound checks that passed or failed as evidence under `.ia/work/evidence/`, keyed to the authored revision it checked. A refused validation records and prunes nothing. `validate` never writes authored records.

### 2.6 Inspection and 2.7 packing

`inspect`, `read`, `position` and `next` are observations and write nothing. `read` returns the body behind a locator with its digest. A position packet is a navigable context surface, not a body.

`pack` requires `--descriptor`. A descriptor that names no `distribution`, which a default `init` writes, is refused as `IA-CLI-CONFLICT` (exit 3). An ordinary consumer workspace is therefore not publishable until it has a `@distribution`, which `init --system` authors.

### 2.8–2.11 Distribution changes

`install`, `update`, `remove` and `adopt` plan by default and apply only with `--apply`. `restore` has no preview and requires `--apply`. An apply rechecks the plan's inputs.

On a terminal without `--yes`, an apply shows the change summary and accepts only `y` or `yes`, in any case, ignoring surrounding space. Declining exits 0 and applies nothing. An apply without a terminal, or with `--json`, requires `--yes`.

After the installed set changes, registered host projections are refreshed. A refresh that fails after the install committed refuses at exit 3 and says that the installation is applied. `ia recover` repairs an interrupted installation or host transaction. See [registry](../registry/README.md).

### 2.12 Doctor

`doctor` reads state and returns `ok`, `info`, `warn`, `fail` or `unknown` rows, one status per row. A check that did not run is `unknown`. Doctor does not repair anything or start servers. See [host observations](../host-registration/README.md#7-doctor-and-support).

### 2.13 Preview and author

`preview` shows what one new record, one field change (`--set`) or one relationship (`--relate`) would compile to, with the findings it would add and the target file's current `sha256`. It writes nothing.

`author` takes the same arguments plus `--digest <sha256>`. It writes only when the target file still has that digest and the candidate is clean, and it adds one attribution comment naming the acting participant, its mandate and the authored revision. A changed file refuses as `IA-CLI-EDIT-STALE` and a candidate with errors as `IA-CLI-EDIT-UNCLEAN`, both at exit 1 and with nothing written.

`author` refuses the administrative words `workspace`, `agent`, `mandate`, `system`, `schema`, `agent-profile` and `hook` with `IA-CLI-EDIT-AUTHORITY`. An owner changes those records in source and runs `ia validate`.

### 2.14 Projection and host registration

`project <claude|codex>` plans, or with `--apply` writes, the position packet's files for one host and registers nothing. `host <claude|codex>` plans, or with `--apply` applies, the workspace's host registration. `host claude --user` installs a user-level plugin. All three plan by default. See [host registration](../host-registration/README.md) and [host plugin distribution](../host-plugin-distribution/README.md).

### 2.15 Mandate checks

These commands are judged against the acting participant's governing mandates before they run:

| Move | Commands |
| --- | --- |
| Observation | `read`, `next` |
| Verification | `validate`, `preview` |
| Synthesis | `author` |
| Execution | `capture`, `project` and a workspace `host --apply` |

A capture or project plan is judged as the effect it plans. No other command is judged, including `position`, `inspect`, `init`, `doctor`, the distribution commands, the machine protocol, and a `host` plan, `--remove` or `--user`. Each judged command takes `--actor <agent>` to name which authored participant is acting.

A refusal is `IA-RUNTIME-MANDATE-MOVE`, `IA-RUNTIME-MANDATE-WORD` or `IA-RUNTIME-MANDATE-ACTOR` at exit 1, and its next command is usually an `ia position` command for the mandates that govern there. `ia position` is never judged, so that command always runs. While an authored `@mandate` fails admission, including one stating `authority.moves []`, every judged command refuses with `IA-RUNTIME-REQUEST-INVALID` and names `ia report`, which shows the admission findings. A mandate is a cooperative restriction on these commands. It is not authentication or a sandbox, and it grants no host permission.

## 3 Exit classes and protocol boundaries

The consumer shell returns 0 for success, 1 for failed validation or a semantic refusal (a mandate refusal included), 2 for usage, 3 for state, I/O and conflict failures, and 130 for interruption.

The machine protocol keeps its own boundary. Each operation prints one JSON line on stdout with no color and nothing on stderr, exits 0, 1 or 2, and carries no consumer `next`. Consumer formatting and flags never leak into it. The `ia-distribution` binary keeps its own protocol too, and never exits 2. [Protocol tests](../../../apps/cli/tests/protocols.test.ts) exercise the built entrypoints.

## 4 Refusals

A refusal keeps the service's code, location and reason, and names one command to run next. It does not turn unknown or interrupted work into success. Effects that already completed are reported as completed.

## 5 JSON

`--json` prints one parseable value to stdout. Prompts and incidental process output never share stdout. A parse-time refusal reads no workspace or installation state.

## 6 Terminal rendering

Human output is rendered from structured tokens, with terminal capability and width handling. `--no-color` (or `NO_COLOR`), `--color`, `--ascii` and `--quiet` adjust it. Every command prints a terminal state line; progress output is optional. Severity and rendering limits do not change admission.

## 7 Knowledge commands

`ia kb check|search|read|resolve|traverse` opens an immutable, in-memory knowledge view. It reads authored records under `.ia/src` and their explicitly bound UTF-8 Markdown/text bodies. A selector at `.ia/knowledge.json` is optional for local reads. No `.kb`, persistent index or database is created.

`check` reports selected-record admission, reference closure and body availability. Workspace compliance checks are explicitly not evaluated by this scoped view; use native validation for the whole workspace. Missing references and excluded targets are unavailable without disclosing excluded identities or diagnostics. Local citations pin the snapshot and body and refuse after a change.

`ia kb pack --commit <full-sha> --selection <committed-path> --out <workspace-file>` previews a validated immutable package. `--apply` writes it; noninteractive and JSON apply require `--yes`. The output must have existing, unlinked parents within the repository and be outside `.ia`, `.git`, selected inputs and the selector. Identical existing bytes return unchanged; different bytes refuse. Current authority and native revision are checked again after interactive confirmation.

Read operations require Observation; check and pack preview require Verification; pack apply requires Execution. Nested parsing drives both enforcement and retry advice, including explicit `--actor`. The nine existing machine routes retain their protocol. Knowledge JSON uses `{version:1,ok,value}` or `{version:1,ok:false,error:{code,message}}`; existing CLI grammar, workspace and mandate refusals retain their established envelope and exit class.

The public [KB library](../../../packages/kb/README.md) owns selection, packaging and citations. The application host owns audiences, storage, lifecycle and approval.

## 8 Qualification

[CLI tests](../../../apps/cli/tests) cover parsing, JSON envelopes, exit classes and command outcomes. Installed-consumer checks also exercise the packed binaries. Neither establishes that a host loaded or activated anything.
