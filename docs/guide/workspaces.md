# Workspaces

**A workspace is a repository that IA manages: a `.ia/` folder holding your records, the language they are written in and IA's working state. `ia init` creates one.**

## Creating a workspace

From the repository folder, preview, then apply:

```sh
ia init . --id local/my-project --host none
ia init . --id local/my-project --host none --apply --yes
```

| Option | What it does |
| --- | --- |
| `<directory>` | Where to create the workspace. Defaults to the current folder. `ia init my-project` from a parent folder creates the folder too. |
| `--id <provider/name>` | The workspace's identity. The name part, such as `my-project`, names the starter records. Defaults to `local/` plus the folder name. |
| `--host claude\|codex\|none` | Also connect an agent host when done, as `ia host` would. Defaults to `none`. |
| `--system` | Also create a system folder, for a repository that will define words of its own. See [Your own vocabulary](your-own-vocabulary.md). |
| `--from <plugin-folder>` | Turn an existing Claude Code, Codex or Grok plugin into a workspace. See [Distributions and kits](distributions-and-kits.md#plugins-as-kits). |
| `--migrate` | Move a workspace created by IA 1.0 or 1.1 to the current layout. See [Upgrading](upgrading.md). |
| `--apply` | Do it. Without it, `ia init` only prints its plan. |
| `--yes` | Do not ask for confirmation. Needed with `--apply` when there is no terminal, as in CI. |

`ia init` needs no network. It installs the language from an archive bundled with the CLI.

It refuses some targets:

- a folder that is already a workspace, with `IA-CLI-CONFLICT`. It names `ia position` instead;
- a folder that is, contains or sits inside IA's home folder (`~/.ia`, or `IA_HOME` if set), with `IA-DIST-PATH-UNSAFE`. This includes your user home folder itself, because it contains `~/.ia`. Create workspaces in project folders.

## What it writes

```text
.ia/
├── .gitignore               # ignores work/ and distributions/
├── distributions.lock.json  # the language version this workspace uses, pinned by digest
├── release.json             # this workspace's identity, version and dependencies
├── src/
│   └── workspace.ia         # your records start here
├── distributions/           # installed archives (ignored)
└── work/                    # snapshots and evidence (ignored)
```

| File or folder | Commit it? | What it is |
| --- | --- | --- |
| `.ia/src/` | Yes | Your records. Everything you write goes here. |
| `.ia/release.json` | Yes | The workspace's id, version (starts at `0.1.0`), the language range it needs and where its source lives |
| `.ia/distributions.lock.json` | Yes | The exact archives installed, by digest, so every clone gets the same language |
| `.ia/.gitignore` | Yes | Keeps the next two folders out of git |
| `.ia/distributions/` | No | The installed language and any other distributions. Rebuilt with `ia restore`. |
| `.ia/work/` | No | Snapshots (`work/snapshot/`), check evidence (`work/evidence/`) and other output |

If you already have a `.ia/.gitignore`, `ia init` leaves it alone.

## The starter records

`.ia/src/workspace.ia` holds three records:

```ia
@workspace my-project
  meaning
    says "The my-project workspace and the public systems it composes."
    answers "Which systems does this workspace compose?"
  composition
    systems [@system agent-composition-system, @system agent-system, …]
    sources [".ia/src @authored"]
    steward @agent my-project

@agent my-project
  meaning
    says "The IDE agent operating in the my-project workspace, any vendor."
    answers "Which participant acts in the my-project workspace?"
  governance
    applies []

@mandate my-project-mandate
  …
  authority
    participant @agent my-project
    moves [Observation, Verification, Synthesis, Delegation, Execution]
    scope [@workspace my-project]
```

- **`@workspace`** lists the systems whose words you may use (all eleven), the folder records are read from and its **steward**: the agent that acts by default.
- **`@agent`** is the **participant**: the coding agent that works in this repository, whatever its vendor.
- **`@mandate`** says what that participant may do. The starter allows every move. [Agents and authority](agents-and-authority.md) explains how to narrow it.

These three records are yours to edit by hand. `ia author` will not change `@workspace`, `@agent` or `@mandate` records, so an agent cannot widen its own authority through IA.

## Snapshots and `ia capture`

IA keeps a **snapshot** of the admitted workspace in `.ia/work/snapshot/current.json`, and the one before it in `previous.json`. `ia init` takes the first one. `ia capture` takes a new one:

```text
Capture  ia-snapshot-1                            revision b100b4bdbc58…

  ✔  Captured 183 records.
     Since the capture at revision 1a0a269f278a…: 0 changed, 174 unchanged, 9
     new, 0 removed.
```

The snapshot is how IA tells what changed. Positions report their **freshness** against it, `current` or `stale`, and `ia next` uses the previous snapshot to explain why evidence went stale. Run `ia capture` after a batch of edits, or let CI do it. Each clone captures for itself, and the same records always capture to the same revision.

The **revision** that appears in most output (`revision 5778ce880732…`) is a digest of every authored record. It changes whenever any record in `.ia/src/` changes, and only then.

## Working in a team

**Cloning.** The ignored folders are not in git, so a fresh clone starts without them. IA refuses with `IA-DB-SOURCE-UNAVAILABLE` and names the fix:

```sh
ia restore --apply --yes
```

This reinstalls the exact archives in the lock. For the language itself it uses the copy bundled with the CLI, so **everyone on the team should use the same IA version**. Pin it as a development dependency (see [Install the CLI](README.md#install-the-cli)).

**Line endings.** The lock file is compared byte for byte. If git converts it to Windows line endings, IA reports `lock-drift`. Prevent that with a `.gitattributes` entry:

```gitattributes
.ia/distributions.lock.json -text
```

**Continuous integration.** A typical CI job:

```sh
npm ci                                   # installs the pinned @inventarch/cli
npx ia restore --apply --yes
npx ia validate --verify-conformance
```

`ia validate` exits `0` when the workspace is admitted and `1` when it is refused. It writes evidence under `.ia/work/evidence/`, so the job needs a writable `.ia/work/`.

**Agent host files.** `ia host` and `ia project` write files with paths for one machine. Each person runs them in their own clone; do not commit them. See [Connecting agents](connecting-agents.md).

## One workspace per repository

Most repositories have one `@workspace`, and IA treats it as the default for commands that take no `--seat`. You can author more, for example to describe parts of a large repository, but then IA cannot pick a default and asks you to name one. A workspace grants no account or file permission; it is a boundary for records, not for access.

## Checking the installation

`ia doctor` reports the CLI, the workspace and the installation in one place: the Node version, record counts, the installed generation, any interrupted install, registered hosts and whether generated host files have drifted from their records. Run it first when something seems wrong.
