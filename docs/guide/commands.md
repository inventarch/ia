# Commands

**Every `ia` command, grouped by what you want to do. `ia <command> --help` prints the full syntax of any of them.**

The [CLI guide](../../apps/cli/README.md) and the [consumer CLI contract](../specs/consumer-cli-contract/README.md) give the exact behavior.

## By task

| I want to | Run |
| --- | --- |
| Start using IA in a repository | `ia init . --host none`, then the same with `--apply --yes` |
| Check my records | `ia validate` |
| Check them and run the language's self-tests | `ia validate --verify-conformance` |
| See what a word needs | `ia preview <word>` or `ia vocabulary <word> --schema` |
| List every word | `ia vocabulary` |
| Add or change a record safely | `ia preview …`, then `ia author … --digest <sha256>` |
| See what can be worked on next | `ia next` |
| See what an agent sees for one task | `ia position --seat <identity> --shape sequence` |
| Look at one record and its links | `ia inspect <identity>` |
| See which records a file holds | `ia inspect --path <file>` |
| Print a record's text, or one cell or requirement | `ia read <identity>[#<phase>/<Primitive>\|#<REQ-ID>]` |
| Refresh the workspace snapshot | `ia capture` |
| Fix the layout of `.ia` files | `ia format --write` |
| Connect Claude Code or Codex | `ia host claude` or `ia host codex`, then with `--apply --yes` |
| Write the packet files only | `ia project claude` or `ia project codex`, then with `--apply --yes` |
| See whether everything is installed and current | `ia doctor` |
| Search records and documents | `ia kb search "<words>"` |
| Rebuild `.ia/distributions/` after cloning | `ia restore --apply --yes` |
| Add a distribution | `ia install <id>`, then with `--apply --yes` |
| Package my own system | `ia pack --descriptor .ia/release.json` |

## All commands

### Records

| Command | Does | Writes | Move |
| --- | --- | --- | --- |
| `ia init` | Creates a workspace (preview without `--apply`) | `.ia/` | none |
| `ia validate` | Checks every record; runs checks | Evidence under `.ia/work/evidence/` when admitted | Verification |
| `ia preview` | Shows a new record, field or relationship, or a word's schema | Nothing | Verification |
| `ia author` | Writes what `ia preview` showed, if the file has not changed | One `.ia` file | Synthesis |
| `ia capture` | Takes a snapshot of the admitted workspace (`--preview` to only report) | `.ia/work/snapshot/` | Execution |
| `ia format` | Checks layout (`--check`, the default) or fixes it (`--write`) | With `--write`, `.ia` files | none |
| `ia inspect` | Shows a record, its links, a file's records or a workspace overview | Nothing | none |
| `ia read` | Prints the text behind an identity, cell or requirement, with its digest | Nothing | Observation |
| `ia vocabulary` | Lists the public words, or shows one | Nothing | none |

### Work and agents

| Command | Does | Writes | Move |
| --- | --- | --- | --- |
| `ia next` | Shows a plan's tasks in order, each done, ready or blocked | Nothing | Observation |
| `ia position` | Shows the context for a scope key | Nothing | none |
| `ia project` | Writes a host's packet and generated files (preview without `--apply`) | Host files | Execution |
| `ia host` | Writes host files and registers the MCP server and edit guards | Host files, `~/.ia/hosts/` | Execution, for a workspace `--apply` |
| `ia doctor` | Reports the runtime, workspace, installation and hosts | Nothing | none |

### Knowledge

| Command | Does | Move |
| --- | --- | --- |
| `ia kb check` | Checks the selected records and documents | Verification |
| `ia kb search <query>` | Searches them | Observation |
| `ia kb read <identity>` | Returns a body with a citation | Observation |
| `ia kb resolve --citation <file>` | Checks a citation still matches | Observation |
| `ia kb traverse <identity>` | Follows relationships | Observation |
| `ia kb pack` | Packages a selection from a commit (preview without `--apply`) | Verification; Execution with `--apply` |

### Distributions

| Command | Does |
| --- | --- |
| `ia pack --descriptor <file>` | Builds a digest-named archive |
| `ia install <id>[@<range>]…` | Adds distributions |
| `ia update <id>` | Changes one distribution's version |
| `ia remove <id>` | Removes one |
| `ia restore --apply` | Reinstalls what the lock pins |
| `ia recover --root <directory>` | Repairs an interrupted install, host, guard or lifecycle change. `--root` is required. |
| `ia adopt <id>[@version]` | Mounts another workspace's records as pinned source |

These commands are not checked against mandates.

### Machine protocol

`ia scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse` and `report` are a frozen interface for programs. Each takes JSON through `--params` and prints one line of JSON, with no color. `ia <operation> --help` documents one. `ia report` is also the way to see admission findings when a broken mandate blocks `ia validate`.

## Options most commands take

| Option | Does |
| --- | --- |
| `--root <path>` | The workspace to use. By default, the nearest folder above the current one that has `.ia/src`. (`ia init` takes the folder as an argument instead.) |
| `--json` | Print one JSON value, with no color, progress or prompts |
| `--apply` | Do what the plan shows. Without it, `init`, `install`, `update`, `remove`, `adopt`, `project` and `host` only plan. |
| `--yes`, `-y` | Do not ask for confirmation. Required with `--apply` when there is no terminal or with `--json`. |
| `--actor <agent>` | Act as this participant, for commands that check mandates |
| `--no-color`, `--ascii`, `--quiet` | Plain output, ASCII symbols, no progress |

## Exit codes

| Exit | Means |
| --- | --- |
| `0` | Success. Warnings alone exit 0. |
| `1` | Refused: validation errors, a mandate refusal, a stale `--digest` |
| `2` | Usage error: a bad option or value |
| `3` | Something unavailable or in conflict: no workspace, a restore needed, a file in the way |
| `4` | A registry or archive could not be reached during `install`, `update` or `restore` |
| `130` | Interrupted |

Every refusal names one command to run next. With `--json`, a refusal is `{"version": 1, "ok": false, "code", "message", "exit", "where", "next"}`.
