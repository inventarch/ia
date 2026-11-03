---
id: spec-host-plugin-distribution
genre: spec
title: Host plugin distribution
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-27"
owners: [inventarch]
---

# Host plugin distribution

This contract describes the user-level side of host support: the IA home, the Claude plugin that `ia host claude --user` installs, the session briefing that plugin runs, and the initialization choice it records. It also covers plugin products: a plugin lowered into a kit workspace and rendered back (§12). The implementation is [user-host](../../../apps/cli/src/user-host.ts), [doctor-user](../../../apps/cli/src/doctor-user.ts), [briefing](../../../apps/cli/src/briefing.ts), [decline](../../../apps/cli/src/decline.ts), [channel](../../../apps/cli/src/channel.ts), the host table in [hosts.ts](../../../apps/distribution/src/hosts.ts) and the pure [plugin renderer](../../../packages/compliance/src/host-plugin.ts). Workspace registration is described in [host registration](../host-registration/README.md).

Section numbers are stable because source comments cite them; retired sections keep their numbers unused.

## 3 IA home

The IA home holds the materialized host payloads (`hosts/`), the Claude plugin marketplace (`claude/marketplace`), the initialization decisions (`state/decisions.json`), the cached update check (`state/update-check.json`), the optional `config.json` and the `home.json` marker that names the directory as an IA home. It is `IA_HOME`, or `~/.ia` when that is unset; `IA_HOST_HOME` is still read and doctor warns that it is deprecated.

A relative home refuses with `IA-DIST-INPUT-INVALID`. A home that contains `src/` refuses with `IA-DIST-PATH-UNSAFE`, because it must never look like a workspace, and the IA home and a workspace may not contain each other. Doctor reports a registration that pins a payload outside the current home as a warning naming `ia host <host> --apply`; it does not rewrite the registration.

## 4 Host adapters

One row per host decides what each command accepts:

| Host | Status | Workspace registration | User-level entry point | Hooks | Committed bootstrap (`ia host <host> --commit`) |
| --- | --- | --- | --- | --- | --- |
| `claude` | supported | yes | the Claude plugin | yes | `CLAUDE.md`; `.mcp.json` |
| `codex` | partial | yes | none | yes | `AGENTS.md`; `.codex/config.toml` |
| `copilot` | partial | no | none | no | `.github/copilot-instructions.md` and `AGENTS.md`; `.vscode/mcp.json` (VS Code, `servers`) and `.github/mcp.json` (Copilot CLI, `mcpServers`, `type: "local"`) |
| `cursor` | planned; refuses | no | none | no | none |

`ia host cursor`, `ia host copilot` without `--commit`, and `ia host codex --user` refuse with `IA-DIST-HOST-UNSUPPORTED` and write nothing. Codex hooks are supported by the host; IA registers no Codex hook group yet, and Claude's guard observation stays Claude's. `ia doctor --host` accepts `claude`, `codex` and `cursor`; for a host with no workspace registration, the briefing says so and never suggests `ia host`.

The committed bootstrap is the one set of host files meant for source control. Each instruction file gains one block between `<!-- BEGIN IA BOOTSTRAP ... -->` and `<!-- END IA BOOTSTRAP -->`, and each MCP file one server named `ia` whose launch is `npx -y @inventarch/mcp-door@<version>`, the CLI's own version; every other byte is kept, a rerun updates only the block and the server, and `--remove` takes out exactly them. A server named `ia` that is not such a launch, a repeated block, or an instruction file that is a generated position packet refuses with `IA-DIST-LOCAL-MODIFICATION`. The plan writes nothing; `--apply` is judged as Execution like a workspace apply, and `--remove` is not judged.

## 5 Install channel

Doctor reports how this `ia` is installed: a source `checkout`, with its commit and origin; an `npm` package; or `unknown`, which is a warning. It reads only the filesystem and local git. The channel decides the update instruction that doctor and the briefing give.

## 6 Plugin packaging

### 6.1 Rendering

The renderer is a pure function: the same input always yields the same files. It writes a marketplace manifest, the `ia` plugin manifest, an `ia-author` agent, with `Read`, `Glob`, `Grep` and `Bash`, whose instructions are to review `.ia` records and propose changes without editing files, a `SessionStart` hook, and `init`, `doctor` and `authoring` skills. It also writes `plugins/ia/ia-plugin.json`, which records the CLI version, install channel, CLI entry and update instruction the hook reads. The hook is registered for `SessionStart` on `startup` and `clear`. The plugin has no MCP server; workspace registration stays with `ia host claude`. The CLI entry and the Node path are explicit renderer inputs.

