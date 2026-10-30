# @inventarch/cli

[![npm](https://img.shields.io/npm/v/@inventarch/cli?label=npm)](https://www.npmjs.com/package/@inventarch/cli) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json)

> `@inventarch/cli` is the `ia` command, the entry point to IA for people and coding agents. It creates workspaces, previews and authors records, validates and captures them, prints the position and delivery view an agent starts from, projects that position for Claude Code and Codex, turns a host plugin into a kit workspace and back, and installs native distributions.
>
> It bundles the language base, vocabulary catalogue and host payload its commands need, so `ia init` and `ia validate` run offline. The [MCP server](https://github.com/inventarch/ia/blob/main/apps/mcp-door/README.md) and the [runner](https://github.com/inventarch/ia/blob/main/apps/runner/README.md) are separate packages.

## ⚡ Quick start

Use **Node.js `>=22.22.0 <23`**. Install the CLI globally to make `ia` available in every project, including projects without a `package.json`:

```sh
npm install --global @inventarch/cli
ia --version
```

<details>
<summary>Prefer a project-local install for a JavaScript or TypeScript repository?</summary>

```sh
npm install --save-dev --save-exact @inventarch/cli
npx ia --version
```

Use `npx ia` wherever this guide uses `ia`, and commit your `package.json` and lockfile. With pnpm, use `pnpm add --save-dev --save-exact @inventarch/cli` and `pnpm exec ia`.

</details>

Then, in your project directory:

```sh
ia init . --host none                 # the plan; writes nothing
ia init . --host none --apply --yes   # install the bundled base, author the starter, capture
ia validate
ia position
```

Each project keeps its own records in its own `.ia/` directory. The [main quick start](https://github.com/inventarch/ia#-quick-start) continues with a first record, a plan and host setup. To run from a source checkout, build it as the [contributing section](https://github.com/inventarch/ia#-contributing-and-verification) describes and use `node /path/to/ia/apps/cli/dist/main.js` in place of `ia`.

## ⌨️ Commands

`ia --help` lists every command and `ia <command> --help` gives its full syntax. These rules hold across them:

- **Plan, then apply.** `init`, `install`, `adopt`, `update`, `remove`, `project` and `host` print a plan and act only with `--apply`, which needs `--yes` without a terminal or with `--json`. A plan applies nothing, though acquiring for an install or update plan may fill the archive cache. `restore` has no preview, so it always takes `--apply`.
- **One next command.** Every consumer-command refusal names the one command to run next, on the `→` line or as `next` in the `--json` object `{version, ok: false, code, message, exit, where, next}`.
- **One workspace.** `--root <path>` selects the workspace; by default it is the nearest ancestor holding `.ia/src`. `ia init` takes its directory as an argument instead. `--json` prints one JSON value, with no color, progress or prompts.

Automation should read the exit value together with the diagnostic code:

| Exit | Means |
| --- | --- |
| `0` | Success; warnings alone exit 0 |
| `1` | Validation errors, and refusals such as a mandate refusal or a stale `--digest` |
| `2` | Usage errors |
| `3` | Unavailable inputs and local operational refusals |
| `4` | `install`, `update` or `restore` could not reach or read a remote registry or archive |
| `130` | Interrupted |

### ✍️ Authoring and checking

| Command | What it does |
| --- | --- |
| `ia init [<directory>]` | Plans a workspace. `--apply` installs the bundled `inventarch/language` base, writes `.ia/src/workspace.ia` with three starter records (a `@workspace`, its participant `@agent` and that agent's `@mandate`), `.ia/.gitignore` and `.ia/release.json`, then captures. `--host claude` or `--host codex` also registers that host, as `ia host --apply` does. `--system` adds a local `@system` and `@distribution` so `ia pack` can release it. `--from <plugin-directory>` lowers a Claude, Codex or Grok plugin into the new workspace as a kit instead (see [host plugins](#-host-plugins)). `--migrate` moves a workspace an IA 1.0 or 1.1 `init` created to this layout. |
| `ia preview` | Shows what one new record, one field (`--set`) or one relationship (`--relate`) would compile to: the record before and after, the findings it adds and the target file's `sha256`. `ia preview <word>` prints a word's schema, default file and permitted relationships. It writes nothing. |
| `ia author` | Writes what the same preview showed. It takes the preview's arguments plus `--digest <sha256>`, writes only while the file still has that digest and the candidate is clean, and adds one `# authored-by` line naming the participant and mandate above the record. |
| `ia validate [<path>...]` | Admits the workspace and reports findings, with `--severity` and `--max-findings`. `--verify-conformance` also verifies COMP-KERNEL and COMP-FIXTURES in-process. It can record the checks that passed or failed as evidence under `.ia/work/evidence/`. |
| `ia capture` | Writes the admitted snapshot to `.ia/work/snapshot/current.json`, moves the prior capture at another revision to `previous.json`, and reports how many records changed, stayed, are new or were removed. `--preview` reports the same and writes nothing. |
| `ia format [<path>...]` | Checks formatting, or rewrites files with `--write`. |

```sh
ia preview decision
ia preview --set @plan public-api work.source=docs/api.md
ia author --set @plan public-api work.source=docs/api.md --digest <sha256-from-the-preview>
ia validate
ia capture --preview
ia capture
ia format
```

If the file changed since the preview, `ia author` refuses with `IA-CLI-EDIT-STALE` and names the preview to run again. `ia author` refuses the administrative words `workspace`, `agent`, `mandate`, `system`, `schema`, `agent-profile` and `hook` for every actor, with `IA-CLI-EDIT-AUTHORITY`: an owner changes those records in source and runs `ia validate`. You can also edit any `.ia` file by hand; `ia validate` checks it the same way. A capture with admission errors still writes its snapshot, records the findings in it and exits 1. A root whose `.ia/src` declares no `@workspace` is refused before anything is written. `.ia/.gitignore` keeps `work/` out of version control, so each clone captures for itself.

> [!IMPORTANT]
> **`ia compile` was removed in 3.0.** Every invocation, `--help` included, exits 2 and names `ia capture --help`. Use `ia capture`, keep `--preview`, `--json`, `--root` and `--actor` where you used them, and drop `--force`, since capture always writes. `--out` and `--stdout` have no equivalent: capture writes the fixed snapshot files above, not the 1.x `ia.compiled.v1` artifact. The `@inventarch/cli/internal/compile` helpers remain for programmatic callers.

### 🧭 Reading and navigating

| Command | What it does |
| --- | --- |
| `ia position` | Prints the position body for a scope key: `--seat <id\|path>`, `--shape` (`context`, `governance`, `execution`, `sequence` or `learning`), `--phase` (`orient`, `plan`, `act` or `learn`), `--depth` (0 to 2), `--budget` (0 to 64) and `--word`, plus optional `--primitive` (Memory, Attention, Inference, Decision, Escalation or Learning). The primitive defaults from shape; an explicit primitive supplies the default phase unless `--phase` is given. With no flag it prints the repository's `@workspace` with its pointers only. It needs no capture and writes nothing. |
| `ia next` | Prints one plan's delivery view: its milestones, then its tasks in prerequisite order, each with a verdict of `exit evidence recorded (…)`, `no declared blocker` or `blocked (…)`. `--seat` names a `@plan`, `@milestone` or `@task`; without it, the workspace's only `@plan`. |
| `ia read <locator>` | Prints the body behind a locator with its `sha256` and the line `body not certified by this read`. |
| `ia inspect [<identity>]` | Shows a workspace overview, or one record (by identity or `--path <file>`) with its edges, `--edges in\|out\|both` and `--depth` 0 to 3. |
| `ia vocabulary [<word>]` | Looks up the catalogue shipped with the package, with `--schema`, `--example`, `--domain`, `--kind` and `--search`. It opens no workspace. |

```sh
ia position
ia position --seat work-system/definition/task/write-schema --shape sequence
ia next
ia read work-system/definition/decision/api-response-format
ia read .ia/src/work.ia:12
ia inspect work-system/definition/task/review-schema
ia vocabulary decision --schema
```

`ia position` prints the key it used, whether the capture is current, the body's digest, the loaded records, pointers, rules and playbooks that apply, mandates, frontier and unknowns, and ends with two `ia position` commands that widen the view. `--word` narrows the loaded records and pointers to one word but never hides a blocking rule or a mandate. A shape, phase, depth or budget outside its set or cap exits 2 and names the same call with the set or cap. With `--json` it prints `{version, ok, body, digest, hostNote}`.

`ia next` computes each verdict from declared prerequisites and exit evidence: a success `@observation` on the task at its current digest. It prints `work.status` as self-declared and never uses it as the basis. In a workspace with no `@plan`, it names `ia preview plan`. The view ends with the `ia position` command for the next unblocked task.

`ia read` accepts four locators: a record identity, `<identity>#<phase>/<Primitive>` for a playbook cell, `<identity>#<REQ-ID>` for one requirement, and `<path>:<line>` for the record whose source spans that line. A record that names a document (`work.source` on a `@spec`, `@plan`, `@milestone`, `@task` or `@decision`, `reference.document` on an `@authoring-guide`, `template.resource` on a `@template`) reads that file, and a markdown anchor such as `docs/api.md#response-format` reads only that section. Any other record reads its `meaning.says`:

```text
Read  work-system/definition/decision/api-response-format

  •  record
     sha256 dae126797f0f…  44 bytes
     body not certified by this read

Choose a response format for the public API.
```

### 🔌 Hosts

| Command | What it does |
| --- | --- |
| `ia project <claude\|codex>` | Plans the position packet files for one host. `--apply` writes them and a receipt. It registers no MCP server. With `--product plugin` it renders the host plugin a lowered workspace describes instead (see [host plugins](#-host-plugins)). |
| `ia host <claude\|codex>` | Plans the host registration: the MCP server, the same projection and the skills generated from your authored `@playbook` records, plus, for Claude, the agents and edit guards generated from `@agent-profile` and `@hook` records. `--apply` writes it; `--remove` plans removing what it owns. `ia host claude --user` installs the public `ia@inventarch` plugin from `inventarch/marketplace`, which needs no workspace; `--local` renders it into the IA home instead. `ia host <claude\|codex\|copilot> --commit` writes the committable bootstrap. |
| `ia doctor` | Reports runtime, workspace, installation and host state, and suggests repairs without making them. `--host claude` or `--host codex` adds that host's session briefing. |

| Host | Position packet | Skill | MCP registration (`ia host` only) |
| --- | --- | --- | --- |
| Claude Code | `.claude/rules/ia-workspace.md` | `.claude/skills/ia-authoring/SKILL.md` | `.mcp.json` |
| Codex | `AGENTS.md` | `.agents/skills/ia-authoring/SKILL.md` | `.codex/config.toml` |

```sh
ia project claude
ia project claude --apply --yes
ia host codex
ia doctor
```

The receipt is `.ia/distributions/hosts/<host>-receipt.json`. `ia doctor` compares it with the files and with a fresh render, so an edited record shows as an `outdated` projection that names `ia project claude --apply`. A file IA did not write at one of these paths is named in the plan and refused by `--apply`. `ia host` treats what it writes as machine-local; do not commit those files. Instead, commit the bootstrap `ia host <host> --commit` writes instead: an instruction block that names `ia_session` and the lanes `ia:work`, `ia:knowledge` and `ia:delivery`, and an `ia` MCP server that runs `npx -y @inventarch/mcp-door@<this CLI's exact version>` from the project folder, with no machine-local path; `ia host copilot` takes only `--commit`. Codex reports generated agents and hooks as unsupported, and `ia host cursor` refuses with `IA-DIST-HOST-UNSUPPORTED`. The source-protection row of `ia doctor` warns when an authored `@mandate` declares a restriction but no authored `@hook` covers `.ia/src/**` for `Write`, `Edit` and `MultiEdit`. It never widens a hook's paths.

### 🧩 Host plugins

A Claude Code, Codex or Grok plugin directory can become a kit workspace, and that workspace renders the plugin back:

| Command | What it does |
| --- | --- |
| `ia init <directory> --from <plugin-directory>` | Plans a workspace that holds the plugin as a kit: the three starter records, a system named after the workspace, `records/plugin.ia` (the product `@distribution`, a `@capability` for each skill, and an `@agent`, a tools `@capability` and an `@agent-profile` for each agent), each skill body, agent prompt and owned Markdown file as a pinned resource, every other file as an asset, and a lowering map with a generated `MIGRATION.md`. `--apply` writes it. It takes `--id`, but not `--system`, `--migrate`, `--adopt` or the decline options. |
| `ia project <claude\|codex> --product plugin --out <directory>` | Plans the plugin the workspace's product `@distribution` describes, with a manifest for every host its `product.hosts` lists, into an absent or empty directory outside the workspace. `--apply` writes it, create-only. |
| `ia project <claude\|codex> --product plugin --check [--compare <plugin-directory>]` | Renders the plugin in memory, lowers it again and requires the result to match the workspace byte for byte. `--compare` also compares each rendered file with the original plugin. It writes nothing. |

```sh
ia init my-kit --from my-plugin
ia init my-kit --from my-plugin --apply --yes
ia project claude --product plugin --check --compare my-plugin --root my-kit
ia project claude --product plugin --out rendered --root my-kit --apply --yes
```

The example with `--compare` prints `Round trip: content-exact and a fixed point.` Lowering accepts only what rendering writes back: hooks, MCP and LSP configuration, `commands/`, and frontmatter or manifest forms the renderer would not reproduce are refused with `IA-LOWER-UNRESOLVED`, which counts and names them, and nothing is written. A drifted round trip fails with `IA-ROUNDTRIP-DRIFT`; `--json` carries the full report in `details`. The kit's release descriptor keeps the `UNLICENSED` license whatever the plugin's manifest states. The rules are in the [package contract](SPEC.md#host-plugins).

### 📦 Distributions

| Command | What it does |
| --- | --- |
| `ia pack --descriptor <file>` | Builds a digest-named archive, by default under `.ia/work/dist`. A descriptor that names no distribution, as a default `init` writes, is refused; `ia init --system` authors one. |
| `ia install <id>[@<range>]...` | Plans an installation, kits included, from a registry, a `--catalog` or the `--offline` cache. |
| `ia adopt <id>[@version]` | Plans a source-only workspace adoption: pinned source mounted at band 50, then a capture and a refresh of registered projections. `ia init --adopt` adopts at initialization. |
| `ia update <id>` | Plans a version change for one direct request, `--to <range>`. |
| `ia remove <id>` | Plans the removal of one direct request. |
| `ia restore --apply` | Reinstalls the locked generation from its pinned archives. |
| `ia recover [installation\|host\|guard\|lifecycle] --root <directory>` | Finishes or rolls back an interrupted installation or host transaction. |

```sh
ia restore --apply --yes
ia update inventarch/language --offline
ia init my-lib --system --host none --apply --yes
ia pack --root my-lib --descriptor .ia/release.json
ia recover --root .
```

`.ia/.gitignore` keeps `.ia/distributions/` out of version control, so commands in a fresh clone refuse until `ia restore --apply --yes` rebuilds it from `.ia/distributions.lock.json`. `--plan-out <file>` saves an install, update or remove plan under `.ia/work/`. A refusal that needs recovery names `ia recover … --root <directory>`, which runs the distribution recovery directly, so a global install needs no `ia-distribution` binary on `PATH`. Native package ids, such as `inventarch/language`, are separate from npm package names. Native archives align with the npm target at a new major; within that major, their versions follow changed content and exact native dependencies, so they need not equal the CLI version. IA syntax remains 1.0.

### 📚 Knowledge

`ia kb` reads admitted records and their bound Markdown/text documents through an in-memory view. Local reads need no `.kb` directory or persistent index. An optional `.ia/knowledge.json` limits the selection; exports require an explicit selector committed with the selected records and documents.

```sh
ia kb check --root . --json
ia kb search "response format" --root . --json
ia kb read work-system/definition/decision/api-response-format --root . --json
```

`resolve` checks a citation and `traverse` follows native relationships. `ia kb pack --commit <full-sha> --selection .ia/knowledge.json --out knowledge.json` previews a committed export; add `--apply --yes` to write it. Existing identical output is unchanged; different bytes refuse. Read commands require Observation, check and pack preview require Verification, and applied pack requires Execution. Every subcommand supports `--actor`. See the [knowledge guide](https://github.com/inventarch/ia/blob/main/packages/kb/README.md) for selectors, citations, bounds and foundation ownership.

### 🤖 Machine protocol

`scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse` and `report` are frozen operations for programs. Each takes JSON through `--params <JSON>`, or `--params -` for stdin, and prints one JSON line with no color. `ia <operation> --help` lists its parameters, refusals and an example, and `ia <operation> --schema` prints its parameter schema.

```sh
ia search --params '{"text":"response"}'
echo '{"identity":"work-system/definition/task/write-schema"}' | ia get --params -
ia report --params '{}'
ia get --schema
```

A scope token lasts one invocation, and a failed operation prints its own one-line JSON with no `next`. Only the CLI serves `report`; the [MCP server](https://github.com/inventarch/ia/blob/main/apps/mcp-door/README.md) serves the other read operations as tools.

## 🪪 Mandates and `--actor`

Core commands and the KB subcommands are judged against the acting participant's `@mandate` records before they run:

| Move the mandate must grant | Commands |
| --- | --- |
| Observation | `ia read`, `ia next`, `ia kb search/read/resolve/traverse` |
| Verification | `ia validate`, `ia preview`, `ia kb check` and pack preview |
| Synthesis | `ia author` |
| Execution | `ia capture`, `ia project`, `ia kb pack --apply`, and a workspace `ia host <host> --apply` |

`ia preview` and `ia author` also check the record's word and the target path. Nothing else is judged: `ia position`, `ia inspect`, `ia init`, an `ia host` plan, `ia host --remove`, `ia host claude --user` and the machine protocol run whatever the mandates say, so the position a refusal names always runs. With a mandate that allows only Observation:

```text
✖  (whole workspace)
   agent-system/policy/mandate/my-project-mandate
   IA-RUNTIME-MANDATE-MOVE  agent-system/policy/mandate/my-project-mandate
   allows Observation; validate needs Verification
   →  Run
      "ia position --seat agent-system/policy/mandate/my-project-mandate --shape governance"
      for the mandates that govern here and what they allow.
```

Each judged command takes `--actor <agent>`, as an identity, `@agent <name>` or a bare name. It must name an authored participant of the workspace or its steward; without it the actor is the steward, or the workspace's one participant. That participant's own mandates then apply. A `@mandate` that fails admission, including one stating `authority.moves []`, closes every judged command until it is corrected by hand, and the refusal names `ia report` for the findings.

Mandates are cooperative restrictions, not authentication or a sandbox. Anyone who can edit `.ia/src` can change them, and `--actor` is a local declaration: naming a participant with looser mandates lifts a restriction for that invocation.

## ⚖️ What it does not do

- **It does not authenticate or isolate.** A mandate narrows what IA's commands do; it grants no host permission, and `--actor` proves no identity.
- **It does not certify content.** Admission means the records conform and resolve, not that they are true or complete. `ia read` never certifies a body, and a `not-evaluated` check is never a pass.
- **It does not execute what records name.** `ia validate` reports each `@execution-binding` as bound, unavailable or revoked without running it, and the machine operations invoke no model.
- **It does not repair.** `ia doctor` observes and suggests. It reports a host registration as written, never as a server it saw answering.
- **It does not edit authority through `ia author`.** An owner changes administrative records in source and validates them.
- **It needs no account or hosted service.** Initialization and validation run offline; `ia read` never fetches a URL.

## 📚 Learn more

- [Package contract](SPEC.md): every command's behavior, refusals and JSON shapes
- [Packaged language summary](LANGUAGE.md): the words this package ships
- [IA README](https://github.com/inventarch/ia/blob/main/README.md): the quick start, concepts and what a result means
- [Consumer CLI contract](https://github.com/inventarch/ia/blob/main/docs/specs/consumer-cli-contract/README.md): grammar, dispatch and refusal rules
- [Language guide](https://github.com/inventarch/ia/blob/main/docs/reference/language/README.md): native syntax, relationships and evaluation limits
- [Architecture reference](https://github.com/inventarch/ia/blob/main/docs/reference/architecture/README.md): which package to use for what
- [Changelog](https://github.com/inventarch/ia/blob/main/CHANGELOG.md): what changed in each release, including upgrading from 2.x
