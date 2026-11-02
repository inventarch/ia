# 🌳 IA · the open InventArch language and toolchain

[![Release](https://img.shields.io/npm/v/@inventarch/cli?label=release)](https://github.com/inventarch/ia/releases/latest) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-12.9.0-f69220)](package.json) [![Vocabulary](https://img.shields.io/badge/vocabulary-44%20words-blue)](docs/reference/language/vocabulary.md)

> **IA** keeps a repository's decisions, requirements, plans, rules and agent authority as typed, linked records in plain-text `.ia` files beside the code. The `ia` CLI checks every record against a shared vocabulary and resolves every reference. Coding agents start from the same records: IA turns them into a bounded starting context, a task order and a write path that records the participant and mandate each write was declared under.
>
> This is the **public IA repository**: the language, its vocabulary and schemas, the CLI, a local runtime and runner, an MCP server, host adapters, a VS Code extension and worked examples. It is licensed under Apache-2.0 and needs no account, hosted service or private package.

## Why IA

- **One source for people and agents.** The same records drive validation, editor diagnostics, the MCP server and the context Claude Code or Codex reads before acting.
- **Agents start from a position.** `ia position` returns a deterministic, budgeted view of a seat: the records it rests on, the rules that apply, the mandates in force, and what is still unknown. `ia next` orders a plan's tasks by their declared prerequisites and gives each a verdict from recorded evidence.
- **Authority you can read.** A `@mandate` states which moves a participant may make and where. IA's mandate-checked commands refuse a move it does not grant, and `ia author` writes a clean record only if the target file still matches the digest `ia preview` reported.
- **Honest results.** Admission is not execution. A check with no evaluator reports `not-evaluated`, which is never a pass. A record that names an implementation never installs it or grants its effects.
- **Open and method-neutral.** Everything here runs locally, and initialization and validation need no network connection. You can define your own words, systems, workspaces and methods with the same public contracts IA uses for its own vocabulary.

> [!NOTE]
> **IA 3.3** adds reusable knowledge packages and bounded local readers through `ia kb` and five MCP tools. Database and editor readers can opt into kernel and fixture conformance verification. Position requests can select a primitive explicitly, and the shipped authoring guides and native operation cases are expanded. See the [knowledge guide](packages/kb/README.md) and [database guide](packages/db/README.md) for the APIs and their limits.
>
> **IA 3.2** lets a host make every durable session write pass its own admission check, so authority revoked mid-run refuses the write. Registry and archive downloads accept only credential-free HTTPS URLs, and the vocabulary, the shipped guides and `ia doctor` correct several descriptions and repairs. Native archives are now versioned by content within a major: this release moves them to 3.1.2.
>
> **IA 3.1** turns a Claude Code, Codex or Grok plugin into a kit workspace (`ia init --from`) and renders the workspace back into the plugin (`ia project --product plugin`), with a check that the round trip is exact. [`@inventarch/compliance`](packages/compliance/README.md) can now produce its own kernel and fixture conformance evidence, on request.
>
> **IA 3.0** added a governed write path (`ia preview`, then `ia author`), commands checked against the acting participant's mandates, check bindings whose passes and failures `ia validate` records as evidence, host agents, skills and hook guards generated from authored records, registry kits, source-only workspace adoption (`ia adopt`) and the local `ia-runner`.

> [!IMPORTANT]
> **Upgrading from 2.x.** `ia compile` is removed; use `ia capture`. `ia read`, `next`, `validate`, `preview`, `author`, `capture`, `project` and a workspace `host --apply` now refuse when the acting participant's mandates do not grant the move, and a `@mandate` that fails admission, including one stating `authority.moves []`, closes all of them. `ia validate` can write evidence under `.ia/work/evidence/`, so a CI job needs a writable `.ia/work`. The first applied `init`, `install` or `update` moves the workspace lock to a distribution engine the 2.x CLI cannot read, so commit or back up `.ia/` first. Read the [3.0.0 changelog](CHANGELOG.md#300) before upgrading.

---

## ⚡ Quick start

### 1. Install the CLI

Use **Node.js `>=22.22.0 <23`**. Install [`@inventarch/cli`](https://www.npmjs.com/package/@inventarch/cli) globally to make the `ia` command available in every project, including projects without a `package.json`:

```sh
npm install --global @inventarch/cli
ia --version
```

The quick start needs IA 3.0 or later. Each project keeps its own records in its own `.ia/` directory, wherever the CLI is installed.

<details>
<summary>Prefer a project-local install for a JavaScript or TypeScript repository?</summary>

From that repository, install the CLI as a development dependency so your team shares a pinned version:

```sh
npm install --save-dev --save-exact @inventarch/cli
npx ia --version
```

Use `npx ia` wherever the examples below use `ia`, and commit your `package.json` and lockfile. With pnpm, use `pnpm add --save-dev --save-exact @inventarch/cli` and `pnpm exec ia`.

</details>

To run IA from a source checkout instead, see [contributing and verification](#-contributing-and-verification).

### 2. Initialize your project

In an existing project directory, preview the setup, then apply it:

```sh
cd path/to/your-project
ia init . --id local/my-project --host none
ia init . --id local/my-project --host none --apply --yes
```

Choose your own `local/my-project` identity; its final component names your workspace. The first command writes nothing and lists what it would create. The second installs the language definitions bundled with the CLI, authors three starter records and captures the workspace:

```text
.ia/
├── .gitignore               # Keeps work/ and distributions/, which each clone rebuilds, out of version control
├── distributions.lock.json  # Direct requests and the versions they resolved to
├── release.json             # The release descriptor
└── src/
    └── workspace.ia         # @workspace my-project, its participant @agent my-project and @mandate my-project-mandate
```

The `@workspace` composes the eleven public systems, so records anywhere under `.ia/src/` can use their words without further setup. The participant `@agent` is the IDE agent working in this repository, whatever its vendor, and its `@mandate` allows it five moves (Observation, Verification, Synthesis, Delegation and Execution) within this workspace. The mandate claims no host permission; it tells IA's tools what this participant may do.

Keep your own `.ia` files anywhere under `.ia/src/` except `.ia/src/floor/` and `.ia/src/systems/`; a record's word decides which system owns it. To start in a new folder, run `ia init my-project --host none --apply --yes` from its parent. Add `--system` if the repository will publish vocabulary of its own. A workspace created by IA 1.0 or 1.1 moves to this layout with `ia init . --migrate`, then `ia init . --migrate --apply --yes`.

### 3. Author your first record

Ask IA what a word needs, then preview a record:

```sh
ia preview decision

ia preview decision api-response-format \
  "meaning.says=Choose a response format for the public API." \
  "work.title=API response format" \
  "work.status=made" \
  "decision.question=Which response format will clients consume?" \
  "decision.choice=JSON" \
  "decision.rationale=Our clients already use JSON."
```

The first command prints the word's schema, its default file and the relationships it may hold. The second writes nothing. It shows the record, the findings it would add and the target file's current `sha256`. When the candidate is clean, run `ia author` with the same arguments plus `--digest <sha256>` copied from the preview. `ia author` writes only if that file is unchanged, and it adds one attribution line above the record:

```ia
#! ia 1.0

# authored-by @agent my-project under @mandate my-project-mandate at 2f80a917…
@decision api-response-format
  meaning
    says "Choose a response format for the public API."
  work
    title "API response format"
    status made
  decision
    question "Which response format will clients consume?"
    choice "JSON"
    rationale "Our clients already use JSON."
```

`@decision` selects the record type and `api-response-format` names the record. Other records refer to it as `@decision api-response-format`. You can also write `.ia` files by hand; `ia validate` checks them the same way. `ia preview --set` and `ia preview --relate` preview a change to one field or one relationship of an existing record.

### 4. Check it

```sh
ia validate
ia inspect --path .ia/src/decision.ia
ia read work-system/definition/decision/api-response-format
ia vocabulary decision --schema
```

Look for **Admitted** and **0 errors**. A new workspace also reports two `IA-COMP-NOT-EVALUATED` warnings, `COMP-KERNEL` and `COMP-FIXTURES`, because no verification evidence was supplied for those checks. A `not-evaluated` result is neither a pass nor a failure.

Change `status made` to `status finished` and validate again: IA refuses the workspace with `IA-COMP-FIELD-VALUE` at the record's `work.status`. Restore `made` to return to zero errors. `inspect` shows the admitted record and its edges, `read` prints the body behind an identity with its digest, and `vocabulary` shows a word's fields and permitted values.

### 5. Plan work and ask what comes next

Add `.ia/src/work.ia`:

```ia
#! ia 1.0

@plan public-api
  meaning
    says "Ship the first version of the public API."
  work
    title "Public API v1"
    status open

@milestone api-contract
  meaning
    says "The API contract is agreed and documented."
  work
    title "API contract agreed"
    status open
    plan @plan public-api
    exit "The response schema is documented and reviewed."
  relationships
    requires @decision api-response-format

@task write-schema
  meaning
    says "Write the JSON response schema."
  work
    title "Write the response schema"
    status open
    milestone @milestone api-contract

@task review-schema
  meaning
    says "Review the response schema with a client team."
  work
    title "Review the response schema"
    status open
    milestone @milestone api-contract
  relationships
    requires @task write-schema
```

Then run `ia next` (output shortened; `…` marks omitted lines):

```text
Plan  work-system/definition/plan/public-api      revision …

  •  0 of 2 tasks have exit evidence; next:
     work-system/definition/task/write-schema, with no declared blocker

Milestones
  ▲  work-system/definition/milestone/api-contract
     not satisfied: exit evidence missing for 2 of 2 tasks
     status open (self-declared)

Tasks
  •  work-system/definition/task/write-schema
     no declared blocker
     status open (self-declared)
     requires decision work-system/definition/decision/api-response-format:
     choice made (via work-system/definition/milestone/api-contract)
     …

  ▲  work-system/definition/task/review-schema
     blocked (task work-system/definition/task/write-schema: no exit evidence)
     …
```

`ia next` computes each task's verdict from its declared prerequisites and exit evidence, which is a success `@observation` on the task at its current digest. It shows `work.status` but never uses it as the basis. An `@observation` is a record too, and `ia next` names it and its evaluator when one was recorded; evidence a participant records for its own task is not an independent review. The view ends with the `ia position` command for the next unblocked task.

### 6. Connect your agent host

Host registration is optional. Preview it, then rerun the same command with `--apply --yes`:

| Use with | Start here |
| --- | --- |
| **Claude Code** | `ia host claude` registers the MCP server and writes the position packet (`.claude/rules/ia-workspace.md`), the `ia-authoring` skill, and the agents, skills and edit guards generated from your authored `@agent-profile`, playbook and `@hook` records. |
| **Codex** | `ia host codex` registers the MCP server in `.codex/config.toml` and writes the position packet (`AGENTS.md`), the `ia-authoring` skill and skills generated from authored records. It reports generated agents and hooks as unsupported. |
| **Packet files only** | `ia project claude` or `ia project codex` writes the position packet and skill without registering an MCP server. |
| **GitHub Copilot** | `ia host copilot --commit` writes the committed bootstrap: `.github/copilot-instructions.md`, `AGENTS.md`, `.vscode/mcp.json` and `.github/mcp.json`. |
| **Any MCP client** | `ia-mcp-door --root .`, from [`@inventarch/mcp-door`](apps/mcp-door/README.md), serves seventeen read-only tools over stdio, including `ia_position`, `ia_next` and `ia_read`, and the method tools `ia_session`, `ia_catalogue` and `ia_method`. |

Every plan lists the files it will create, update or retire. `ia host` treats the files it writes as machine-local; do not commit them. To let a fresh clone or a cloud agent reach IA, commit the bootstrap `ia host <host> --commit` writes instead: an instruction block that names `ia_session` and the lanes `ia:work`, `ia:knowledge` and `ia:delivery`, and an `ia` MCP server that runs `npx -y @inventarch/mcp-door@<this CLI's exact version>` from the project folder, with no machine-local path. `ia doctor` compares the installed projection with a fresh render, so an edited record shows up as an outdated projection.

### 7. Add the VS Code extension

1. Download the `inventarch-ia-<version>.vsix` asset from the [latest release](https://github.com/inventarch/ia/releases/latest).
2. In **VS Code 1.138.0 or later**, run **Extensions: Install from VSIX…** from the Command Palette and select the file.
3. Open your project and `.ia/src/decision.ia`. IA Language provides completion, hover information, navigation, references, formatting and diagnostics in the Problems panel.

The extension analyzes files locally, without an account or hosted service. See the [extension guide](apps/vscode/README.md).

### What can I author next?

| Capture | Record types | Start here |
| --- | --- | --- |
| Project work and decisions | `@plan`, `@milestone`, `@task`, `@decision`, `@spec` | [Work example](examples/public-language/records/work.ia) |
| Agents and their authority | `@agent`, `@mandate` | The three records `ia init` writes; [agent](docs/reference/language/vocabulary.md#agent) and [mandate](docs/reference/language/vocabulary.md#mandate) fields |
| Project rules and procedures | `@principle`, `@law`, `@convention`, `@playbook` | [Governance vocabulary](docs/reference/language/vocabulary.md#convention) |
| Requirements, checks and evidence | `@contract`, `@check`, `@case`, `@observation` | [Quality example](examples/public-language/records/quality.ia) · [evidence example](examples/public-language/records/evidence.ia) |
| Agent composition and host behavior | `@capability`, `@agent-profile`, `@harness`, `@execution-binding`, `@hook` | [Composition example](examples/public-language/records/composition.ia) |
| Reusable output and learning | `@template`, `@improvement` | [Template fields](docs/reference/language/vocabulary.md#template) · [improvement fields](docs/reference/language/vocabulary.md#improvement) |

`ia preview <word>` prints any word's schema, default file and permitted relationships in the terminal. The [vocabulary catalogue](docs/reference/language/vocabulary.md) names each word's owner and schema, and the [language guide](docs/reference/language/README.md) covers syntax, relationships and defining your own vocabulary. Records inside a `--system` folder may use only the words of systems listed in that folder's `system.ia` `requires`.

---

## 🧭 How IA fits together

| Concept | What it is |
| --- | --- |
| **Record** | One `@word name` block in a `.ia` file. Its word selects a canonical schema and its owning system, so `@decision api-response-format` becomes `work-system/definition/decision/api-response-format`. |
| **Word and system** | The public vocabulary has 44 words. Eleven systems own 28 domain words; the language floor defines the other 16, `@system`, `@schema` and fourteen taxonomy words such as `@kind` and `@phase`. Each system names a steward accountable for its words, schemas and permitted relationships. |
| **Workspace** | A `@workspace` composes systems and declares its authored sources. It grants no account or filesystem permission and need not define vocabulary of its own. |
| **Participant and mandate** | An `@agent` acts under the `@mandate` records that govern it: its moves, the workspaces they apply in, and optional excluded words, covered paths and execution limits. IA's mandate-checked commands and the generated edit guard apply them as cooperative restrictions. They are not authentication or a sandbox: anyone who can edit `.ia/src` can change them. |
| **Position** | `ia position` returns the body for a scope key of seat, shape, phase, depth, budget and word, with optional explicit primitive selection. The body is a pure function of the key and the admitted records, with a digest, so two agents asking the same question read the same context. |
| **Projection** | `ia project` and `ia host` render the position packet, the `ia-authoring` skill and the agents and skills generated from authored records, with a receipt that `ia doctor` checks. Only `ia host` registers the MCP server and the hook groups. |
| **Evidence** | `ia validate` binds each `@check` to its evaluator, built in or from the installed catalog, and records the ones that passed or failed as `@observation` evidence under `.ia/work/evidence/`. Evidence never changes the authored revision. |
| **Distribution and kit** | `ia pack` builds digest-named archives with pinned closures; `ia install` resolves and installs them, including kits that group several requests. `ia adopt` mounts a pinned, source-only workspace from a registry directory or URL you name with `--registry` or configure. `ia init --from` turns an existing Claude Code, Codex or Grok plugin into a kit workspace, and `ia project --product plugin` renders it back. |
| **Runner** | `ia-runner`, from [`@inventarch/runner`](apps/runner/README.md), runs one admitted agent profile with bounded local execution and a durable journal. It selects no model provider and creates no credentials. |

---

## 🤖 For coding agents

In any IA workspace:

1. **Start with `ia position`.** If a command refuses, run the one command the refusal names. No mandate gates `ia position`, so the position a refusal points to always runs.
2. **State intent as a scope key**, not free text: a shape (`context`, `governance`, `execution`, `sequence` or `learning`), an optional phase (`orient`, `plan`, `act` or `learn`), a seat and a word. When a word belongs to another system, re-seat at that system to reach its steward.
3. **Write through the governed path.** Use `ia preview`, then `ia author --digest`, or edit source and run `ia validate`. Changes to `workspace`, `agent`, `mandate`, `system`, `schema`, `agent-profile` and `hook` records are owner edits in source; `ia author` refuses them.
4. **Report what actually ran.** Name each check and the environment it exercised. `not-evaluated` is not a pass, and a declared test is not an executed one.

In this checkout, [SPEC.md](SPEC.md) owns the repository and every package, app and native system has a colocated `SPEC.md`. Native declarations live under `.ia/src/`. [CLAUDE.md](CLAUDE.md), this repository's position packet, the vocabulary pages, the authoring resources and the `ia-authoring` skills are generated; edit their sources and regenerate, and the matching `*:check` command detects drift.

---

## ⚖️ What a result means

IA keeps declared, checked, executed and authorized apart. Read each result for what it establishes:

| Question | What answers it |
| --- | --- |
| Do the records conform to the language, and do their references resolve? | `ia validate` reports **Admitted** with **0 errors**. |
| Are the records true and complete? | Not admission. A shared vocabulary makes records structurally interoperable; it does not establish that their prose is true, that their evidence is genuine or that nothing is missing. |
| Was a requirement evaluated? | A bound evaluator's pass or fail, recorded as evidence. With no evaluator the result stays `not-evaluated`. |
| Is an implementation available? | `ia validate` reports each `@execution-binding` as bound, unavailable or revoked against the installed implementation catalog. Naming one never installs it. |
| Is a hook active? | The host registration and its receipt, as `ia doctor` reports them. A `@hook` record is a declaration. |
| May this agent act? | The host's own authentication and permissions. A `@mandate` narrows what IA's tools will do; it never grants a host permission. |
| Is the architecture good? | Not IA. Conformance is not a design review; your own methods, contracts and evaluators decide what good means. |

---

## 🔓 Open by design

Every IA component is in this repository: the language and its kernel, the vocabulary and canonical schemas, authoring and validation, workspace composition, distribution packing and installation, a generic local runtime and runner, neutral host adapters for Claude Code and Codex, an MCP server and a VS Code extension. Its 24 npm packages and the extension are all licensed under Apache-2.0.

IA is method-neutral. It defines what records mean, how they compose and what a result does and does not establish. It ships no curated design method, expert agent team or quality rubric. You write those yourself, as words, playbooks, contracts, checks and agent profiles in your own systems, then package them as distributions or kits that can be public or private. IA handles them the same way either way.

---

## 📦 What is in the repository

| Folder | Holds | Start at |
| --- | --- | --- |
| `packages/` | Compiler, graph, compliance, database, runtimes and service contracts | [Packages](#-packages) |
| `apps/` | CLI, MCP server, runner, edit-guard hook, distribution tooling and VS Code extension | [Apps](#%EF%B8%8F-apps) |
| `.ia/src/floor/` | The closed language kernel: domains, predicate pairs and routing vocabulary | [Kernel README](.ia/src/floor/README.md) · [contract](.ia/src/floor/SPEC.md) |
| `.ia/src/systems/` | The eleven public vocabulary owners, their canonical schemas and system implementations | [Native systems](#-native-systems) |
| `docs/` | Language reference, vocabulary catalogue, architecture and package references, and implemented specifications | [Documentation map](#-documentation-map) |
| `examples/` | Authoring examples and executable conformance fixtures | [Public-language examples](examples/public-language/README.md) |
| `distributions/` | The optional product-structure distribution | [Distribution README](distributions/product-structure/README.md) |
| `releases/`, `tools/` | Release inputs, and the build, generation, documentation and qualification tools | [Release process](releases/README.md) · [repository contract](SPEC.md) |

### 🧱 Packages

| Package | Role |
| --- | --- |
| [`@inventarch/language`](packages/language/SPEC.md) | Parsing, registration, compilation, kernel generation, formatting and single-record editing |
| [`@inventarch/graph`](packages/graph/SPEC.md) | Typed graph, identity resolution, queries, revisions and the canonical digest codec |
| [`@inventarch/compliance`](packages/compliance/SPEC.md) | Schema checks, contract assessment with supplied evaluators, and explicit refusals |
| [`@inventarch/db`](packages/db/SPEC.md) | Workspace readers, scoped views, cache, preview, adoption, check bindings and evidence |
| [`@inventarch/kb`](packages/kb/SPEC.md) | Selected knowledge packages, bounded record and document reads, search, relationships and citations |
| [`@inventarch/runtime`](packages/runtime/SPEC.md) | Position and delivery views, mandate resolution, host packets and the Door machine protocol |
| [`@inventarch/workspace-runtime`](packages/workspace-runtime/SPEC.md) | Capture, adoption, teaching resources, lifecycle, templates, publication, operation binding and host-artifact generation |
| [`@inventarch/service-contracts`](packages/service-contracts/SPEC.md) | Browser-safe service wire contracts and structural validation |

Each of the eleven native systems also publishes its own package. Five of them carry executable implementations: [agents](.ia/src/systems/agent-system/SPEC.md), [composition](.ia/src/systems/agent-composition-system/SPEC.md), [authoring](.ia/src/systems/authoring-system/SPEC.md), [sessions](.ia/src/systems/session-system/SPEC.md) and [templates](.ia/src/systems/template-system/SPEC.md). The [architecture reference](docs/reference/architecture/README.md) explains which package to use for what.

### 🛠️ Apps

| App | Role |
| --- | --- |
| [`cli`](apps/cli/SPEC.md) | The `ia` binary: workspace, authoring, position, distribution and host commands, and the machine protocol |
| [`mcp-door`](apps/mcp-door/SPEC.md) | `ia-mcp-door`, a local stdio MCP server for scoped, read-only access to one workspace |
| [`runner`](apps/runner/SPEC.md) | `ia-runner`, bounded local execution of an admitted agent profile with a durable journal |
| [`steward-hook`](apps/steward-hook/SPEC.md) | The host edit guard, keyed to the `@mandate` that governs each path, and projection protection |
| [`distribution`](apps/distribution/SPEC.md) | `ia-distribution`: packing, installation, adoption, recovery and host registration |
| [`vscode`](apps/vscode/SPEC.md) | Diagnostics, completion, navigation, highlighting and formatting for `.ia` files |

### 🧬 Native systems

The [language floor](.ia/src/floor/README.md) supplies the kernel. These systems own the public vocabulary built on it; each link leads to its contract.

<table>
<tr><th colspan="3" align="left">🧱 Foundation</th></tr>
<tr><td width="33%" valign="top"><b>🪪 <a href=".ia/src/systems/agent-system/SPEC.md">agent-system</a></b><br><sub>Agents and bounded mandates</sub></td><td width="33%" valign="top"><b>✅ <a href=".ia/src/systems/compliance-system/SPEC.md">compliance-system</a></b><br><sub>Contracts, checks and cases</sub></td><td width="33%" valign="top"><b>🗂️ <a href=".ia/src/systems/workspace-system/SPEC.md">workspace-system</a></b><br><sub>Workspace boundaries and distributions</sub></td></tr>
<tr><td width="33%" valign="top"><b>⚖️ <a href=".ia/src/systems/governance-system/SPEC.md">governance-system</a></b><br><sub>Rules and contextual playbooks</sub></td><td width="33%" valign="top"><b>📜 <a href=".ia/src/systems/session-system/SPEC.md">session-system</a></b><br><sub>Runs, session journal and replay</sub></td><td></td></tr>
<tr><th colspan="3" align="left">✍️ Authoring</th></tr>
<tr><td width="33%" valign="top"><b>✍️ <a href=".ia/src/systems/authoring-system/SPEC.md">authoring-system</a></b><br><sub>Authoring operations and contextual validation</sub></td><td width="33%" valign="top"><b>🪝 <a href=".ia/src/systems/hook-authoring-system/SPEC.md">hook-authoring-system</a></b><br><sub>Hook declarations and event bindings</sub></td><td width="33%" valign="top"><b>🧩 <a href=".ia/src/systems/template-system/SPEC.md">template-system</a></b><br><sub>Templates and bounded artifact rendering</sub></td></tr>
<tr><th colspan="3" align="left">🧠 Composition, work and learning</th></tr>
<tr><td width="33%" valign="top"><b>🧠 <a href=".ia/src/systems/agent-composition-system/SPEC.md">agent-composition-system</a></b><br><sub>Capabilities, profiles, harnesses and execution bindings</sub></td><td width="33%" valign="top"><b>📋 <a href=".ia/src/systems/work-system/SPEC.md">work-system</a></b><br><sub>Plans, milestones, tasks, decisions and specs</sub></td><td width="33%" valign="top"><b>🌱 <a href=".ia/src/systems/learning-system/SPEC.md">learning-system</a></b><br><sub>Observations and proposed improvements</sub></td></tr>
</table>

---

## ⌨️ Commands

| Work with | Commands |
| --- | --- |
| **Authoring and checking** | `init`, `preview`, `author`, `validate`, `capture`, `format` |
| **Reading and navigating** | `position`, `next`, `read`, `inspect`, `vocabulary` |
| **Knowledge** | `kb check`, `kb search`, `kb read`, `kb resolve`, `kb traverse`, `kb pack` |
| **Hosts** | `project`, `host`, `doctor` |
| **Distributions** | `pack`, `install`, `adopt`, `update`, `remove`, `restore`, `recover` |
| **Machine protocol** | `scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse`, `report`: frozen, JSON in through `--params`, one JSON line out |

`init`, `install`, `adopt`, `update`, `remove`, `project` and `host` show a plan and act only with `--apply`, plus `--yes` without a terminal; `restore` also needs `--apply` but has no preview yet. The other commands that write say so in their flags: `ia author` writes after checking `--digest`, `ia capture` writes its snapshot unless given `--preview`, `ia format --write` rewrites files, `ia pack` writes an archive, `ia recover` repairs an interrupted transaction, and `ia validate` can record check evidence under `.ia/work/evidence/`.

`ia init <directory> --from <plugin-directory>` lowers a host plugin into a kit workspace, and `ia project <claude|codex> --product plugin` renders that kit back into a plugin (`--out`) or checks the round trip without writing (`--check`).

`--json` returns one structured value, and every consumer-command refusal names the one command to run next. `read`, `next`, `validate`, `preview`, `author`, `capture`, `project`, all `kb` subcommands and a workspace `host --apply` (not `--remove` or `--user`) are checked against the acting participant's mandates; `--actor <agent>` names which authored participant is acting. `ia --help` and `ia <command> --help` give the full syntax, and the [CLI guide](apps/cli/README.md) and [consumer CLI contract](docs/specs/consumer-cli-contract/README.md) give the detail.

---

## 📚 Documentation map

| Read for | Start at |
| --- | --- |
| **Language and identity** | [Language guide](docs/reference/language/README.md) · [language contract](docs/reference/language/SPEC.md) |
| **Words, fields and relationships** | [Vocabulary catalogue](docs/reference/language/vocabulary.md) · [machine-readable catalogue](docs/reference/language/vocabulary.json) |
| **Packages, ownership and enforcement** | [Architecture reference](docs/reference/architecture/README.md) · [package reference](docs/reference/packages/README.md) |
| **Command and host behavior** | [Implemented specifications](docs/specs/README.md) · [CLI guide](apps/cli/README.md) · [MCP server](apps/mcp-door/README.md) · [runner](apps/runner/README.md) · [VS Code extension](apps/vscode/README.md) |
| **Worked examples** | [Public-language examples](examples/public-language/README.md) · [conformance fixtures](examples/conformance/SPEC.md) |
| **Reusable knowledge** | [Knowledge guide](packages/kb/README.md) · [worked knowledge example](examples/knowledge/README.md) |
| **Changing this repository** | [Contributing guide](CONTRIBUTING.md) · [repository contract](SPEC.md) and the nearest package or system `SPEC.md` |
| **Releases** | [Latest release](https://github.com/inventarch/ia/releases/latest) · [changelog](CHANGELOG.md) · [release process](releases/README.md) · [CI results](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) |
| **Help and security** | [Support](SUPPORT.md) · [security policy](SECURITY.md) · [code of conduct](CODE_OF_CONDUCT.md) |

---

## ✅ Contributing and verification

Read the [contributing guide](CONTRIBUTING.md), the [repository contract](SPEC.md) and the nearest owner contract before changing behavior. Run focused checks while working; `pnpm platform:qualify` is the repository qualification entry point. All commands below are root [package.json](package.json) scripts.

To build this repository, use Node.js `>=22.22.0 <23` and the pnpm version pinned in `packageManager` (currently `12.9.0`):

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/main.js --version
```

To use that build in another project, substitute `node /path/to/ia/apps/cli/dist/main.js` for `ia` in the quick start.

| Command | What it checks |
| --- | --- |
| `pnpm build` | Bundled language base, kernel and public vocabulary checks, package builds and host payload |
| `pnpm test` | Builds first, then runs package and repository-tool test suites |
| `pnpm typecheck` | Package and tool TypeScript |
| `pnpm lint` / `pnpm format:check` | Biome lint and formatting checks |
| `pnpm docs:audit` | Documentation structure, link integrity and owner contract coverage |
| `pnpm platform:qualify` | Tests, types, static checks, native validation, documentation and emitted-resource qualification |

<details>
<summary>More checks: native records, generated files, installed packages and releases</summary>

| Command | What it checks |
| --- | --- |
| `pnpm native:check` | Native source closure and repository lints |
| `pnpm public-language:check` | Public schema and reference closure and harness compilation |
| `pnpm compliance:check` / `pnpm systems:check` | Compliance fixtures and local system scenarios |
| `pnpm dependencies:check` | Package dependency direction |
| `pnpm tests:inventory` | Test ownership and qualification task coverage |
| `pnpm docs:check --all` | Local link targets across tracked Markdown files |
| `pnpm vocabulary:check` / `pnpm vocabulary:generate` | Check or regenerate the vocabulary catalogue |
| `pnpm authoring:check` / `pnpm authoring:generate` | Check or regenerate authoring resources |
| `pnpm projections:check` / `pnpm projections:generate` | Check or regenerate `CLAUDE.md` (this repository's position packet) and the `ia-authoring` skills |
| `pnpm public:qualify` | Public records, guides and host artifacts, plus package qualification |
| `pnpm packages:qualify` | Package exports, installed CLI consumers and VSIX packaging |
| `pnpm resources:qualify` / `pnpm projections:qualify` | Emitted resource and projection behavior |
| `pnpm release:note` / `pnpm release:check` / `pnpm release:version` | Add a pending release note, check that changed packages have notes, and compute the next coordinated version |
| `pnpm npm:setup` | Report, and with `--apply` fix, the npm names, trusted publishers and GitHub settings publication needs |
| `pnpm npm:prepare` / `pnpm npm:consumer` / `pnpm npm:plan` | Prepare and check npm release archives; see the [publishing guide](tools/distribution/NPM-PUBLISHING.md) |

</details>

A change to a public package needs a release note (`pnpm release:note`); repository docs, tooling and workflows do not. Edit the native source before regenerating vocabulary, authoring resources or the position packet. Tie every validation claim to the checks that ran and the environment they exercised.

---

## 📄 License

IA is licensed under [Apache-2.0](LICENSE). Copyright 2026 InventArch contributors; see [NOTICE](NOTICE) for attribution. Package-local and third-party licenses apply to their respective material.
