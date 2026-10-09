# 🌳 IA · the InventArch record language and toolchain

[![Release](https://img.shields.io/npm/v/@inventarch/cli?label=release)](https://github.com/inventarch/ia/releases/latest) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-12.9.0-f69220)](package.json) [![Vocabulary](https://img.shields.io/badge/vocabulary-44%20words-blue)](docs/reference/language/vocabulary.md)

> **IA** is a language and toolchain for keeping decisions, requirements, agent definitions and work plans alongside your code. Author linked records in plain-text `.ia` files; the CLI checks their structure and relationships, and the VS Code extension helps you write and navigate them.
>
> This is the **public IA repository**: the language, native schemas, CLI, MCP server, editor integration and worked examples, licensed under Apache-2.0.

Start below with the published [CLI](https://www.npmjs.com/package/@inventarch/cli), then explore the [language guide](docs/reference/language/README.md), [44-word vocabulary](docs/reference/language/vocabulary.md) and [worked examples](examples/public-language/README.md).

---

## ⚡ Quick start

### 1. Install the CLI

Use **Node.js `>=22.22.0 <23`**. Install [`@inventarch/cli`](https://www.npmjs.com/package/@inventarch/cli) globally to make the `ia` command available across your projects, including projects without a `package.json`:

```sh
npm install --global @inventarch/cli@1.0.0
ia --version
```

The version command should print `1.0.0`. Each project keeps its own records in its own `.ia/` directory, regardless of where the CLI is installed.

<details>
<summary>Prefer a project-local install for a JavaScript or TypeScript repository?</summary>

From that repository, install the CLI as a development dependency so your team shares a pinned version:

```sh
npm install --save-dev --save-exact @inventarch/cli
npx ia --version
```

Use `npx ia` wherever the examples below use `ia`, and commit your `package.json` and lockfile. With pnpm, use `pnpm add --save-dev --save-exact @inventarch/cli` and `pnpm exec ia`.

</details>

See the [CLI guide](apps/cli/README.md) for installation and command details. Building IA itself is covered under [contributing](#-contributing-and-verification).

### 2. Initialize your project

In an existing project directory, preview the setup, then apply it:

```sh
cd path/to/your-project
ia init . --id local/my-project --host none
ia init . --id local/my-project --host none --apply --yes
```

Choose your own `local/my-project` identity; its final component names the generated system directory. The first command shows the proposed files. The second creates the `.ia/` workspace and installs the bundled language definitions locally, with no registry connection needed during initialization.

Your authoring files start here:

```text
.ia/src/systems/my-project/
├── system.ia             # Your system, its vocabulary dependencies and steward
└── records/
    └── workspace.ia      # The workspace and its distribution record
```

The starter supports agents, work records and workspace records. To start in a new folder instead, use `ia init my-project --host none --apply --yes` from an existing parent directory.

### 3. Write your first record

Create `.ia/src/systems/my-project/records/decisions.ia` with this content:

```ia
#! ia 1.0

@decision api-response-format
  meaning
    says "Choose a response format for the public API."
  work
    title "API response format"
    status made
  decision
    question "Which response format will clients consume?"
    options ["JSON", "XML"]
    choice "JSON"
    rationale "Our clients already use JSON."
```

`@decision` selects a record type; `api-response-format` names this record. Its fields capture the question, alternatives and chosen answer. Other records can refer to it as `@decision api-response-format`.

### 4. Check that it works

Run these commands from the initialized project:

```sh
ia validate
ia inspect --path .ia/src/systems/my-project/records/decisions.ia
ia vocabulary decision --schema
```

For this example, look for **Admitted** and **0 errors**. In 1.0.0, a fresh workspace also reports two `IA-COMP-NOT-EVALUATED` warnings for `COMP-FIXTURES` and `COMP-KERNEL`: those checks need matching verification evidence. The overall outcome therefore remains `not-evaluated`; it is not a full evaluation pass.

`inspect` shows the decision you just added; `vocabulary` shows its required fields and permitted values. If you change `status made` to `status finished`, validation should report `IA-COMP-FIELD-VALUE` at the record's `work.status` field. Restore `made` and validate again to return to zero errors.

This checks that your records conform to the language and their references resolve. Evaluating project requirements or executing an agent needs the corresponding evaluator or host. See [reading validation results](docs/reference/language/README.md#reading-validation-results) for the distinction.

### 5. Add the VS Code extension

1. Download the `inventarch-ia-<version>.vsix` asset from the [latest release](https://github.com/inventarch/ia/releases/latest).
2. In **VS Code 1.138.0 or later**, open the Command Palette and run **Extensions: Install from VSIX…**, then select the downloaded file.
3. Open your project folder and the `decisions.ia` file. IA Language supplies completion, hover information, navigation, formatting and diagnostics in the Problems panel.

Try the invalid status from step 4 to see an editor diagnostic, then restore it. The extension performs local language analysis without an account or hosted service. See the [extension guide](apps/vscode/README.md) for details.

### What can I author next?

| Capture | Record types | Start here |
| --- | --- | --- |
| Project work and decisions | `@plan`, `@milestone`, `@task`, `@decision` | [Work example](examples/public-language/records/work.ia); available in the starter |
| Agents and their authority | `@agent`, `@mandate` | [Agent](docs/reference/language/vocabulary.md#agent) and [mandate](docs/reference/language/vocabulary.md#mandate) fields; available in the starter |
| Project rules and procedures | `@principle`, `@law`, `@convention`, `@playbook` | [Governance vocabulary](docs/reference/language/vocabulary.md#convention) |
| Requirements and checks | `@contract`, `@check`, `@case` | [Quality example](examples/public-language/records/quality.ia) |
| Agent composition | `@capability`, `@agent-profile`, `@harness` | [Composition example](examples/public-language/records/composition.ia) |
| Reusable output and learning | `@template`, `@observation`, `@improvement` | [Template fields](docs/reference/language/vocabulary.md#template) · [evidence example](examples/public-language/records/evidence.ia) |

Before using a word from another system, add its owner to the `requires` list in your `system.ia` (for example, `- compliance-system` for `@contract`). The [vocabulary catalogue](docs/reference/language/vocabulary.md) names each owner and schema; `ia vocabulary <word> --schema` exposes the same authoring contract in the terminal. The [language guide](docs/reference/language/README.md) covers syntax, relationships and defining your own vocabulary.

### Connect an agent host

Host registration is optional. From your initialized project, choose the host you use:

| Use with | Start here |
| --- | --- |
| **Claude, Codex or Cursor** | Preview `ia host claude`, `ia host codex` or `ia host cursor`, then rerun the chosen command with `--apply --yes`. The preview lists the host configuration it will write. See the [CLI guide](apps/cli/README.md). |
| **MCP clients** | Use the local stdio [MCP server](apps/mcp-door/README.md) for scoped workspace reads. Its [contract](apps/mcp-door/SPEC.md) describes the supported operations. |

---

## 🤖 For coding agents

If you are an agent working in this checkout, start here:

1. **Read the contracts.** [SPEC.md](SPEC.md) owns the repository; each package, app and native system has a colocated contract for its behavior.
2. **Choose the word before writing the record.** Read the [language guide](docs/reference/language/README.md), [vocabulary catalogue](docs/reference/language/vocabulary.md) and canonical schema. The [IA authoring skill](.agents/skills/ia-authoring/SKILL.md) provides the entry point.
3. **Edit source, then regenerate.** Native declarations live under `.ia/src/`. Vocabulary pages, authoring resources, `CLAUDE.md` (this repository's position packet) and the `ia-authoring` skills have their own generators; the corresponding `*:check` commands detect drift.
4. **Report the checks you ran.** Name the behavior and environment each check exercised. Model execution, evidence evaluation and external effects require explicitly supplied consumers and host authority.

---

## 📦 What is in the repository

| Folder | Holds | Start at |
| --- | --- | --- |
| `packages/` | Compiler, graph, compliance, database, runtime and service contracts | Package contracts below |
| `apps/` | CLI, MCP server, steward hook, distribution tooling and VS Code extension | App contracts below |
| `.ia/src/floor/` | Closed language domains, predicate pairs and routing vocabulary | [Kernel README](.ia/src/floor/README.md) · [contract](.ia/src/floor/SPEC.md) |
| `.ia/src/systems/` | Public vocabulary owners, canonical schemas and system implementations | Native systems below |
| `docs/` | Language reference and vocabulary catalogue | [Language guide](docs/reference/language/README.md) |
| `examples/` | Authoring examples and executable conformance fixtures | [Public-language examples](examples/public-language/README.md) |
| `distributions/` | The optional product-structure distribution | [Distribution README](distributions/product-structure/README.md) |
| `tools/` | Build, generation, documentation and qualification tools | Root [scripts](package.json) and [contract](SPEC.md) |

### 🧱 Packages

| Package | Role |
| --- | --- |
| [`@inventarch/language`](packages/language/SPEC.md) | Parsing, registration, compilation, native kernel generation and formatting |
| [`@inventarch/graph`](packages/graph/SPEC.md) | Typed graph, identity resolution, queries and the canonical digest codec |
| [`@inventarch/workspace-runtime`](packages/workspace-runtime/SPEC.md) | Workspace capture, captured resources, projections, publication, templates, lifecycle, authoring manifest and the installed implementation digest |
| [`@inventarch/compliance`](packages/compliance/SPEC.md) | Schema checks, assessments and explicit refusals |
| [`@inventarch/db`](packages/db/SPEC.md) | Workspace readers, scoped views, cache, preview, adoption and bindings |
| [`@inventarch/runtime`](packages/runtime/SPEC.md) | Context delivery, machine operations, steward evaluation and editor/authoring interfaces |
| [`@inventarch/service-contracts`](packages/service-contracts/SPEC.md) | Browser-safe service wire contracts and structural validation |

System implementations also provide packages for [agents](.ia/src/systems/agent-system/SPEC.md), [composition](.ia/src/systems/agent-composition-system/SPEC.md), [authoring](.ia/src/systems/authoring-system/SPEC.md), [sessions](.ia/src/systems/session-system/SPEC.md) and [templates](.ia/src/systems/template-system/SPEC.md).

### 🛠️ Apps

| App | Role |
| --- | --- |
| [`cli`](apps/cli/SPEC.md) | The `ia` binary: workspace commands, distribution commands and machine operations |
| [`mcp-door`](apps/mcp-door/SPEC.md) | Local stdio MCP host for scoped reads over one workspace root |
| [`steward-hook`](apps/steward-hook/SPEC.md) | Host adapter for deterministic file-write guards and scoped lifecycle context |
| [`distribution`](apps/distribution/SPEC.md) | Packing, installation and host registration for distributions |
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
<tr><td width="33%" valign="top"><b>🧠 <a href=".ia/src/systems/agent-composition-system/SPEC.md">agent-composition-system</a></b><br><sub>Capabilities, profiles, harnesses and execution bindings</sub></td><td width="33%" valign="top"><b>📋 <a href=".ia/src/systems/work-system/SPEC.md">work-system</a></b><br><sub>Plans, milestones, tasks and decisions</sub></td><td width="33%" valign="top"><b>🌱 <a href=".ia/src/systems/learning-system/SPEC.md">learning-system</a></b><br><sub>Observations and proposed improvements</sub></td></tr>
</table>

---

## 🧭 Commands and integrations

| Work with | Commands |
| --- | --- |
| **Workspace records** | `init`, `validate`, `capture`, `format`, `inspect`, `read`, `position`, `next`, `vocabulary`, and the deprecated `compile` |
| **Distributions and hosts** | `pack`, `install`, `update`, `remove`, `restore`, `doctor`, `host` |
| **Machine operations** | `scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse`, `report`, with inputs through `--params` |

Use `ia --help` or `ia <command> --help` for options. `ia doctor` reports observed runtime, workspace and installation state; an unavailable update check remains unknown.

Commands that preview changes require `--apply` to perform them, and `--yes` when applying without a terminal. `capture` writes its snapshot under `.ia/work/snapshot/` directly (`capture --preview` reports what it would write and writes nothing), as the deprecated `compile` writes its artifact under `.ia/work/`, and `format --write` rewrites source formatting. Host registration is an explicit operation.

Native declarations describe structure and intent. Passing schema validation does not establish that a declared test ran or that its evidence is true. The [language guide](docs/reference/language/README.md) explains composition, execution and evaluation outcomes.

---

## 📚 Documentation map

| Read for | Start at |
| --- | --- |
| **Language and identity** | [Authoring guide](docs/reference/language/README.md) · [language contract](docs/reference/language/SPEC.md) |
| **Words, fields and relationships** | [Vocabulary catalogue](docs/reference/language/vocabulary.md) · [machine-readable catalogue](docs/reference/language/vocabulary.json) |
| **Worked examples** | [Public-language examples](examples/public-language/README.md) · [work records](examples/public-language/records/work.ia) |
| **CLI and hosts** | [CLI guide](apps/cli/README.md) · [MCP server](apps/mcp-door/README.md) · [VS Code extension](apps/vscode/README.md) |
| **Repository changes** | [Repository contract](SPEC.md) and the nearest package or system `SPEC.md` |
| **Release downloads** | [Latest release](https://github.com/inventarch/ia/releases/latest) · [changelog](CHANGELOG.md) · [CI results](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) |

---

## ✅ Contributing and verification

Review the [repository contract](SPEC.md) and the nearest owner contract before changing behavior. Run focused checks while working; `pnpm platform:qualify` is the full repository qualification entry point. All commands below are root [package.json](package.json) scripts.

To build this repository, use Node.js `>=22.22.0 <23` and the pnpm version pinned in `packageManager` (currently `12.9.0`):

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/main.js --version
```

When using that build in another project, substitute `node /path/to/ia/apps/cli/dist/main.js` for `ia` in the quick start.

| Command | What it checks |
| --- | --- |
| `pnpm build` | Bundled language base, kernel and public vocabulary checks, package builds and host payload |
| `pnpm test` | Builds first, then runs package and repository-tool test suites |
| `pnpm typecheck` | Package and tool TypeScript |
| `pnpm lint` / `pnpm format:check` | Biome lint and formatting checks |
| `pnpm docs:audit` | Documentation structure, link integrity and owner contract coverage |
| `pnpm platform:qualify` | Tests, types, static checks, native validation, documentation and emitted-resource qualification |

<details>
<summary>More checks: native records, generated files and installed packages</summary>

| Command | What it checks |
| --- | --- |
| `pnpm native:check` | Native source closure |
| `pnpm public-language:check` | Public schema/reference closure and harness compilation |
| `pnpm compliance:check` / `pnpm systems:check` | Compliance fixtures and local system scenarios |
| `pnpm dependencies:check` | Package dependency direction |
| `pnpm tests:inventory` | Test ownership and qualification task coverage |
| `pnpm docs:check --all` | Local link targets across tracked Markdown files |
| `pnpm vocabulary:check` / `pnpm vocabulary:generate` | Check or regenerate the vocabulary catalogue |
| `pnpm authoring:check` / `pnpm authoring:generate` | Check or regenerate authoring resources |
| `pnpm projections:check` / `pnpm projections:generate` | Check or regenerate `CLAUDE.md` (this repository's position packet) and the `ia-authoring` skills |
| `pnpm public:qualify` | Public records, guides and host artifacts, plus package qualification |
| `pnpm packages:qualify` | Package exports, installed CLI consumers and VSIX packaging |
| `pnpm release:note` / `pnpm release:check` / `pnpm release:version` | Add a pending release note, check that changed packages have notes, and compute the next coordinated version |
| `pnpm npm:setup` | Report, and with `--apply` fix, the npm names, trusted publishers and GitHub settings publication needs |
| `pnpm npm:prepare` / `pnpm npm:consumer` / `pnpm npm:plan` | Prepare and check npm release archives; see the [publishing guide](tools/distribution/NPM-PUBLISHING.md) for the release flow and account setup |
| `pnpm resources:qualify` / `pnpm projections:qualify` | Emitted resource and projection behavior |

</details>

Edit the corresponding native source before regenerating vocabulary, authoring resources or the position packet. Keep validation claims tied to the checks that actually ran and the environments they exercised.

---

## 📄 License

IA is licensed under [Apache-2.0](LICENSE). Copyright 2026 InventArch contributors; see [NOTICE](NOTICE) for attribution. Package-local and third-party licenses apply to their respective material.
