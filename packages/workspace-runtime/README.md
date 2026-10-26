# @inventarch/workspace-runtime

[![npm](https://img.shields.io/npm/v/@inventarch/workspace-runtime?label=npm)](https://www.npmjs.com/package/@inventarch/workspace-runtime) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.22.0%20%3C23-brightgreen)](package.json)

> `@inventarch/workspace-runtime` is the generic workspace runtime above [`@inventarch/db`](../db/README.md) and [`@inventarch/runtime`](../runtime/README.md). It captures and adopts workspace sources, resolves captured teaching resources, lifecycle context and templates, validates and publishes candidates, joins `@execution-binding` records to the installed catalog, and generates the host agents, skills and hook declarations that `ia host` applies. The `ia` CLI, the runner, the distribution tooling and the edit guard build on it.

## ⚡ Quick start

```sh
npm install @inventarch/workspace-runtime
```

Capture the Pantry workspace from the [walkthrough](../../docs/guide/walkthrough.md) and read its records back from the captured bytes:

```js
import { captureWorkspace, Corpus } from '@inventarch/workspace-runtime';

const capture = captureWorkspace('path/to/pantry');
console.log(capture.sources.filter(({ path }) => /^\.ia\/src\/[^/]+\.ia$/.test(path)).map(({ path }) => path));

const corpus = new Corpus(capture);
try {
  const plan = corpus.records().find(({ identity }) => identity === 'work-system/definition/plan/shopping-list');
  console.log(plan.band, plan.source.path);
} finally {
  corpus.close();
}
```

```text
[
  '.ia/src/checks.ia',
  '.ia/src/evidence.ia',
  '.ia/src/rules.ia',
  '.ia/src/shopping-list.ia',
  '.ia/src/workspace.ia'
]
100 .ia/src/shopping-list.ia
```

`captureWorkspace` reads the exact source bytes, including the language floor and installed distributions, into an in-memory capture whose `revision` digests its `id` and every source with its placement; `verifyCapture` refuses one whose bytes no longer match that digest. `Corpus` admits records from those bytes alone. This capture writes nothing and is separate from the `.ia/work/snapshot/` pair that `ia capture` writes.

## 🧭 What it does

| Entry point | Use it for |
| --- | --- |
| `.` | `captureWorkspace`, `adoptWorkspace`, `verifyCapture` and `Corpus`, plus `candidateValidation`, `managedPublication` and `installedImplementationDigest`. |
| `./corpus` | The capture and adoption API on its own. `Corpus` also offers `context(grant)` and `adapter`, the `ia.corpus.inspect.v1` operation that lists, reads, searches and resolves captured sources. |
| `./bind` | `executionBindings` and `bindExecution`: join each `@execution-binding` to the installed-implementation catalog as `bound`, `unavailable` or `revoked`. |
| `./resources`, `./resource-format`, `./resource-sources` | `captureResources`, `verifyResources` and `resolveResources`: capture, verify and resolve the teaching resources that records cite. |
| `./projections` | `compileProjection` compiles a projection descriptor over a capture and its resources into an `ia.projection-result.v1` result; `claudeProseCatalog` and `codexProseCatalog` build the host catalogs. |
| `./templates` | `renderCapturedTemplate` renders a captured `@template`. |
| `./lifecycle`, `./lifecycle-profile` | `prepareLifecycleContext` and `prepareScopedContext` assemble lifecycle context; `lifecycleProfile` returns a host's lifecycle profile. |
| `./authoring`, `./authoring-manifest`, `./authoring-format`, `./authoring-types` | `resolveAuthoring` and `prepareAuthoringTarget` over the authoring index; `captureAuthoringManifest` and `openLocalAuthoringView` over `.ia/authoring.resources.json`. |
| `./sources`, `./local-store`, `./adapters`, `./installed-catalog` | Source policies (`createSourcePolicy`, `homeSourceCapture`, `admitSourceCapture`), `createLocalStoreAdapter`, `verifyInstalledAdapter` and `installedImplementationDigest`. |
| `./candidate`, `./publication`, `./task-capture-format` | `candidateValidation`, `managedPublication`, and task-capture decoding (`taskCaptureRequest`, `taskCaptureSelection`). |

### Host generation

`ia host claude` and `ia host codex` take their generated files and hooks from this package, through the `./internal/generate` subpath, and apply them with the CLI's one projection writer. `ia project` writes the same generated files. It never creates a hook registration: the first one needs `ia host claude --apply`. After that, `ia project --apply` keeps the registered groups in step with the authored `@hook` records, adding and removing groups. Generation renders only records the workspace authors (band 100) and reads the records they reference at any band; installed and adopted records render nothing.

| Authored record | Claude Code | Codex |
| --- | --- | --- |
| `@agent-profile` | `.claude/agents/<name>.md` | Reported unsupported |
| `@playbook` | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| `@hook` for PreToolUse on Write, Edit or MultiEdit, with paths | One edit-guard group in `.claude/settings.local.json` | Reported unsupported |
| `@operation`, `@harness` | Definitions in the projection receipt | Definitions in the projection receipt |

A record that a host cannot take is listed in the receipt's `unsupported` section with its reason, and one such record never blocks the others. The `./internal/*` subpaths serve the toolchain and are not a stable contract.

### Host plugins

Two more toolchain subpaths serve host plugins. `renderPlugin`, on `./internal/generate`, renders the plugin directory that a workspace's one authored product `@distribution` describes: a manifest for each host its `product.hosts` lists, a skill for each authored `@capability` a model or user invokes, and an agent file for each invoked `@agent-profile`. `ia project <claude|codex> --product plugin --out <directory> --apply` writes it to an absent or empty directory. `./internal/host-plugin` reads an existing Claude, Codex or Grok plugin, lowers it into records with a lowering map and a generated `MIGRATION.md`, and compares a rendered plugin with the original file by file; `ia init <directory> --from <plugin-directory>` and `ia project <claude|codex> --product plugin --check --compare <plugin-directory>` use it. What this version cannot lower and render back exactly, such as hooks, MCP or LSP configuration and `commands/`, is reported as unresolved, never guessed.

## ⚖️ What it does not do

- **Generation writes nothing.** It returns files, hook declarations and definitions; the CLI writes them and the receipt.
- **It executes no authored operation.** An `@operation`'s handler and validator ids are catalog keys, never imported, resolved or run here. `bindExecution` loads nothing: `bound` establishes compatibility with the installed catalog, not that an operation ran.
- **Publication is its one write.** `managedPublication` returns the `draft.publish` operation, effect `local-write`. Its adapter writes a reviewed candidate's files to the bound `destination` only when a session host executes it with the exact reviewed input, grant and current owner. No other module here writes a file; the local store adapter calls the storage port its host supplies.
- **A generated hook is a registration, not proof of enforcement.** The host runs the guard; `ia doctor` reports whether the registration and its receipt are current.
- **It compiles no harness.** The composition compiler lives in `@inventarch/agent-composition-system`, which depends on this package; no module here imports it.

## 📚 Learn more

- [SPEC.md](SPEC.md): the workspace runtime contract: its public entry points, host generation (SPEC W01 to W04), host plugins (W05 and W06) and execution binding (W07).
- [LANGUAGE.md](LANGUAGE.md): the public vocabulary this release carries.
- The [root README](../../README.md) and the [architecture reference](../../docs/reference/architecture/README.md).
- Related packages and apps: [`@inventarch/db`](../db/README.md), [`@inventarch/runtime`](../runtime/README.md), the [CLI guide](../../apps/cli/README.md) and the [edit guard](../../apps/steward-hook/README.md).