The `init` skill is the hook-up procedure, for a repository with no workspace and for an existing workspace that is not yet registered. It runs five steps in order. **Ground**: one CLI for every command, the repository's pinned `@inventarch/cli` when it is installed; `ia doctor --json --host claude`; and a read of `.ia/src`, `.gitignore`, `AGENTS.md`, `CLAUDE.md` and the host configuration files. **Plan**: one round of questions: whether to initialize (or decline today or forever, §7.2), which hosts (Claude Code alone, or with Codex, whose generated `AGENTS.md` meets a user's own one only as the user chooses: kept, handed over with its guidance moved to `CLAUDE.md`, or Codex left out), and, when doctor's source-protection row warns, whether to author a `@hook` over `.ia/src/**`, which guards Claude Code only. **Apply**: `ia init` or `ia host` per chosen host, each plan shown before its `--apply --yes`; the hook shown by `ia preview` and, because `ia author` refuses that administrative word, written in source exactly as previewed, a new file opening with the workspace's `#! ia` pragma line, which the preview omits, and checked with `ia validate`; and a check that the recorded Node path outlives the shell. **Reconcile**: a proposed `.gitignore` block for the files the host plan calls machine-local and the receipt lists, and proposed edits to the user's own `AGENTS.md` and `CLAUDE.md`. Generated files are never edited, and a sentence that contradicts the new setup changes only as the user says. **Check**: `ia doctor` and `ia validate`, each non-ok row explained, and the MCP approval Claude Code asks for. Each write is shown first and made only after the user confirms it. The skill never commits or pushes.

### 6.2 Identity

The plugin version is `<cli version>+<12 hex digits>`. The digits come from a digest of the files rendered with a placeholder version, so the version changes whenever the rendered content changes. On macOS and Linux the hook names the Node that ran the apply by absolute path, so that path is part of the digest; on Windows the hook runs `node` from `PATH`.

### 6.3 Apply

`ia host claude --user` needs no workspace, refuses `--root`, and plans by default. `--apply` runs Claude's own `claude plugin marketplace add inventarch/marketplace`, `claude plugin install ia@inventarch --scope user`, `claude plugin marketplace update inventarch` and `claude plugin update ia@inventarch --scope user --json`, installing the one public `ia` plugin from the public catalogue `inventarch` (kit discovery decision 5), renders nothing, and records the install in `<IA home>/claude/marketplace-install.json` as soon as `install` exits 0, which a workspace plan reads as the user-level plugin being present; a refresh that fails after it leaves the record in place. `--local` keeps the offline path: `--apply` writes the rendered plugin to `<IA home>/claude/marketplace`, then runs `claude plugin marketplace add <that directory>` and the same install and updates. The two updates bring an existing install to the catalogue's current release, because `install` leaves an installed plugin at its version and Claude does not refresh a third-party catalogue by default; rerunning the apply is how a person takes a new release. Refreshing the public catalogue needs the network, so a rerun from the public source no longer completes offline; the `--local` source refreshes from its directory. The update's `--json` report is read: an update Claude reports it held back (`updateOutcome` `skipped`, such as a plugin another plugin pins to an older range, or `refreshFailed`) exits 0 in Claude but refuses here, quoting Claude's reason. The plan prints the commands and says which source (`marketplace` or `local`) it uses. If `claude` cannot be run, a local apply writes the plugin, and either apply says to run the commands by hand. `claude` is looked up only on fully qualified `PATH` entries. The apply never reads or edits Claude's settings files. `--remove --apply` runs Claude's removal commands first and deletes the plugin directory last.

The plan runs `claude --version` to learn whether `claude` can be run, and a removal plan reads `claude plugin list --json` and `claude plugin marketplace list --json`. Removal runs `claude plugin uninstall ia@inventarch --scope user` and `claude plugin marketplace remove inventarch` only for what those lists report, or cannot rule out.

## 7 User state

### 7.1 Registration

The user-level plugin is owned and removed independently of any workspace registration. A workspace plan for Claude reports when the plugin is missing and names `ia host claude --user --apply`; it never runs it. A service refusal keeps its code and message and gains a command remedy. A `claude` command that fails, or an update Claude reports it held back, refuses with `IA-CLI-HOST-COMMAND-FAILED`, naming the rerun; a `--local` apply's reruns keep `--local`.

### 7.2 Initialization choice

`ia init --decline today|forever` and `ia init --forget-decline` change only the IA home's decisions file, keyed to the repository; they write nothing in the repository. A successful `ia init --apply` clears the decision. A failure to clear it does not undo initialization.

### 7.3 Doctor

