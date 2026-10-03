# 🌳 IA · the InventArch record language and toolchain

[![Release](https://img.shields.io/badge/release-1.0.0-blue)](https://github.com/inventarch/ia/releases/tag/v1.0.0) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-10.33.0-f69220)](package.json) [![Vocabulary](https://img.shields.io/badge/vocabulary-43%20words-blue)](docs/reference/language/vocabulary.md)

> **IA** is a language and toolchain for records you own. Write down decisions, rules, agent definitions and work plans in `.ia` files, then check their structure and relationships with the compiler, graph APIs and local tools.
>
> This is the **public IA repository**: the language, native schemas, CLI, MCP server, editor integration and worked examples, licensed under Apache-2.0.

Start with the [language guide](docs/reference/language/README.md), browse the [43-word vocabulary](docs/reference/language/vocabulary.md), or try the [worked examples](examples/public-language/README.md). The [1.0.0 release](https://github.com/inventarch/ia/releases/tag/v1.0.0) includes package tarballs, the VS Code extension and checksums.

---

## ⚡ Quick start

Use **Node.js `>=22.22.0 <23`** and **pnpm `10.33.0`**, as declared in [package.json](package.json). From this checkout:

```sh
pnpm install --frozen-lockfile
pnpm build

node apps/cli/dist/main.js --version
node apps/cli/dist/main.js init ../ia-demo --host none               # preview
node apps/cli/dist/main.js init ../ia-demo --host none --apply --yes # create
node apps/cli/dist/main.js validate --root ../ia-demo
node apps/cli/dist/main.js inspect --root ../ia-demo
node apps/cli/dist/main.js vocabulary plan --schema
```

The first `init` command previews the files and bundled language dependency; the second creates the workspace. The target's parent directory must already exist. Initialization uses the bundled base and works without a registry connection.

Add records under the generated `.ia/src/systems/ia-demo/` directory. The starter directly requires the agent, work and workspace systems. Copy the [work example](examples/public-language/records/work.ia) into its `records/` directory, then run `validate` again.

### 🖥️ Editor and agent hosts

| Use with | Start here |
| --- | --- |
| **VS Code** | Install `inventarch-ia-1.0.0.vsix` from the release using **Extensions: Install from VSIX**, then open a local IA workspace. Requires VS Code 1.138.0 or later. See the [extension guide](apps/vscode/README.md). |
| **Claude, Codex or Cursor** | From your IA workspace, preview `ia host claude`, `ia host codex` or `ia host cursor`, then apply the selected registration with `--apply --yes`. See the [CLI guide](apps/cli/README.md). |
| **MCP clients** | Use the local stdio [MCP server](apps/mcp-door/README.md) for scoped workspace reads. Its [contract](apps/mcp-door/SPEC.md) describes the supported operations. |

In command examples, `ia` means the CLI binary. When running from source, substitute `node /path/to/ia/apps/cli/dist/main.js`.

---

## 🤖 For coding agents

If you are an agent working in this checkout, start here:

1. **Read the contracts.** [SPEC.md](SPEC.md) owns the repository; each package, app and native system has a colocated contract for its behavior.
2. **Choose the word before writing the record.** Read the [language guide](docs/reference/language/README.md), [vocabulary catalogue](docs/reference/language/vocabulary.md) and canonical schema. The [IA authoring skill](.agents/skills/ia-authoring/SKILL.md) provides the entry point.
3. **Edit source, then regenerate.** Native declarations live under `.ia/src/`. Vocabulary pages, authoring resources and host projections have their own generators; the corresponding `*:check` commands detect drift.
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
| [`@inventarch/graph`](packages/graph/SPEC.md) | Typed graph, identity resolution and queries |
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
| **Workspace records** | `init`, `validate`, `compile`, `format`, `inspect`, `vocabulary` |
| **Distributions and hosts** | `pack`, `install`, `update`, `remove`, `restore`, `doctor`, `host` |
| **Machine operations** | `scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse`, `report`, with inputs through `--params` |

Use `ia --help` or `ia <command> --help` for options. `ia doctor` reports observed runtime, workspace and installation state; an unavailable update check remains unknown.

Commands that preview changes require `--apply` to perform them, and `--yes` when applying without a terminal. `compile` writes its output directly, and `format --write` rewrites source formatting. Host registration is an explicit operation.

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
| **Release downloads** | [IA 1.0.0](https://github.com/inventarch/ia/releases/tag/v1.0.0) · [CI results](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) |

---

## ✅ Contributing and verification

Review the [repository contract](SPEC.md) and the nearest owner contract before changing behavior. Run focused checks while working; `pnpm platform:qualify` is the full repository qualification entry point. All commands below are root [package.json](package.json) scripts.

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
| `pnpm projections:check` / `pnpm projections:generate` | Check or regenerate host projections |
| `pnpm public:qualify` | Public records, guides and host artifacts, plus package qualification |
| `pnpm packages:qualify` | Package exports, installed CLI consumers and VSIX packaging |
| `pnpm npm:prepare` / `pnpm npm:consumer` / `pnpm npm:plan` | Prepare and check npm release archives; see the [publishing guide](tools/distribution/NPM-PUBLISHING.md) for the release toolchain and account setup |
| `pnpm resources:qualify` / `pnpm projections:qualify` | Emitted resource and projection behavior |

</details>

Edit the corresponding native source before regenerating vocabulary, authoring resources or host projections. Keep validation claims tied to the checks that actually ran and the environments they exercised.

---

## 📄 License

IA is licensed under [Apache-2.0](LICENSE). Copyright 2026 InventArch contributors; see [NOTICE](NOTICE) for attribution. Package-local and third-party licenses apply to their respective material.
