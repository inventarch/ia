---
id: spec-consumer-cli-contract
genre: spec
title: Consumer CLI contract
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-18"
owners: [inventarch]
---

# Consumer CLI contract

This contract describes the `ia` consumer shell: how it parses a command, which commands write, how it refuses and what it prints. The package [contract](../../../apps/cli/SPEC.md) records each command's detailed behavior. The [command table](../../../apps/cli/src/commands.ts), [parser](../../../apps/cli/src/args.ts) and [shell](../../../apps/cli/src/consumer.ts) are its executable owners. Section numbers are stable because source comments cite them; retired sections keep their numbers unused.

## 1.2 Dispatch and discovery

The command table owns command names, arguments, options, help and handlers. Parsing runs before any workspace, cache or registry read, except the hand-off below, which reads only directories and `package.json` files. An unknown command is a usage error that names the nearest command, or `ia --help` when none is near; an unknown option names the command's `--help`. Operation help comes from the runtime's [machine protocol](../../../packages/runtime/src/machine-protocol.ts), so the supported operations and their input shapes have one owner. Workspace commands use the nearest ancestor that holds `.ia/src`; `--root` names another root where a command accepts it. When no ancestor holds `.ia/src`, or `--root` names no directory, the command refuses with `IA-DB-ROOT-INVALID` at exit 3. A directory whose `.ia` is the IA home is never a workspace. `ia <operation> --help` and `--schema` print help text at exit 0, `--version` prints the version, and the token `agent` is reserved: `ia agent` refuses as `IA-CLI-USAGE`.