These rows exist with or without a workspace: install channel, IA home, Claude plugin and updates. With a workspace, doctor adds a local language compatibility row and a `cli-version` row, which names the `@inventarch/cli` copy that runs and the CLI dependency the workspace lists (consumer-cli-contract §1.2). That row is `ok` when the installed copy is the running one and either satisfies the range or has a range the row does not evaluate, such as `workspace:*`. It is `warn` naming the package manager's plain install command (`npm install`, never a frozen one) when the installed copy does not satisfy the range or the dependency is not installed between the workspace and its manifest, and `warn` with no remedy when another copy runs and hand-off was not set aside. It is `info` with no remedy when `IA_NO_HANDOFF=1`, `--host`, or a local copy the repository commits set hand-off aside, and `info` naming the package manager's command that adds the dependency when there is none, with `-w` at a pnpm workspace root and `-W` at a Yarn 1 one. Whatever its status, the row's detail ends by saying when the package managers disagree or none is declared or locked, and then it names no command. Without a workspace, doctor adds the initialization decision. `ia doctor --host <host> --json` adds `session`, the briefing, and `nextActions`, each with its argument vector and the host's own invocation where it has one (`/ia:init` for Claude). The Claude plugin row reads the rendered plugin, or else the marketplace install record: `ok` when the ia that wrote it is this one, `warn` naming that ia when it is another, and `warn` when either cannot be read, each stale or unreadable case naming `ia host claude --user --apply`; the briefing's plugin notice follows the same ia. After a hand-off (consumer-cli-contract §1.2), the Claude plugin and updates rows judge against the version of the copy that handed off, the one `IA_HANDOFF_FROM` names, whenever its `package.json` can be read, and the updates row reads the cache, gives its remedy and names its refresh by that copy's install channel too: neither `ia host claude --user` nor the session hook hands off, so that copy renders the plugin and refreshes the update cache. Copies of `@inventarch/cli` released before this rule still judge both rows against their own version. Doctor repairs nothing, never runs `claude`, and makes no registry or update request.

Every row carries a structured `fix` beside its `remedy` (consumer-cli-contract §2.12): `{program, argv, flow, writesTo}`, or `null` for advice. Its display, derived from `argv`, equals the remedy wherever the remedy is one runnable command; the `cli-version` install and pin for a manifest in an ancestor directory keep their remedy text, and their fix names that directory with the package manager's own flag (`npm install --prefix <dir>`, `pnpm --dir <dir> install`, `yarn --cwd <dir> install`, `bun install --cwd <dir>`). A supplied `--root` reaches the fix as it reaches the remedy. Check ids are an open set; a reader accepts ids it does not know.

With a workspace, doctor adds kit rows read from the update cache (§11) and local registry configuration only. `kits` is `info` "no kits installed" when the workspace has no installed unit (an npm package of kits, an intact registry collection, or a direct request neither owns); `ok` when every unit's cached entry for its `(registry, kind, id)` key is under a week old and names no newer version; `warn` when any unit is behind, with one `kit-update:<id>` row per unit behind; and `unknown` when a unit has no key (an unmapped provider, named with its reason), no entry, no version, or an entry a week old. A known update outranks an unknown unit. Each row states its oldest check time, as `YYYY-MM-DD HH:MM UTC`. A collection whose identity is unknown after an interrupted change makes `kits` `warn` "collection identity unknown", with `ia install <ids>` as its fix. A `kit-update:<id>` fix is by source: `ia install --package <name>@<latest>` for a package, `ia install <id>@<latest>` for a collection (which replaces the members it recorded), and `ia update <id>` for a release. `marketplace` names the marketplace and plugin the IA home's record holds, the ia that installed it, and when the marketplace was last consulted: `ia host claude --user --apply` records `checkedAt` only once every registration command has exited 0, keeps the previous one when a command after `install` fails, and never uses a file's modification time; a record without it says "not recorded" and stays valid. Absent, it is `info` with `ia host claude --user --apply` as its fix; unreadable, `warn` with the same fix.

An extension declares an `Extension.console`: areas, offers whose steps are its own commands, and a state file under the IA home, `{"format": "ia-extension-checks-1", "checks": [...]}`. Its checks follow the user rows in Environment. An id must start with `<token>-` and name no core row; others are dropped and named in one `unknown` row, `<token>-state`, which also stands for a state file that cannot be read. An extension fix must run `ia <token> …`, or it is `null`. The public build declares no extension console.

## 8 Session hook

### 8.2 Briefing

The plugin's `SessionStart` hook runs `ia doctor --json --host claude` and gives it five seconds. It runs the CLI entry that rendered the plugin, or, when that file is gone, an `ia` found on a fully qualified `PATH` entry. Every child the hook starts has `IA_NO_HANDOFF=1`, so the `ia` it runs answers itself and never hands off to a copy the repository installed (consumer-cli-contract §1.2). It turns the `session` field into context lines for the model and at most one notice for the user. The briefing distinguishes:

