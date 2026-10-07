# @inventarch/cli

The `ia` binary exposes consumer commands and the structured agent query protocol. The [language reference](https://github.com/inventarch/ia/blob/main/docs/reference/language/README.md) defines vocabulary and evaluation limits, and the packaged [language summary](LANGUAGE.md) lists the words this release ships. This package bundles the language archive, vocabulary catalogue and host payload needed by its commands.

## Workspace commands

| Command | Behavior |
| --- | --- |
| `init [directory]` | Preview a workspace, or create it with `--apply`; `--host none` omits host registration and `--id <provider/name>` sets the package id (default `local/<directory name>`). `--decline today` or `--decline forever` records that a repository should not be initialized, and `--forget-decline` removes that record. The target is positional, so `--root` is refused. |
| `validate [path...]` | Check the selected workspace records against language and declared contracts; report attributable diagnostics. `--severity` sets the lowest severity reported and `--max-findings` the number rendered (default 50). |
| `compile` | Write a deterministic artifact under `.ia/work/`, or emit it with `--stdout`; `--out <file>` names the artifact and overwriting requires `--force`. |
| `format [path...]` | Check formatting by default; rewrite with `--write`. |
| `inspect [identity]` | Show a workspace overview, or a record named by its full `system/kind/facet/name` identity or by `--path <file>`, and its relationships. `--edges` (`in`, `out` or `both`; default `out`) and `--depth` (0 to 3; default 1) bound the traversal. |
| `vocabulary [word]` | Read the catalogue shipped with the package, including schemas (`--schema`) and worked examples (`--example`); `--domain`, `--kind` and `--search` filter it. No workspace is opened, so `--root` is refused. |

Workspace discovery uses the nearest ancestor containing `.ia/src`, with `--root` selecting an explicit root where supported. Native syntax is `#! ia 1.0`. Initialization writes a consumer-local system, starter records and release descriptor, and installs the pinned bundled language base, `inventarch/language` 1.1.0, which supplies the eleven public systems. A new consumer distribution starts at its own 0.1.0 version, independently of the CLI version.

## Distribution commands

`pack --descriptor <file>` writes a digest-named archive, by default under `.ia/work/dist`. `install`, `update` and `remove` preview a plan and apply it only with `--apply`; `--plan-out <file>` keeps the plan under `.ia/work/`. `restore --apply` reinstalls the locked generation from pinned archives; it has no preview, and `--allow-withdrawn` accepts a withdrawn release. Catalog, offline-cache and configured registry sources are explicit options. The native package IDs and versions in these commands are separate from npm package names and the CLI version.

`host <claude|codex|cursor>` previews a workspace registration and requires `--apply` to write it; `--remove` plans removal of the host set it owns. For Claude, `--context <identity>` selects the lifecycle context element of a workspace registration, and `host claude --user` registers a user-level plugin that needs no workspace. `doctor` observes runtime, workspace, install and host state without repairing it or treating a written registration as an answering server; `--host` adds that host's session briefing and next actions. Unknown update or host observations stay unknown.

## Automation and limits

`--help` and per-command help describe the accepted argument grammar. Consumer `--json` output is a single structured value without interactive prompts; applying without a terminal or with `--json` requires `--yes`. `--no-color` (or `NO_COLOR`), `--color`, `--ascii` and `--quiet` adjust human-readable output. Validation errors exit 1 (warnings alone exit 0), usage failures exit 2, unavailable inputs and local operational refusals exit 3, and interruption exits 130. Automation should inspect the structured diagnostic code and exit value together. Every consumer refusal names one next command, printed after its message and carried as a non-empty `next` in `--json` output, interruption included; a refusal whose cause names no remedy of its own falls back to the refused command's `--help` for a usage failure and to `ia doctor` otherwise. The machine protocol's frozen refusal shape is unchanged.

The machine protocol, version 1, serves `scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse` and `report`. Each takes its JSON parameters through `--params <JSON>`, or `--params -` for stdin, and prints one JSON line without color. `ia <operation> --help` lists an operation's parameters, refusals with their exit values, and an example; `ia <operation> --schema` prints its parameter schema. Scope tokens last for one invocation. These read operations do not invoke a model or grant host permissions. Only the CLI serves `report`; the MCP door does not. Generic structural validation does not attest evidence or execute a declared check.

Commands that start another program (`git` for `init` and `doctor`, `claude` for `host claude --user`) look it up only on fully qualified `PATH` entries and run it by absolute path from the user's home directory. An empty or relative entry, which would name the working directory, is never searched.

## Mandate authority

A `@mandate` may declare its authority as closed moves. Each CLI mode maps to one kernel move: read → Observation, validate → Verification, author → Synthesis, effect → Execution, re-seat → Delegation. The runtime publishes this table as `MODE_MOVES` beside `mandateRefusal`, which refuses a mode whose move the mandate does not list (`IA-RUNTIME-MANDATE-MOVE`) or a word the mandate excludes (`IA-RUNTIME-MANDATE-WORD`) and names `ia inspect <mandate> --edges both` as the next command. A mandate without `authority.moves` restricts no move, a declared list names at least one move, excluded words are refused whatever the moves, and a mandate adds closed restrictions only; it never grants host permissions. Enforcement arrives with the authoring verbs; no command in this release consults a mandate.

Package tests cover parsing, JSON output, initialization and recovery, workspace inspection and formatting, distribution planning/application, host registration, installation and recovery, and the program lookup above. Repository qualification separately exercises built and installed artifacts. External registry publication and each host's own runtime behavior require separate evidence.
