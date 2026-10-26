# 🌳 IA · the open InventArch language and toolchain

[![Release](https://img.shields.io/npm/v/@inventarch/cli?label=release)](https://github.com/inventarch/ia/releases/latest) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json) [![pnpm](https://img.shields.io/badge/pnpm-12.9.0-f69220)](package.json) [![Vocabulary](https://img.shields.io/badge/vocabulary-44%20words-blue)](docs/reference/language/vocabulary.md)

> **IA keeps what a project has decided, requires, plans and allows as small typed records in `.ia` files beside the code.** The `ia` command checks every record and every reference between them. It tells you what work can start and what is blocked. And it gives each coding agent exactly the context its task needs: the requirement, the decisions, the rules and what the agent is allowed to do.
>
> Everything here is open source under Apache-2.0 and runs locally, with no account or hosted service.

## What it looks like

A decision, written as a record:

```ia
@decision list-format
  meaning
    says "Choose the file format of an exported shopping list."
  work
    title "Shopping-list file format"
    status open
  decision
    question "Which file format does the export produce?"
    options ["Markdown checklist", "CSV", "PDF"]
```

A plan whose milestone requires that decision can't move until it is made, and `ia next` says so:

```text
$ ia next
Plan  work-system/definition/plan/shopping-list    revision 995815064d3c…

  •  0 of 3 tasks have exit evidence; every other task is blocked
…
  ▲  work-system/definition/task/write-exporter
     blocked (decision work-system/definition/decision/list-format: no choice
     (via work-system/definition/milestone/export-ready))
```

Make the decision, and the task can start. Record a passing test against the task, and `ia next` counts it as done. Change the task afterwards, and the old evidence stops counting.

## Why IA

- **One source for people and agents.** Requirements, decisions, plans and rules live in git with the code. They are reviewed in pull requests and checked in CI, not scattered across tickets and chat.
- **Records are checked, not just stored.** Every record follows its word's schema and every reference must resolve. A typo, a missing field or a link to something deleted is caught, with the file and line.
- **Agents start from the right context.** `ia position` gives an agent a short, ordered view of what bears on its task, including the blocking rules that apply to it. The same question always gets the same answer.
- **"Done" means evidence.** A task is done when a recorded result covers that exact version of it, not when someone sets its status.
- **Honest about what it knows.** IA keeps declared, checked, executed and authorized apart. A check that did not run reports `not-evaluated`, never a pass.

## Get started

You need Node.js `>=22.22.0 <23`.

```sh
npm install --global @inventarch/cli
cd your-project
ia init . --host none --apply --yes
ia validate
```

Then follow **[the walkthrough](docs/guide/walkthrough.md)**. It takes one feature in a small app from an idea to a finished, evidenced task, with every command and its real output. Or read **[How IA works](docs/guide/how-ia-works.md)** first for the whole picture.

## How it fits together

| Part | What it is | Read |
| --- | --- | --- |
| **Records** | `@word name` blocks in `.ia` files under `.ia/src/` | [Records](docs/guide/records.md) |
| **Words and systems** | 44 words, such as `@spec`, `@task` and `@law`, grouped into eleven systems, each with a schema | [Words and systems](docs/guide/words-and-systems.md) |
| **Workspace** | A repository with an `.ia/` folder, created by `ia init` | [Workspaces](docs/guide/workspaces.md) |
| **Plans** | Specs, decisions, plans, milestones and tasks; `ia next` says what is done, ready or blocked | [Planning work](docs/guide/planning-work.md) |
| **Rules** | Laws, principles, conventions and playbooks, delivered to whoever works on a matching record | [Rules](docs/guide/rules.md) |
| **Checks and evidence** | Contracts, cases and checks IA evaluates, and observations that record results | [Checks and evidence](docs/guide/checks-and-evidence.md) |
| **Agents and authority** | Participants and the mandates that bound them, positions, and the `ia preview` / `ia author` write path | [Agents and authority](docs/guide/agents-and-authority.md) |
| **Hosts** | Claude Code and Codex integration, an MCP server, edit guards and a VS Code extension | [Connecting agents](docs/guide/connecting-agents.md) |
| **Distributions** | Versioned archives of words and methods, installed from registries or catalogs | [Distributions and kits](docs/guide/distributions-and-kits.md) |

## Use it with your coding agent

```sh
ia host claude               # preview
ia host claude --apply --yes
```

| Host | What `ia host` sets up |
| --- | --- |
| **Claude Code** | A position packet in `.claude/rules/`, an authoring skill, agents and skills generated from your records, edit guards and the `ia-workspace` MCP server |
| **Codex** | A position packet in `AGENTS.md`, skills and the MCP server |
| **Any MCP client** | Run [`ia-mcp-door`](apps/mcp-door/README.md): seventeen read-only tools, including `ia_position`, `ia_next` and `ia_read` |
| **VS Code** | Install the **IA Language** extension from the [latest release](https://github.com/inventarch/ia/releases/latest) for checking, completion and navigation as you type |

The generated files are machine-local; do not commit them. See [Connecting agents](docs/guide/connecting-agents.md).

## What IA does not do

- It does not run your tests or inspect your code. It records the results you give it, and checks records.
- It is not a sandbox. A `@mandate` limits what IA's own commands, and Claude Code's edit guard, will do for an agent. It grants no permission, and anyone who can edit `.ia/src/` can change it.
- It ships no method. How your team plans, reviews or designs is yours to write down, as playbooks, rules and checks, in IA's words or your own.

[What a result means](docs/guide/what-results-mean.md) lists exactly what each result establishes.

## 📚 Documentation

| For | Start at |
| --- | --- |
| **Learning IA** | [The guide](docs/guide/README.md): how it works, the walkthrough and one page per concept |
| **Looking things up** | [Commands](docs/guide/commands.md) · [Troubleshooting](docs/guide/troubleshooting.md) · [Glossary](docs/guide/glossary.md) · [Upgrading](docs/guide/upgrading.md) |
| **Exact definitions** | [Language reference](docs/reference/language/README.md) · [vocabulary catalogue](docs/reference/language/vocabulary.md) · [implemented specifications](docs/specs/README.md) |
| **Building on IA's packages** | [Architecture reference](docs/reference/architecture/README.md) · [package reference](docs/reference/packages/README.md) |
| **Examples** | [Examples](docs/guide/examples.md), including the walkthrough's finished records |
| **Releases** | [Latest release](https://github.com/inventarch/ia/releases/latest) · [changelog](CHANGELOG.md) |

## 📦 This repository

| Folder | Holds |
| --- | --- |
| `apps/` | The `ia` CLI, the MCP server, the runner, the edit guard, distribution tooling and the VS Code extension |
| `packages/` | The libraries they are built from: language, graph, compliance, database, knowledge, runtimes and service contracts |
| `.ia/src/` | The language itself: the floor and the eleven public systems, written in IA |
| `docs/` | The guide, the references and the implemented specifications |
| `examples/` | Examples to read and copy |
| `distributions/` | An optional distribution, `product-structure`, as a model for your own |
| `releases/`, `tools/` | Release inputs, and the build, check and release tools |

To build from source, run the checks or contribute, read the [contributing guide](CONTRIBUTING.md). Every package, app and system has a colocated `SPEC.md` that defines its behavior; [SPEC.md](SPEC.md) is the repository's own.

## Help and license

Ask questions and report bugs as described in [SUPPORT.md](SUPPORT.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

IA is licensed under [Apache-2.0](LICENSE). Copyright 2026 InventArch contributors; see [NOTICE](NOTICE) for attribution. Package-local and third-party licenses apply to their respective material.
