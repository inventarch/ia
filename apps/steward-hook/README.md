# @inventarch/steward-hook

[![npm](https://img.shields.io/npm/v/@inventarch/steward-hook?label=npm)](https://www.npmjs.com/package/@inventarch/steward-hook) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json)

> The edit guard IA registers in Claude Code. For each authored `@hook`, it refuses a file edit the hook selects when a `@mandate` governs the path and none grants the acting agent Synthesis (an edit no mandate governs is allowed), and it protects the files IA generates and owns. `ia host claude` registers it through [`@inventarch/distribution`](../distribution/README.md); you do not run it by hand.

## ⚡ Quick start

Declare what to guard in `.ia/src/hook.ia`. A `@hook` is an owner edit in source, so write the file by hand; `ia author` refuses `hook` records:

```ia
#! ia 1.0

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

Check the workspace, preview the registration, then apply it:

```sh
ia validate
ia host claude
ia host claude --apply --yes
```

The plan lists `hook-authoring-system/binding/hook/guard-records  hook group create`. The apply adds one `PreToolUse` group to `.claude/settings.local.json` that matches `Write|Edit|MultiEdit` and runs the installed launcher as `guard --root <root> --hook <identity>`. `ia host claude --remove --apply --yes` removes every group and restores editing.

To check a decision without Claude Code, install the package in the project and call the same entry from the workspace root:

```js
import { runHook } from '@inventarch/steward-hook';

const root = process.cwd();
const event = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  cwd: root,
  tool_input: { file_path: `${root}/.ia/src/decision.ia` },
};
const args = ['--root', root, '--hook', 'hook-authoring-system/binding/hook/guard-records'];
const decision = runHook(args, JSON.stringify(event));
console.log(decision.hookSpecificOutput?.permissionDecisionReason ?? 'allowed');
```

In the root quick start's `my-project` workspace, whose starter mandate grants Synthesis, this prints `allowed`. With that mandate's `moves` cut to `[Observation, Verification]`, it prints a refusal that begins `IA-HOOK-NOT-MANDATED: Edits to .ia/src need a mandate that grants Synthesis.` and names `ia position --seat agent-system/policy/mandate/my-project-mandate --shape governance` as the next command.

## 🧭 What it does

| Part | Behavior |
| --- | --- |
| Selection | A registration for one `@hook` decides an edit only when the hook's `tools` name the tool and its `paths` select the file. Any other edit is allowed; nothing is decided just because it is under `.ia/src`. |
| Mandate decision | A selected edit is governed by the mandates whose `authority.covers` claims the path or that are scoped to its `@workspace`. With none it is allowed. Otherwise the acting agent needs Synthesis and, for a `.ia` file under `.ia/src/`, the words of the record headers the edit writes must be ones its mandates allow (`authority.words`, `authority.excluded-words`), else `IA-HOOK-NOT-MANDATED` with the hook's message. |
| Acting agent | A subagent acts as the `composition.agent` of the one authored `@agent-profile` its `agent_type` names; the main session acts as the workspace's steward, else its single participant. An unknown subagent or an ambiguous default actor is `IA-HOOK-IDENTITY-UNAVAILABLE`. |
| Projection protection | Runs first, whatever the hook selects. Refuses edits to `.ia/distributions.lock.json`, `.ia/distributions/`, the packet and generated files a projection state owns (with no state, the packet's files, `CLAUDE.md` and both `ia-authoring` skills) and, while a hook registration is owned, both Claude settings files and the launcher they name (`IA-HOOK-PROJECTION-MANAGED`). |
| Path safety | Refuses a selected path reached through a link, junction or short name, any dangling link or Windows alternate data stream, and in `--hook` mode any file under the root with more than one hard link (`IA-HOOK-PATH-UNSAFE`). |
| Failing closed | When the hook is not an admitted authored `@hook` or the records cannot be read, refuses edits under the selection last registered for it, or every edit under the root when none is recorded (`IA-HOOK-DECLARATION-UNAVAILABLE`, `IA-HOOK-MANDATE-UNAVAILABLE`). While an authored `@mandate` fails admission, refuses every edit the hook selects. Each reason names commands that work from a shell in that state. |
| Legacy 1.x guard | Without `--hook`, applies managed-state protection and the retired steward rule for `.ia/src/systems/<name>/`, for a 1.x registration that survives. A 1.x steward file under `.claude/agents/` stays protected until removed. `ia host claude --apply` retires the 1.x registration and removes the marked steward files it owns. |
| Exports | `runHook`, `evaluateMandateHook`, `evaluateHook`, `printable`, `deny` and `streamed`; `printable` strips terminal escapes and control characters from every refusal reason. `./context` holds the lifecycle context hook; `ia host claude --context` refuses in this release. |

## ⚖️ What it does not do

- **Not authentication or a sandbox.** The guard is a cooperative restriction. It grants no host permission and no filesystem isolation, and anyone who can edit `.ia/src` can change the mandates it reads.
- **Only file-tool edits.** It sees the `Write`, `Edit` and `MultiEdit` calls Claude Code sends it. A shell command or another program that writes a file is not checked.
- **Words only from record headers.** Beyond the move, it judges only the words of the record headers (`@<word> <name>` lines) in the text an edit writes to a `.ia` file under `.ia/src/`. A new or wholly rewritten file, or an edit that adds a whole record, is checked; an edit that changes an existing record's fields without rewriting its header line is not yet judged on words. It does not judge execution limits. Record authoring with `ia preview` and `ia author` judges the word of the record it targets.
- **Only declared hooks.** A workspace with no authored `@hook` gets no guard group. A `@hook` record is a declaration; `ia doctor` reports whether its group is registered.
- **No Codex hooks.** `ia host codex` reports each `@hook` as not taken. Where `disableAllHooks` turns hooks off, `ia host` writes no new group.
- **Fails open on a missing Node.** On Windows, Claude Code runs the guard's direct form, which fails open when its Node cannot start.

## 📚 Learn more

- [Package contract](SPEC.md) · [language summary](LANGUAGE.md)
- [Root README](../../README.md) · [architecture reference](../../docs/reference/architecture/README.md) · [CLI guide](../cli/README.md)
- [`@inventarch/distribution`](../distribution/README.md), which registers, owns and recovers the hook groups
- [`@inventarch/runtime`](../../packages/runtime/SPEC.md), which decides a selected edit against the governing mandates
- [hook-authoring-system](../../.ia/src/systems/hook-authoring-system/SPEC.md), owner of `@hook`, and [agent-system](../../.ia/src/systems/agent-system/SPEC.md), owner of `@agent` and `@mandate`