Hand-off is the first step, before parsing, and reads only directories and `package.json` files, then asks git once whether the local copy is committed. A command typed into an `ia` runs on the `@inventarch/cli` the workspace pins and has installed whenever that copy is not the running one, older or newer, and that copy produces every byte of output and the exit code. The workspace is the first `--root` before `--`, at its real path as the command opens it, and without `--root`, the one discovery finds from the working directory; a `--root` without `.ia/src` means no hand-off. The pinning manifest is the nearest `package.json` at or above the workspace; when it lists `@inventarch/cli` in `dependencies` or `devDependencies`, the first `node_modules/@inventarch/cli` from the workspace up to the manifest's directory is the local copy. The running copy starts that copy's `bin` entry with the same Node, the same arguments and the same stdin, stdout and stderr, with `IA_HANDOFF_FROM` set to the real path of its own package root, and exits with its exit code, or 130 when it ended on a signal. While that copy runs, the running copy ignores `SIGINT`, `SIGTERM`, `SIGHUP` and, on Windows, `SIGBREAK`. A signal sent to the whole foreground group, such as a terminal's Ctrl-C, reaches the copy handed to as well, which acts on it, and the running copy exits only after it. A signal sent to the running copy alone is ignored and not forwarded; it exits when the copy handed to does. Any non-empty `IA_HANDOFF_FROM` means the running copy never hands off again. There is no hand-off for bare `ia`, for `--user` before `--`, for an extension's command token, for `doctor --host`, when `IA_NO_HANDOFF` is `1`, when an IA home variable is malformed (the running copy refuses it as before), without a workspace, a CLI dependency or a valid local copy, when the local copy is the running one by device and inode, or when git tracks any file of the local copy: a copy the repository commits is the repository's code, not one an install wrote, so a typed command never runs it (without git, or outside a repository, nothing is tracked). Hand-off reads the tokens without parsing them, so an option value spelled like `--user` or `--root` routes as that flag; the running copy then answers, or the `--root` it names decides. A local copy that is installed but cannot be started is reported on one stderr line, `ia: could not start this workspace's @inventarch/cli <version> (<reason>); running <own version> instead`, and the running copy answers; hand-off itself never writes to stdout. A local copy that starts and then fails while loading, as one an interrupted `npm ci` left behind can, ends the command with its own failure: that failure is the workspace copy's, and `IA_NO_HANDOFF=1` runs the typed `ia`'s own. In a workspace that hands off, `ia --version` and `ia --help` answer from the workspace's copy; `IA_NO_HANDOFF=1` gives the typed `ia`'s own. The handed-off copy runs with the workspace's trust: it is the code `npx ia` runs there, and the copy the `init` skill grounds on, the "repository's pinned `@inventarch/cli` when it is installed" ([host-plugin-distribution](../host-plugin-distribution/README.md) §6.1). In a checkout that is not trusted, `IA_NO_HANDOFF=1` is the opt-out: the `ia` that was typed answers. The session hook sets it (host-plugin-distribution §8.2), so the hook never hands off. `runCli` and `dispatch` never hand off; only the `ia` executable does. That is the package's `bin`, `dist/bin.js`, which decides before it loads any command module. `node dist/main.js`, the plugin hook's entry, runs that copy and never hands off.

## 2 Commands and arguments

### 2.0 Grammar

Long options accept `--flag value` and `--flag=value`. Boolean options, an explicit `--`, repeatable options and repeated positionals follow each command's grammar. One-letter aliases such as `-y` and `-q` are exact tokens; a bundled form such as `-yq` is an unknown option. Closed value sets, integer bounds, conflicts and required arguments are checked before dispatch. Every parse refusal is `IA-CLI-USAGE` at exit 2.

Every `--apply` (`init`, `adopt`, `install`, `update`, `remove`, `restore`, `project` and `host`) confirms the same way. On a terminal without `--yes`, an apply shows the change summary and accepts only `y` or `yes`, in any case, ignoring surrounding space. Declining exits 0 and applies nothing. An apply without a terminal, or with `--json`, requires `--yes`.

### 2.1 Initialization

`init [directory]` previews. `--apply` installs the bundled language base, writes the three starter records and the release descriptor, and captures the workspace. The target is positional, so `--root` is refused. `--host claude` or `--host codex` also runs the host registration path, and `--host none` skips it. `--id` sets the package id, and `--system` also authors a local `@system` and `@distribution`. `--from <plugin-directory>` lowers a host plugin as a kit, `--migrate` rewrites a 1.1.0 starter, and `--adopt <id>` mounts a registry workspace. `--decline` and `--forget-decline` record or clear, in the IA home, that a repository should not be initialized; they write nothing in the repository. See [initialization](../workspace-initialization/README.md) and [apply](../workspace-initialization-apply/README.md).

### 2.2 Vocabulary and 2.3 formatting

`vocabulary` reads the word catalogue bundled with the CLI and opens no workspace, so `--root` is refused. `--schema` and `--example` require a word. `format` checks formatting by default and rewrites files only with `--write`.

### 2.4 Capture and 2.5 validation

`capture` admits the workspace and writes its snapshot to `.ia/work/snapshot/current.json` through the database service. `capture --preview` reports what it would write and writes nothing.

`ia compile` is removed. Every invocation returns `IA-CLI-USAGE` (exit 2) and names `ia capture --help` before it opens a workspace. It is absent from help and the catalog, and its token stays reserved so an extension cannot take it over. The published internal compile helpers keep their signatures for programmatic callers.

`validate` reports language and contract findings, then execution bindings and checks separately. A check with no bound evaluator is `not-evaluated`, never a pass. `validate` records the bound checks that passed or failed as evidence under `.ia/work/evidence/`, keyed to the authored revision it checked. A validation whose admission is refused records and prunes nothing; under `--verify-conformance` that is the admission without verification. `validate` never writes authored records.

`validate --verify-conformance --require-verified` (opt-in) exits 1 unless COMP-KERNEL and COMP-FIXTURES are both verified passes; without `--require-verified` the exit is unchanged. `validate --verify-conformance` verifies COMP-KERNEL and COMP-FIXTURES in-process with compliance's `package-v1` profile and reports them with `basis: 'verified'`, plus the profile and the suites it does not run. A floor that differs from the embedded one fails COMP-KERNEL and exits 1. The evidence it records is what `validate` without the flag records, even when verification refuses the report. Without the flag the output is unchanged.

### 2.6 Inspection and 2.7 packing

`inspect`, `read`, `position` and `next` are observations and write nothing. `read` returns the body behind a locator with its digest. A position packet is a navigable context surface, not a body.

`pack` requires `--descriptor`. A descriptor that names no `distribution`, which a default `init` writes, is refused as `IA-CLI-CONFLICT` (exit 3). An ordinary consumer workspace is therefore not publishable until it has a `@distribution`, which `init --system` authors.

### 2.8–2.11 Distribution changes

`install`, `update`, `remove` and `adopt` plan by default and apply only with `--apply`. `restore` has no preview and requires `--apply`. An apply rechecks the plan's inputs, and confirms as §2.0 describes.

After the installed set changes, registered host projections are refreshed. A refresh that fails after the install committed refuses at exit 3 and says that the installation is applied. `ia recover [installation|host|guard|lifecycle] --root <directory>` repairs an interrupted installation, host, guard or lifecycle transaction; `--root` is required. See [registry](../registry/README.md).

### 2.12 Doctor

`doctor` reads state and returns `ok`, `info`, `warn`, `fail` or `unknown` rows, one status per row. A check that did not run is `unknown`. Doctor exits 1 when any row is `fail` and 0 otherwise. It does not repair anything or start servers. The language `compatibility` row is `unknown` ("not checked") for a workspace with no release descriptor, and that row alone never fails doctor. See [host observations](../host-registration/README.md#7-doctor-and-support).

### 2.13 Preview and author

`preview` shows what one new record, one field change (`--set`) or one relationship (`--relate`) would compile to, with the findings it would add and the target file's current `sha256`. It writes nothing.

`author` takes the same arguments plus `--digest <sha256>`. It writes only when the target file still has that digest and the candidate is clean, and it adds one attribution comment naming the acting participant, its mandate and the authored revision. A changed file refuses as `IA-CLI-EDIT-STALE` and a candidate with errors as `IA-CLI-EDIT-UNCLEAN`, both at exit 1 and with nothing written.

`author` refuses the administrative words `workspace`, `agent`, `mandate`, `system`, `schema`, `agent-profile` and `hook` with `IA-CLI-EDIT-AUTHORITY`. An owner changes those records in source and runs `ia validate`.

### 2.14 Projection and host registration

`project <claude|codex>` plans, or with `--apply` writes, the position packet's files for one host and registers nothing. `project <claude|codex> --product plugin --out <directory>` writes the plugin a lowered workspace describes, and `--product plugin --check` compares it in memory, writing nothing. `host <claude|codex>` plans, or with `--apply` applies, the workspace's host registration, and `host --remove` plans removal of the owned host set. `host claude --user` installs a user-level plugin. All of them plan by default. The target of `project` and `host`, committed bootstrap included, is a directory with `.ia/src` that admits; a release descriptor is not required, so a workspace that ships no package works as one that does. See [host registration](../host-registration/README.md) and [host plugin distribution](../host-plugin-distribution/README.md).

### 2.15 Mandate checks

These commands are judged against the acting participant's governing mandates before they run:

| Move | Commands |
| --- | --- |
| Observation | `read`, `next`, `kb search/read/resolve/traverse` |
| Verification | `validate`, `preview`, `kb check` and `kb pack` preview |
| Synthesis | `author` |
| Execution | `capture`, `project`, `kb pack --apply` and a workspace `host --apply` |

A capture or project plan is judged as the effect it plans. No other command is judged, including `position`, `inspect`, `init`, `doctor`, the distribution commands, the machine protocol, and a `host` plan, `--remove` or `--user`. Each judged command takes `--actor <agent>` to name which authored participant is acting.

A refusal is `IA-RUNTIME-MANDATE-MOVE`, `IA-RUNTIME-MANDATE-WORD` or `IA-RUNTIME-MANDATE-ACTOR` at exit 1, and its next command is usually an `ia position` command for the mandates that govern there. `ia position` is never judged, so that command always runs. While an authored `@mandate` fails admission, including one stating `authority.moves []`, every judged command refuses with `IA-RUNTIME-REQUEST-INVALID` and names `ia report`, which shows the admission findings. A mandate is a cooperative restriction on these commands. It is not authentication or a sandbox, and it grants no host permission.

## 3 Exit classes and protocol boundaries

The consumer shell returns 0 for success, 1 for failed validation or a semantic refusal (a mandate refusal included), 2 for usage, 3 for state, I/O and conflict failures, 4 when `install`, `update` or `restore` cannot reach or read a remote registry or archive (`IA-DIST-ARTIFACT-UNAVAILABLE`, or a remote `IA-DIST-LIMIT-EXCEEDED`), and 130 for interruption.

The machine protocol keeps its own boundary. Its operations are `scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse` and `report`. Each prints one JSON line on stdout with no color and nothing on stderr, exits 0, 1 or 2, and carries no consumer `next`. Consumer formatting and flags never leak into it. The `ia-distribution` binary keeps its own protocol too, and never exits 2. [Protocol tests](../../../apps/cli/tests/protocols.test.ts) exercise the built entrypoints.

## 4 Refusals

A refusal keeps the service's code, location and reason, and names one command to run next. It does not turn unknown or interrupted work into success. Effects that already completed are reported as completed.

## 5 JSON

`--json` prints one parseable value to stdout. Prompts and incidental process output never share stdout. A parse-time refusal reads no workspace or installation state.

A refusal is `{version: 1, ok: false, code, message, exit, where, next}`. `where` is `{path, line, identity}` or `null`, `next` is the one command to run next, and `details` appears when the refusal carries one. An interruption is `{version: 1, ok: false, code: 'IA-CLI-INTERRUPTED', message, exit: 130, next}`, with no `where`; its `next` is also printed on one stderr line.

## 6 Terminal rendering

Human output is rendered from structured tokens, with terminal capability and width handling. `--no-color` (or `NO_COLOR`), `--color`, `--ascii` and `--quiet` adjust it. `NO_COLOR` disables color even with `--color`, and `--json` never prints color. `FORCE_COLOR` and `--color` force it, `IA_ASCII` or a non-UTF-8 locale selects ASCII symbols, and `--color` with `--no-color` is a usage error. Every command prints a terminal state line; progress output is optional. Severity and rendering limits do not change admission.

## 7 Knowledge commands

`ia kb check|search|read|resolve|traverse` opens an immutable, in-memory knowledge view. It reads authored records under `.ia/src` and their explicitly bound UTF-8 Markdown/text bodies. A selector at `.ia/knowledge.json` is optional for local reads. No `.kb`, persistent index or database is created.

`check` reports selected-record admission, reference closure and body availability. Workspace compliance checks are explicitly not evaluated by this scoped view; use native validation for the whole workspace. Missing references and excluded targets are unavailable without disclosing excluded identities or diagnostics. Local citations pin the snapshot and body and refuse after a change.

`ia kb pack --commit <full-sha> --selection <committed-path> --out <workspace-file>` previews a validated immutable package. `--apply` writes it; noninteractive and JSON apply require `--yes`. The output must have existing, unlinked parents within the repository and be outside `.ia`, `.git`, selected inputs and the selector. Identical existing bytes return unchanged; different bytes refuse. Current authority and native revision are checked again after interactive confirmation.

Read operations require Observation; check and pack preview require Verification; pack apply requires Execution. Nested parsing drives both enforcement and retry advice, including explicit `--actor`. The nine existing machine routes retain their protocol. Knowledge results use `{version: 1, ok, value}`; a `check` report that is not ok exits 1. A knowledge refusal uses the §5 refusal envelope with its `IA-KB-*` code and one next command for its cause: malformed input, knowledge outside the scope and an oversized response exit 1; a stale citation, a changed scope or source and an unreadable repository are operational and exit 3. Grammar, workspace, output-path and mandate refusals keep their established codes and exit classes.

The public [KB library](../../../packages/kb/README.md) owns selection, packaging and citations. The application host owns audiences, storage, lifecycle and approval.

## 8 Qualification

[CLI tests](../../../apps/cli/tests) cover parsing, JSON envelopes, exit classes and command outcomes. Installed-consumer checks also exercise the packed binaries. Neither establishes that a host loaded or activated anything.