- a directory that is not a workspace, where the model may offer `/ia:init` only when the request involves InventArch, `.ia` records or their governance;
- a directory inside another workspace, which names that workspace and `ia doctor --root <workspace>` instead of offering initialization;
- the InventArch framework source itself, when `ia` runs from a checkout and the workspace is that checkout, where consumer workspace advice does not apply;
- an initialization declined today or permanently, which the model does not offer again;
- a registered host, or a stale or missing registration with the `ia host <host> --apply` command;
- a host set doctor could not observe, naming recovery first;
- a plugin rendered by another `ia` version, naming `ia host claude --user --apply`;
- an available update, shown to the user at most once per local day;
- an `ia` that cannot be found, times out or does not report session state.

A briefing is evidence from observation. It grants no permission to execute anything.

## 9 Decision recovery

A decisions file that cannot be read is a doctor `warn` row naming the file and its repair. `ia init --decline` refuses with a remedy that depends on the cause. No session-start hook initializes a repository or rewrites authored records.

## 11 Updates and evidence

Doctor reads update state only from the cache in the IA home; it never asks npm or git. When a refresh is due, doctor returns the refresh command as data and the session hook starts it in the background. `IA_NO_UPDATE_CHECK=1`, a non-empty `CI`, or `"updateCheck": false` in the IA home's `config.json` turns update checks off. The same file's `"accountOffer"` (boolean, default `true`) says whether the `ia` plugin makes its once-per-session account offer; `false` suppresses it for that IA home. Readers take both keys with `readIaConfig` and ignore any other.

The cache's `packages` holds `{checked, entries}`, one entry per installed unit key `(registry, kind, id)`: `registry` is `npm` for a package of kits, else the location of the registry the workspace chooses for that id, so two workspaces that map one id to two registries keep two entries. Each entry is `{registry, kind, id, latest, checkedAt}`, `latest` being the newest non-withdrawn version or `null` when its source could not answer. An older reader keeps only `checked: false`; this reader accepts that form and drops an entry it cannot read. `ia-distribution refresh-updates --root <absolute workspace>` looks up each installed unit whose entry is missing or a day old, at most 20 per run, each within 15 seconds and one shared registry read budget: a package from npm, a collection from the registry's kit index, a release from its release index. `--force` looks up every unit however fresh, and needs `--root`. `IA_NO_UPDATE_CHECK=1` in the environment stops every refresh, a forced one included: it asks no source and writes nothing. The refresh is asynchronous and holds no lock while it looks up; it then takes the store lock `state/update-check.json.lock` (the owner-stamped lock the tracked list also takes, consumer-cli-contract §2.16, never removed for another owner), re-reads the cache and merges: an entry this run fetched replaces one only when that one is older, every other entry stays, the CLI fields and the global stamp are this run's unless a refresh that finished meanwhile is newer, and entries untouched for 30 days are dropped. A refresh that cannot take the lock writes nothing: the background one exits quietly and a forced one refuses naming the lock. Doctor schedules the background refresh, with `--root` for a workspace, when the global stamp or any unit's entry is a day old or missing. Its explicit "check now" command adds `--force`; it outranks `updateCheck: false` and freshness but not `IA_NO_UPDATE_CHECK=1`, and `CI` does not stop it.

[User host tests](../../../apps/cli/tests/user-host.test.ts) and [briefing tests](../../../apps/cli/tests/briefing.test.ts) cover state reporting and command behavior. Live plugin activation in Claude Code needs separate evidence.

## 12 Plugin products

A Claude Code, Codex or Grok plugin directory lowers into a kit workspace with `ia init <directory> --from <plugin-directory>`. The kit is one system under `.ia/src/systems/<name>/` whose `records/plugin.ia` authors one product `@distribution`; its `product.hosts` lists the hosts the plugin ships to. Skill bodies, agent prompts and owned Markdown become pinned resources in `.ia/authoring.resources.json`, every other file becomes an asset under `assets/plugin/`, and `assets/lowering-map.json` gives every file and frontmatter key one disposition. Lowering accepts only what rendering writes back; anything else refuses with `IA-LOWER-UNRESOLVED` and writes nothing.

`ia project <claude|codex> --product plugin --out <directory>` renders that plugin, create-only, into an absent or empty directory outside the workspace, with a manifest for every listed host; it plans by default and writes with `--apply`. `--check` renders in memory, lowers the result again and requires a byte-exact fixed point; `--compare <plugin-directory>` also compares each file with the original. Neither writes. The [CLI contract](../../../apps/cli/SPEC.md#host-plugins) gives the lowering rules and the refusal codes, and [host-plugin tests](../../../apps/cli/tests/host-plugin.test.ts) pin the round trip on the public sample plugin.
