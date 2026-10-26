# Connecting agents

**`ia host` connects a workspace to a coding agent. It generates a position packet that tells the agent how to use IA, an authoring skill, and the agents, skills and edit guards you describe in records. It also registers a read-only MCP server the agent can query. `ia project` writes the generated files without registering anything.**

| Host | Support |
| --- | --- |
| Claude Code | Full: packet, skills, generated agents, edit guards and the MCP server |
| Codex | Packet, skills and the MCP server. Generated agents and edit guards are reported as unsupported. |
| Cursor | Planned. `ia host cursor` refuses with `IA-DIST-HOST-UNSUPPORTED`. |
| Any MCP client | Run [`ia-mcp-door`](#the-mcp-server) yourself |

## `ia host` and `ia project`

Preview, then apply:

```sh
ia host claude
ia host claude --apply --yes
```

| Command | Writes | Registers |
| --- | --- | --- |
| `ia project claude --apply --yes` | `.claude/rules/ia-workspace.md` (the packet), `.claude/skills/ia-authoring/SKILL.md` and the generated agents and skills | Nothing |
| `ia host claude --apply --yes` | The same files | The MCP server in `.mcp.json`, and one edit-guard group per `@hook` in `.claude/settings.local.json` |
| `ia project codex --apply --yes` | `AGENTS.md` (the packet), `.agents/skills/ia-authoring/SKILL.md` and the playbook skills | Nothing |
| `ia host codex --apply --yes` | The same files | The MCP server in `.codex/config.toml` |

`ia host` also installs a copy of IA's host programs under `~/.ia/hosts/` (or `$IA_HOME/hosts/`); the registered entries run them with your Node binary and the project's absolute path. Claude Code asks for approval before it starts a project MCP server.

> [!WARNING]
> These files are machine-local. The entries `ia host` registers contain absolute paths to your Node binary, your IA home and your project, and the packet ends with a note about this clone's state. Do not commit them. Each person runs `ia host` or `ia project` in their own clone. If a file with the same name already exists and IA did not generate it, such as a hand-written `AGENTS.md`, the plan says so and `--apply` refuses with `IA-DIST-LOCAL-MODIFICATION` rather than overwrite it.

`ia host claude --remove --apply --yes` removes the registration and its files. Run `ia project` or `ia host` again after you change the records they generate from; `ia doctor` reports when the generated files are out of date (`outdated`) or a registration points at a Node binary that no longer exists.

### The user-level plugin

`ia host claude --user --apply --yes` installs an IA plugin into Claude Code for your user, across projects. It adds a review agent, a session-start check that runs `ia doctor`, and skills for setting up and diagnosing IA. A workspace plan mentions it when it is missing; it is never installed for you.

## The position packet

The packet is a generated Markdown file the host loads at startup. In Pantry, `.claude/rules/ia-workspace.md` lists:

- the workspace, its sources and steward;
- each participant and mandate, with the moves allowed;
- each system, its words and steward, and the `ia position` command to reach it;
- how many records of each word the workspace holds;
- the five shapes and four phases, and what each selects;
- the commands an agent uses (`init`, `validate`, `preview`, `author`, `capture`, `read`, `position`, `next`, `project` and the `kb` commands), each with a move, what it refuses and what to run next. The table also lists a move for `position` and `init`, although IA never checks those two against a mandate;
- three standing instructions: start with `ia position` and follow any command a refusal names; state intent as a scope key, never as free text; and ask the owning system about another system's words.

It ends with a host note giving the snapshot's freshness, which is not part of the packet's digest. Do not edit the packet: change the records and run `ia project` again.

## The MCP server

`ia-mcp-door` gives an agent read-only access to one workspace over MCP. `ia host` registers it as `ia-workspace`. It serves seventeen tools:

| Tools | Do |
| --- | --- |
| `ia_position`, `ia_next`, `ia_read` | The same as `ia position`, `ia next` and `ia read` |
| `ia_vocabulary` | Look up words |
| `ia_scope`, `ia_context`, `ia_select`, `ia_get`, `ia_records`, `ia_resolve`, `ia_search`, `ia_traverse` | Lower-level reads of records and relationships |
| `ia_kb_check`, `ia_kb_search`, `ia_kb_read`, `ia_kb_resolve`, `ia_kb_traverse` | The [knowledge](knowledge.md) reads |

The server never writes, and it does not check mandates. To use it with another MCP client:

```sh
npm install --global @inventarch/mcp-door
ia-mcp-door --root path/to/your-project
```

See the [MCP server guide](../../apps/mcp-door/README.md) for the protocol details.

## Describing agents in records

With Claude Code, IA can generate agent definitions and skills from records, so your agents are written down, reviewed and versioned like everything else. Five words describe them:

| Word | Describes |
| --- | --- |
| `@capability` | Something an agent can do: the playbooks, operations, templates and checks it uses, and its effects, such as `[read]` or `[write]` |
| `@agent-profile` | One role: an `@agent`, its capabilities, its voice, its mandate and who it may hand work to |
| `@voice` | How it communicates: tone, terminology, how it explains and how it states uncertainty |
| `@harness` | Profiles and bindings composed for one host |
| `@execution-binding` | A link from a record to an implementation installed in the host |

```ia
@capability review-changes
  meaning
    says "Review a change against its task, decision and rules."
    answers "Which procedure does a reviewer follow?"
  composition
    playbooks [@playbook small-change]
    operations []
  execution
    input change-request
    outcomes review-notes
    effects [read]

@agent-profile change-reviewer
  meaning
    says "Reviews Pantry changes without editing them."
    answers "Which profile reviews changes?"
  composition
    agent @agent reviewer
    capabilities [@capability review-changes]
    mandate @mandate reviewer-mandate
  execution
    role reviewer
    outcomes review-notes
    mandate-contract reviewer-mandate
```

Here `@agent reviewer`, its mandate and `@playbook small-change` are the ones from [Agents and authority](agents-and-authority.md#an-example-a-read-only-reviewer) and [Rules](rules.md#playbooks). `ia project claude --apply --yes` then generates `.claude/agents/change-reviewer.md`:

```markdown
---
name: "change-reviewer"
description: "A review agent that reads and checks, and never writes."
tools: "Read, Grep, Glob"
---

<!-- Generated by ia project; edit the cited native records. -->

# change-reviewer

Reviews Pantry changes without editing them.
…
## Mandate

- `agent-system/policy/mandate/reviewer-mandate`
  - participant `agent-system/binding/agent/reviewer`
  - moves Observation, Verification
…
```

It also generates `.claude/skills/small-change/SKILL.md` from the playbook.

What each host receives:

| Authored record | Claude Code | Codex |
| --- | --- | --- |
| `@agent-profile` | `.claude/agents/<name>.md` | Not supported |
| `@playbook` | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| `@hook` (see below) | An edit-guard group, through `ia host` only | Not supported |

A generated agent's tools follow from its capabilities' effects. A profile whose capabilities allow no host tool is not generated, because Claude Code would read an agent with no tool list as one with every tool. Only records in your own `.ia/src/` are generated; records from installed distributions are not.

None of these records grants authority. A profile names the mandate its agent works under; the mandate decides what IA allows.

## Edit guards

A `@hook` asks the host to check certain edits before they happen:

```ia
@hook guard-records
  meaning
    says "Guard edits to this workspace's IA records."
    answers "Which edits to .ia/src does the edit guard decide?"
  hook
    event PreToolUse
    tools [Write, Edit, MultiEdit]
    paths [".ia/src/**"]
    message "Edits to .ia/src need a mandate that grants Synthesis."
```

Write it by hand (`ia author` does not write hooks), then run `ia host claude --apply --yes`. Claude Code then runs IA's guard before every `Write`, `Edit` or `MultiEdit` on a matching path. The guard refuses the edit with `IA-HOOK-NOT-MANDATED` when a mandate governs that path and none grants the acting agent Synthesis. A subagent acts as the agent of the `@agent-profile` with its name; the main session acts as the workspace steward. Any other subagent, including Claude Code's built-in ones such as Explore, is refused at every path the hook selects with `IA-HOOK-IDENTITY-UNAVAILABLE`. The guard also protects the files IA generates.

Know its limits:

- It sees file-tool edits only. A shell command that writes a file is not checked.
- Only Claude Code runs it.
- It checks moves only, not excluded words or execution limits.
- On Windows, if Node is missing, it allows the edit.

`ia host claude --remove --apply --yes` removes every guard. `ia doctor` reports which hooks are registered.

## The runner

`ia-runner` runs one `@agent-profile` locally, step by step, with a journal of every step and limits on steps, model calls, operations, tokens, bytes and time. It applies a mandate's `execution.limit-*` fields, and checks moves and excluded words before each operation. It brings no model provider and creates no credentials. A response is supplied to it, which makes it a harness for building and testing agent hosts rather than an assistant.

It needs host implementations that `ia init` does not install. See the [runner guide](../../apps/runner/README.md).

## The VS Code extension

**IA Language** checks `.ia` files as you type, completes words, fields and references, shows a record's schema and findings on hover, and navigates between records.

1. Download `inventarch-ia-<version>.vsix` from the [latest release](https://github.com/inventarch/ia/releases/latest).
2. In VS Code 1.138.0 or later, run **Extensions: Install from VSIX…** and select the file.
3. Open the folder that contains `.ia/` and open any file under `.ia/src/`.

It works locally, with no account or service. See the [extension guide](../../apps/vscode/README.md).
