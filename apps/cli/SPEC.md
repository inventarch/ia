# @inventarch/cli

The `ia` binary exposes consumer commands and the structured agent query protocol. The [language reference](https://github.com/inventarch/ia/blob/main/docs/reference/language/README.md) defines vocabulary and evaluation limits. This package bundles the language archive, vocabulary catalogue and host payload needed by its commands.

## Workspace commands

| Command | Behavior |
| --- | --- |
| `init [directory]` | Preview a workspace, or create it with `--apply`; `--host none` omits host registration. The target is positional, so `--root` is refused. |
| `validate [path...]` | Check the selected workspace records against language and declared contracts; report attributable diagnostics. |
| `compile` | Write a deterministic artifact under `.ia/work/`, or emit it with `--stdout`; overwrite requires `--force`. |
| `format [path...]` | Check formatting by default; rewrite with `--write`. |
| `inspect [identity]` | Show a workspace overview, or a record named by its full `system/kind/facet/name` identity and its relationships. |
| `vocabulary [word]` | Read the installed catalogue, including schemas and examples; no workspace is opened. |

Workspace discovery uses the nearest ancestor containing `.ia/src`, with `--root` selecting an explicit root where supported. Native syntax is `#! ia 1.0`. Initialization writes a consumer-local system, starter records and release descriptor, and installs the pinned bundled language base. A new consumer distribution starts at its own 0.1.0 version, independently of the CLI version.

## Distribution commands

`pack --descriptor <file>` writes a digest-named archive. `install`, `update` and `remove` preview a plan and apply it only with `--apply`. `restore --apply` reinstalls the locked generation from pinned archives. Catalog, offline-cache and configured registry sources are explicit options. The native package IDs and versions in these commands are separate from npm package names and the CLI version.

`host <claude|codex|cursor>` previews a workspace registration and requires `--apply` to write it. Claude also supports user-level registration through `host claude --user`. `doctor` observes runtime, workspace, install and host state without repairing it or treating a written registration as an answering server. Unknown update or host observations stay unknown.

## Automation and limits

`--help` and per-command help describe the accepted argument grammar. Consumer `--json` output is a single structured value without interactive prompts; applying without a terminal or with `--json` requires `--yes`. Validation findings use exit 1, usage failures exit 2, unavailable inputs and local operational refusals exit 3, and interruption exits 130. Automation should inspect the structured diagnostic code and exit value together.

The agent protocol retains `scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse` and `report`, using `--params <JSON>` or `--params -` for stdin. Scope tokens last for one invocation. These read operations do not invoke a model or grant host permissions. Generic structural validation does not attest evidence or execute a declared check.

Package tests cover parsing, JSON output, initialization and recovery, workspace inspection and formatting, distribution planning/application, and host registration. Repository qualification separately exercises built and installed artifacts. External registry publication and each host's own runtime behavior require separate evidence.
