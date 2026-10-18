# @inventarch/runtime

[![npm](https://img.shields.io/npm/v/@inventarch/runtime?label=npm)](https://www.npmjs.com/package/@inventarch/runtime) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json)

> `@inventarch/runtime` turns scoped [`@inventarch/db`](../db/README.md) reads into what agents and hosts consume: position bodies, plan delivery views, record bodies, the position packet for Claude Code and Codex, mandate resolution and the Door machine protocol. `ia position`, `ia next` and `ia read`, the MCP server and the VS Code extension are built on it.

## ⚡ Quick start

```sh
npm install @inventarch/db @inventarch/runtime
```

Read a position and a plan's delivery view from the workspace in the [root README quick start](../../README.md#-quick-start). These reads do not execute the task:

```js
import { open } from '@inventarch/db';
import { deliveryView, position } from '@inventarch/runtime';

const workspace = open('path/to/your-project', { cache: false, checks: 'structural' });
try {
  const { token } = workspace.resolveScope();
  const { body } = position(workspace, token, {
    seat: 'work-system/definition/task/write-schema',
    shape: 'sequence',
  });
  console.log(body.key.phase, body.loaded.map(({ identity }) => identity));
  const delivery = deliveryView(workspace, token, 'work-system/definition/plan/public-api');
  if (delivery.ok) console.log(delivery.view.next);
} finally {
  workspace.close();
}
```

```text
plan [
  'work-system/definition/task/write-schema',
  'work-system/definition/task/review-schema'
]
ia position --seat work-system/definition/task/write-schema --shape sequence
```

`position` completes a partial scope key (the `sequence` shape implies the `plan` phase, with depth 1 and budget 16 by default) and returns `{body, digest, hostNote}`. The body and its digest are a pure function of the key and the admitted records; the host note carries the revisions and capture freshness outside the digest. `deliveryView` returns `{ok: true, view}`, or a refusal that names the one command to run next.

An optional `primitive` selects any of Memory, Attention, Inference, Decision, Escalation or Learning without changing the shape's focus. For example, `position(workspace, token, { primitive: 'Escalation' })` defaults to phase `act`; an explicit phase wins. Omit `primitive` to retain existing keys and shape-derived behavior. Legacy `context` and `select` requests still declare their primitive explicitly.

## 🧭 What it does

| Export | Use it for |
| --- | --- |
| `position`, `positionBody`, `normalizeScopeKey`, `resolveScopeKey`, `K0`, `SCOPE_KEY_CAPS` | The body `ia position` prints for a scope key of seat, shape, phase, depth, budget and word, with an optional primitive override. |
| `deliveryView`, `NEXT_CODES` | The plan view `ia next` prints: tasks in prerequisite order, each with a verdict from recorded exit evidence, and the next `ia position` command. |
| `readBody`, `parseLocator` | The body behind an identity, cell, requirement or source locator, with its SHA-256, as `ia read` prints it. |
| `Door`, `MACHINE_PROTOCOL` | The structured read protocol behind the CLI's machine commands and the MCP server: nine version 1 operations, plus `read`, `next` and `position` since version 2; version 3 adds optional primitive selection to `position`. |
| `context`, `select`, `prepareCoordinate`, `classify` | Coordinate-based context packets that reserve blocking governance first, and selection among explicit candidates. |
| `renderPacket`, `renderHost`, `PACKET_MARKER` | Build the host-neutral position packet and render it for `claude` or `codex` as files and a receipt. |
| `governingMandates`, `defaultActor`, `profileRefusal`, `evaluateMandateGuard`, `MOVES`, `MODE_MOVES` | Resolve the `@mandate` records that govern an actor, and judge a command mode or a guarded edit against them. |
| `preparePublication`, `inspectPublication`, `validateCandidate` | Publish generated drafts create-only, and validate candidate files against the sources a host disclosed. |
| `@inventarch/runtime/editor` | `EditorWorkspace` for editors (overlays, diagnostics, completion and source actions), with language's single-record edit helpers. |
| `@inventarch/runtime/authoring` | Version 1 remote authoring request, proposal, receipt, event and chat contracts, and a bounded HTTPS client. |
| `@inventarch/runtime/authoring-execution` | Guarded dispatch of authoring operations from a fixed catalog the host supplies. |
| `@inventarch/runtime/entry` | `isEntry`, which a package binary calls to tell whether it is the process entry. |

The `./internal/*` subpaths serve specific toolchain consumers and are not a stable contract.

## ⚖️ What it does not do

- **It writes no source.** `position`, `deliveryView`, `readBody`, `renderPacket` and `renderHost` write nothing; the CLI writes projection files. Publication is the one writer: create-only files under a host-selected `.ia/work/generated/<id>` directory, never `.ia/src`.
- **It runs nothing.** The Door makes no source writes, model calls, sessions or capability dispatch. A delivery view reads verdicts from recorded evidence and never executes a task, and what a scope does not read never counts as met.
- **A position takes no free text.** Request text is refused as a scope key part, so nothing text-driven decides what a position loads.
- **Mandates are cooperative restrictions.** Mandate resolution reads authored declarations; it authenticates no one and grants no host permission. A `@mandate` that fails admission fails every mandate-gated decision closed.
- **Remote authoring needs a separate service.** `./authoring` validates and transports messages; the service owns authentication, authorization, persisted runs and model execution, and the application owns credentials and effects.
- **Publication locks coordinate cooperating processes.** They are not a sandbox against malicious changes by the same user.

## 📚 Learn more

- [SPEC.md](SPEC.md): the runtime contract, including scope keys, position bodies, delivery views, the Door protocol and host packets.
- [LANGUAGE.md](LANGUAGE.md): the public vocabulary this release carries.
- The [root README](../../README.md) and the [architecture reference](../../docs/reference/architecture/README.md).
- Related packages and apps: [`@inventarch/db`](../db/README.md), [`@inventarch/workspace-runtime`](../workspace-runtime/README.md), the [CLI guide](../../apps/cli/README.md) and the [MCP server](../../apps/mcp-door/README.md).
