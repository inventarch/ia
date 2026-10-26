# The IA guide

This guide explains IA from the ground up, for people using it in their own projects. It is written in layers: start with the whole picture, follow one piece of work through it, then look closer at each part.

## Install the CLI

IA needs **Node.js `>=22.22.0 <23`**. Install the `ia` command globally:

```sh
npm install --global @inventarch/cli
ia --version
```

To pin one version for a JavaScript or TypeScript project instead, install it as a development dependency and use `npx ia` wherever this guide says `ia`:

```sh
npm install --save-dev --save-exact @inventarch/cli
npx ia --version
```

With pnpm, use `pnpm add --save-dev --save-exact @inventarch/cli` and `pnpm exec ia`. To run IA from a source checkout, see [Contributing](../../CONTRIBUTING.md#build-from-source).

## Read in this order

| Layer | Page | What you get |
| --- | --- | --- |
| 1. The whole picture | [How IA works](how-ia-works.md) | What IA is for and how its parts fit, in ten minutes |
| 2. One piece of work | [Walkthrough](walkthrough.md) | A feature taken from an idea to a finished, evidenced task, with every command and its real output |
| 3. Each part up close | The concept pages below | One topic per page: what it is, an example and its limits |
| 4. Look-ups | [Commands](commands.md) · [Troubleshooting](troubleshooting.md) · [Glossary](glossary.md) | Answers when you need them |

## Concepts

| Page | Covers |
| --- | --- |
| [Records](records.md) | The `.ia` syntax: records, sections, fields, values, references, relationships and identities |
| [Words and systems](words-and-systems.md) | The 44 words, the eleven systems that own them, schemas and how to look a word up |
| [Workspaces](workspaces.md) | `ia init`, the `.ia/` folder, what to commit, snapshots and working in a team |
| [Planning work](planning-work.md) | Specs, decisions, plans, milestones and tasks, and how `ia next` decides what is done |
| [Rules](rules.md) | Laws, principles, conventions and playbooks, and how they reach an agent |
| [Checks and evidence](checks-and-evidence.md) | Contracts, cases, checks, evaluators and observations |
| [What a result means](what-results-mean.md) | What each IA result establishes, and what it does not |
| [Agents and authority](agents-and-authority.md) | Participants, mandates and moves, positions, and the `ia preview` / `ia author` write path |
| [Connecting agents](connecting-agents.md) | Claude Code, Codex, the MCP server, edit guards, generated agents, the runner and the VS Code extension |
| [Knowledge](knowledge.md) | Searching records and documents with `ia kb`, and packaging them for reuse |
| [Distributions and kits](distributions-and-kits.md) | Packaging, publishing and installing vocabulary and methods |
| [Your own vocabulary](your-own-vocabulary.md) | Defining a system and new words |
| [Upgrading](upgrading.md) | Moving a workspace from an older IA release |

## Other documentation

- The [language reference](../reference/language/README.md) and [vocabulary catalogue](../reference/language/vocabulary.md) give the exact grammar and every word's fields.
- The [architecture reference](../reference/architecture/README.md) and [package reference](../reference/packages/README.md) are for building on IA's packages.
- The [implemented specifications](../specs/README.md) define command behavior precisely.
- The [examples](examples.md) folder holds the walkthrough's finished records and smaller examples to copy.
