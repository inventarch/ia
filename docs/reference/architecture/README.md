# IA architecture and ownership

[![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../../../LICENSE)

> This reference explains how IA divides the work: which package to use for what, which native system owns each word and what executes it, when to consult a steward, and where a declaration stops and enforcement starts. The [root README](../../../README.md) introduces the concepts; each package's colocated `SPEC.md` defines its behavior, and the [package reference](../packages/README.md) indexes every package's guide and contract.

IA keeps three things apart: vocabulary declarations in `.ia` files, the toolchain that reads them, and the host implementations that execute work. A record's owning system comes from its word's registration. Its source folder decides capture and release membership. An npm package can carry native declarations, executable code, or both.

## Which package to use

| Package | Use it for | Public entry points |
| --- | --- | --- |
| [`@inventarch/language`](../../../packages/language/README.md) | Parse, scan, register, compile and format IA text; inspect identities and the language floor; edit one record in place. | Root; `./editor` |
| [`@inventarch/graph`](../../../packages/graph/README.md) | Resolve admitted identities and references; traverse relationships; inspect claims, conditions and record digests. | Root |
| [`@inventarch/compliance`](../../../packages/compliance/README.md) | Run structural checks; evaluate adopted contracts with supplied evaluators; resolve obligations and qualify evidence receipts. | Root |
| [`@inventarch/db`](../../../packages/db/README.md) | Discover source trees; open scoped read handles; inspect admission, membership and snapshots; preview changes; bind checks and read or write evidence. | Root; `./editor`, `./distribution`, `./descriptors` |
| [`@inventarch/runtime`](../../../packages/runtime/README.md) | Read records, deliver position and plan views, resolve mandates, render host packets and serve the Door protocol. | Root; `./editor`, `./authoring`, `./authoring-execution`, `./entry` |
| [`@inventarch/workspace-runtime`](../../../packages/workspace-runtime/README.md) | Capture and adopt workspaces; resolve teaching resources, lifecycle, templates and publication; join execution bindings with installed implementations. | Root; `./corpus`, `./bind`, `./candidate`, `./publication`, `./templates`, `./projections`, `./task-capture-format`, and the resource, authoring, lifecycle, source and store subpaths (`./sources`, `./local-store`, `./adapters`, `./installed-catalog`); its README lists each |
| [`@inventarch/service-contracts`](../../../packages/service-contracts/README.md) | Validate service request and response shapes, including sources, tenancy, sessions, source application, marketplace and installation. | Root; `./sources`, `./tenancy`, `./session-lifecycle`, `./source-apply`, `./marketplace`, `./installation` |
| [`@inventarch/kb`](../../../packages/kb/README.md) | Select committed knowledge; validate graph/resource closure; read and search immutable document views with citations. | Root; `./legacy`, `./protocol` |

The main dependency direction is `language → graph → compliance → db → runtime → workspace-runtime`: each package consumes the mechanisms to its left, and some also import earlier layers directly. The executable native packages sit inside this stack: `session-system` builds on `graph`, `agent-system` on `session-system`, and `authoring-system` and `template-system` on `runtime`; `workspace-runtime` imports those four, and `agent-composition-system` builds on `workspace-runtime`. `service-contracts` stands apart: it depends only on Zod and is browser-safe. Its schemas validate message shape; an application host supplies authentication, authorization, disclosure and native execution.

The apps consume these packages:

| App | Built on | Role |
| --- | --- | --- |
| `ia` ([`@inventarch/cli`](../../../apps/cli/README.md)) | `db`, `runtime`, `workspace-runtime`, `compliance`, `distribution`, `kb` | Authors, validates, reads and positions; plans and applies workspace, distribution and host effects; serves the machine protocol |
| `ia-mcp-door` ([`@inventarch/mcp-door`](../../../apps/mcp-door/README.md)) | `runtime`, `kb` | Serves scoped, read-only runtime and knowledge calls over stdio |
| [VS Code extension](../../../apps/vscode/README.md) | `runtime` | Uses the runtime editor surface |
| `ia-distribution` ([`@inventarch/distribution`](../../../apps/distribution/README.md)) | `db`, `graph`, `language`, `workspace-runtime`, `authoring-system` and the steward hook | Packs, installs, adopts, restores and recovers archives with the `db` distribution contracts, and registers hosts and their edit-guard groups |
| `ia-runner` ([`@inventarch/runner`](../../../apps/runner/README.md)) | `db`, `runtime`, `workspace-runtime` and the executable systems | Runs one admitted agent profile with a durable journal |
| [Steward hook](../../../apps/steward-hook/README.md) | `db`, `runtime`, `workspace-runtime` | The host edit guard |

Each app's colocated `SPEC.md` defines its behavior. The CLI's frozen machine-protocol operations (`ia scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse` and `report`) and the tools `ia-mcp-door` serves are the same runtime `Door` operations, which `MACHINE_PROTOCOL` in `@inventarch/runtime` describes once.

Use package entry points rather than the `./internal/*` subpaths. Those are published for specific toolchain consumers, such as the CLI's use of `@inventarch/workspace-runtime/internal/generate`, and expose details ordinary integrations do not need.

### Read a workspace

This script reads the Pantry workspace from the [walkthrough](../../guide/walkthrough.md): the position for one task and the delivery view of its plan. Save it as `read-workspace.mjs` and run it from the project root with `@inventarch/db` and `@inventarch/runtime` installed:

```js
import { open } from '@inventarch/db';
import { deliveryView, position } from '@inventarch/runtime';

const workspace = open('.', { cache: false });
try {
  const scope = workspace.resolveScope();
  const context = position(workspace, scope.token, {
    seat: 'work-system/definition/task/write-exporter',
    shape: 'sequence',
  });
  const delivery = deliveryView(workspace, scope.token, 'work-system/definition/plan/shopping-list');
  console.log(context.digest, delivery.ok);
} finally {
  workspace.close();
}
```

`position` returns the body, its digest and the host note; `deliveryView` returns the plan's milestones and tasks with their verdicts. Both are reads: they execute no task, and with `cache: false` the script writes nothing. Without it, `open` keeps a disposable graph cache at `.ia/.iadb/graph.json`. `open` admits checks strictly by default. `ia validate`, `ia-distribution validate`, `ia preview`, `ia author` and the source-protection row of `ia doctor` admit them structurally, so a `@check` naming an evaluator that is not built in stays readable; pass `checks: 'structural'` to read as they do.

For syntax only, use `parse`, `scan` or `format` from `@inventarch/language`. For admission, open a database handle: parsing one file cannot resolve references across files.

## Native systems and executable owners

| Native system | Owned words | Executable package behavior |
| --- | --- | --- |
| agent-system | agent, mandate | `Engine`, action parsing and validation, execution manifest digests |
| session-system | run | Journal store, replay and reducer, in-memory and SQLite backends |
| authoring-system | authoring-guide, operation | Validate and format drafts |
| agent-composition-system | voice, capability, agent-profile, harness, execution-binding | `compileHarness` and `executionManifest`; captured-source read and draft tool adapters; the task-capture contract |
| template-system | template | Validate and render scalar and structured templates |
| compliance-system | contract, check, case | Declarations only; `@inventarch/compliance` evaluates them |
| governance-system | law, principle, convention, playbook | Declarations only; position delivery selects them |
| hook-authoring-system | hook | Declarations only; `ia host claude` registers edit guards from them |
| learning-system | observation, improvement | Declarations only; `ia validate` writes check evidence as `@observation` records |
| work-system | plan, milestone, task, decision, spec | Declarations only; `ia next` and the runtime delivery view read them |
| workspace-system | workspace, distribution | Declarations only; capture and packing read them |

Each system's `README.md` and `SPEC.md` live in its folder under `.ia/src/systems/`, and the [language floor](../../../.ia/src/floor/README.md) supplies the closed kernel every system builds on. The six declaration-only packages export `./native.ia.tgz` and `./system-package.json`. The five executable owners export JavaScript APIs and ship their native payload beside them. Native dependencies (`requires` in `system.ia`) and npm dependencies are separate graphs: release packaging adds the npm dependency that each native requirement implies, so a source package manifest alone does not determine the published dependency graph.

`@inventarch/workspace-runtime` also owns host-artifact generation and the execution-binding join. `ia project`, `ia host` and `ia doctor` render agents and skills through its generation subpath, and `ia host` also registers the hook groups it generates; once it has, `ia project` keeps those groups in step with the authored `@hook` records. The same package renders the host plugin a product `@distribution` describes for `ia project --product plugin`, and lowers an existing plugin into records for `ia init --from`. `ia validate` and `ia-runner` join each `@execution-binding` with the installed implementation catalog through `./bind`, which loads and executes nothing: a bound result says an implementation is installed, not that it ran.

Importing `Engine` from `@inventarch/agent-system` or `compileHarness` from `@inventarch/agent-composition-system` gives you implementations, not authority. An `Engine` runs only with a host-supplied manifest, session store, model and operation adapters, context and evaluation callbacks, manifest verification, and an `authorize` callback for the acting principal. A record naming an implementation never installs it or grants its effects.

## When to consult a steward

Every system names a local steward accountable for its vocabulary, canonical schemas, relationship consent and direct system dependencies. Reach a system and its steward with:

```sh
ia position --seat floor/definition/system/work-system
```

Consult that steward before changing what a word means, its fields, its registration, its permitted relationships or its vocabulary dependencies. Ordinary records of an adopted word, such as a task or a decision, need no new vocabulary owner and no new agent per file. A task may name a steward as its owner; that is the task author's choice, and stewardship does not make the steward the writer of every record of its words.

The steward identity is readable ownership metadata. It spawns no agent, authenticates no writer and grants no host permission. Admission requires exactly one local steward per system whose `governance.applies` covers every word the system registers (`IA-COMP-STEWARD-MISSING`). A host that enforces writer identity must bind and authenticate that identity itself.

## Hooks, laws and actual enforcement

A `@hook` declares an event, tools, paths and a message; a host adapter registers it. `ia host claude` writes agents generated from `@agent-profile` records, skills generated from playbooks and one PreToolUse guard group per authored `@hook` that selects `Write`, `Edit` or `MultiEdit` with at least one path and a message; the guard judges those edits against the `@mandate` that governs each path. A `@hook` with another event, no path or no message, or past the 64th, is listed as unsupported in the projection receipt. `ia host codex` writes skills and the position packet and reports generated agents and hooks as unsupported. `ia host` registers no per-system steward guard; applying the projection retires one that an earlier release registered. Before claiming a hook is active, check its host registration and receipt with `ia doctor`.

`@law`, `@principle`, `@convention` and `@playbook` records carry guidance. Position delivery reserves applicable blocking guidance outside its budget and selects procedure cells. Admission checks shapes and relationships; it does not establish that a rule's prose is true or that a filesystem action obeyed it. Machine enforcement needs a selected evaluator or a host boundary with observable evidence, and a contract requirement with no available evaluator stays `not-evaluated`.

The CLI checks commands against the acting participant's mandates:

| Commands | Move the mandate must grant |
| --- | --- |
| `ia read`, `ia next`, `ia kb search/read/resolve/traverse` | Observation |
| `ia validate`, `ia preview`, `ia kb check` and `ia kb pack` preview | Verification |
| `ia author` | Synthesis |
| `ia capture`, `ia project`, `ia kb pack --apply`, and `ia host --apply` for a workspace | Execution |
| Every other command, including `ia position`, `ia inspect`, `ia init`, an `ia host` plan, `--remove` or `--user`, and the machine protocol | None: never checked, so the command a refusal names always runs |

`--actor <agent>` names the acting participant; by default it is the workspace steward or its one participant. `ia preview` and `ia author` also check the record's word and the target path. A refusal is `IA-RUNTIME-MANDATE-MOVE` or `IA-RUNTIME-MANDATE-WORD`. `ia author` also refuses the administrative words `workspace`, `agent`, `mandate`, `system`, `schema`, `agent-profile` and `hook` with `IA-CLI-EDIT-AUTHORITY`. The generated edit guard refuses an edit a `@hook` selects when a `@mandate` governs the path and none grants the acting agent Synthesis. It does not judge excluded words or execution limits; `ia preview` and `ia author` enforce excluded words. Mandates are cooperative restrictions, not authentication or a sandbox: naming an actor is a local declaration, and the host still owns authentication and filesystem permissions.

This repository's own [policy records](../../../.ia/src/records/repository-policy.ia) declare a release-selection `@law` and an architecture `@contract` with its `@check` and success and refusal `@case` records. `pnpm native:check` runs the repository lints that enforce them: work and example placement (`IA-NATIVE-WORK-PLACEMENT`, `IA-NATIVE-EXAMPLE-PLACEMENT`, `IA-NATIVE-RELEASE-WORK-PLACEMENT`), the release policy's source, status and workflow (`IA-NATIVE-RELEASE-POLICY-SOURCE`, `IA-NATIVE-RELEASE-POLICY-STATUS`, `IA-NATIVE-RELEASE-WORKFLOW`), and version and package-count literals in active release work (`IA-NATIVE-RELEASE-VERSION-LITERAL`, `IA-NATIVE-RELEASE-COUNT-LITERAL`). The `@check` binds the built-in `COMP-COVERAGE` evaluator, so `ia validate` establishes that the requirements have declared cases, not that the lints ran. A fixed version in an immutable historical record is evidence; current release inputs decide prospective releases. The repository participant holds all five moves.

## Source and release boundaries

`.ia/src/systems/<system>/` holds each public system's canonical vocabulary, schemas, teaching guidance and implemented operation contracts. Repository work, such as plans, tasks and decisions, lives under `.ia/src/records/`, outside those trees, and `pnpm native:check` refuses it inside them (`IA-NATIVE-WORK-PLACEMENT`). A record keeps its identity when its file moves, because the word's registration owns it.

Neutral examples live under [`examples/public-language`](../../../examples/public-language/README.md), outside the live discovery tree. `publicLanguageInputs` in `tools/native/public-language.ts` selects them from the manifest and maps them to stable native paths for conformance and teaching; `tools/native/public-fixture.ts` materializes that corpus for tests. Fixture-only release selectors stay under `examples/public-language/fixtures`, apart from the public language base.

`composition.sources` decides which source roots a workspace captures; `composition.systems` names its vocabulary owners. Composing a system does not capture every record that uses its words. Declare a source root in one `@workspace` only: when two workspaces declare the same root, `ia position` without `--seat` can no longer pick the default workspace seat.

A `@distribution` selects native release roots. Packing expands the selected system folders and resolves their dependencies; the archive's bytes and manifest carry the exact closure. Root release-control sources at `.ia/src/releases/<distribution-name>.ia` contain exactly their distribution declaration and its system roots, and archive verification enforces that profile. Keep repository work, examples and release controls outside vocabulary payloads, so adopters receive language definitions rather than this repository's tasks.

The current CLI reads a compatible lock written by a 2.x CLI without rewriting it. Its first applied `init`, `install` or `update` moves the lock to a newer distribution engine that the 2.x CLI cannot read, and each archive's minimum engine requirement still applies; `ia remove` keeps the existing engine marker. The [distribution guide](../../../apps/distribution/README.md#distribution-engine-compatibility) covers the refusals, backups and the return to 2.x.

See the [language guide](../language/README.md), [package reference](../packages/README.md), [public examples](../../../examples/public-language/README.md), [runtime contract](../../../packages/runtime/SPEC.md), [database contract](../../../packages/db/SPEC.md), [workspace runtime contract](../../../packages/workspace-runtime/SPEC.md) and [npm publishing guide](../../../tools/distribution/NPM-PUBLISHING.md) for the detailed contracts.
