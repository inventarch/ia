# IA package reference

[![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../../../LICENSE)

> This page indexes every package this repository publishes and where each one is documented. The [architecture reference](../architecture/README.md) explains which package to use for what and how they depend on each other; this page sends you to each package's own guide and contract.

Every package keeps its documentation beside its code, and the same files ship in its npm tarball:

- `README.md` is the guide: what the package is for, a quick start and its entry points.
- `SPEC.md` is the contract: the behavior, limits and refusals the package's tests hold it to.
- `LANGUAGE.md` is the generated language summary: the words the release ships.

Use the entry points listed here. The `./internal/*` subpaths are published for specific toolchain consumers and are not a stable contract.

## Library packages

| Package | Guide | Contract | Public entry points |
| --- | --- | --- | --- |
| `@inventarch/language` | [README](../../../packages/language/README.md) | [SPEC](../../../packages/language/SPEC.md) | Root; `./editor` |
| `@inventarch/graph` | [README](../../../packages/graph/README.md) | [SPEC](../../../packages/graph/SPEC.md) | Root |
| `@inventarch/compliance` | [README](../../../packages/compliance/README.md) | [SPEC](../../../packages/compliance/SPEC.md) | Root |
| `@inventarch/db` | [README](../../../packages/db/README.md) | [SPEC](../../../packages/db/SPEC.md) | Root; `./editor`, `./distribution`, `./descriptors` |
| `@inventarch/runtime` | [README](../../../packages/runtime/README.md) | [SPEC](../../../packages/runtime/SPEC.md) | Root; `./editor`, `./authoring`, `./authoring-execution`, `./entry` |
| `@inventarch/workspace-runtime` | [README](../../../packages/workspace-runtime/README.md) | [SPEC](../../../packages/workspace-runtime/SPEC.md) | Root and twenty subpaths, which its README lists |
| `@inventarch/kb` | [README](../../../packages/kb/README.md) | [SPEC](../../../packages/kb/SPEC.md) | Root; `./legacy`, `./protocol` |
| `@inventarch/service-contracts` | [README](../../../packages/service-contracts/README.md) | [SPEC](../../../packages/service-contracts/SPEC.md) | Root; `./sources`, `./tenancy`, `./session-lifecycle`, `./source-apply`, `./marketplace`, `./installation` |

### `@inventarch/language`

The `.ia` language in pure TypeScript, with no I/O and no dependencies. The root reads and writes text (`scan`, `parse`, `buildRegistry`, `compile`, `format`, `checkFormatPreservation`), resolves references (`references`, `resolveTarget`) and identities (`identityOf`), and carries the kernel tables, `LANGUAGE_VERSION`, the closed diagnostic codes `LANG_CODES` and the embedded floor (`KERNEL_SOURCES`, `KERNEL_DIGEST`). `./editor` projects sources to zero-based positions (`projectSource`, `cursorContext`) and makes single-record edits that return the whole file (`appendRecord`, `addRelationship`, `setField`, `annotateRecord`).

### `@inventarch/graph`

An immutable typed graph over compiled records. It depends only on `@inventarch/language` and reads no files. `load(records, registry, options)` picks one winner per identity by band, resolves edges, rechecks their consent and indexes the winners. Queries are `resolve`, `traverse`, `claimants`, `selects`, `search` (BM25), `variants` and `cell`; revisions and digests come from `revisionOf`, `authoredRevisionOf`, `recordDigest` and the canonical JSON codec (`canonical`, `digest`).

### `@inventarch/compliance`

Turns compiled records and graphs into verdicts. `evaluate(graph, options?)` assembles one immutable report from schema checks, system admission, graph checks and contract adoption with evaluators you supply. The package also builds trusted evaluator catalogs (`createEvaluatorCatalog`, `bindEvaluators`), resolves obligations and admits transitions on receipts (`resolveObligations`, `validateReceipt`, `admitTransition`), produces opt-in `COMP-KERNEL` and `COMP-FIXTURES` evidence (`verifyKernel`, `verifyFixtures`) and renders the user-level Claude Code plugin (`renderClaudePlugin`).

### `@inventarch/db`

Reads an IA workspace from disk. `open(root, options)` discovers `.ia/src` sources, installed distributions and adopted mounts, admits them through language, graph and compliance, and returns a scoped read handle. The root also exports `readWorkspaceBytes`, the capture pair (`planCapture`, `writeCapture`), check binding (`bindChecks`), evidence (`writeEvidence`, `readEvidence`, `writeRunnerEvidence`) and its errors (`DbError`, `DB_CODES`). `./editor` holds `EditorDatabase` and `EditorSnapshot`, `./distribution` the strict decoders and verified readers for descriptors, manifests, locks and generations, and `./descriptors` the pure resource-descriptor compilers. It writes only the disposable graph cache, the capture pair and evidence, each on request.

### `@inventarch/runtime`

Turns scoped database reads into what agents and hosts consume: `position` (a scope-key body with its digest and host note), `deliveryView` (the plan view `ia next` prints), `readBody` and `parseLocator` (for `ia read`), `renderPacket` and `renderHost` (the host position packets), mandate resolution (`governingMandates`, `defaultActor`, `profileRefusal`, `evaluateMandateGuard`) and the `Door` machine protocol that `MACHINE_PROTOCOL` describes. `./authoring-execution` exports `executeCatalog`, guarded dispatch over a host catalog. Its only writer is create-only managed publication (`preparePublication`), which requires a local Windows NTFS volume.

### `@inventarch/workspace-runtime`

The Node workspace runtime above `db` and `runtime`, used by the CLI, the distribution tooling, the runner and the edit guard. The root captures and adopts workspaces (`captureWorkspace`, `verifyCapture`, `adoptWorkspace`) and admits records from captured bytes alone (`Corpus`); it also exports `candidateValidation`, `managedPublication` and `installedImplementationDigest`. Its subpaths cover execution binding (`./bind`, which loads and executes nothing), teaching resources, projections (`compileProjection`), templates (`renderCapturedTemplate`), lifecycle context, authoring views, source policy, adapters and candidates.

### `@inventarch/service-contracts`

Browser-safe Zod wire contracts between an IA service host and its clients. Zod is its only dependency, and it validates shape only. The root exports `decode` (a strict parse that throws `ServiceError`), `jsonSchema` (draft-07), `failure` and the `status` HTTP map, `SERVICE_VERSION`, `LIMITS`, `z` and the offering, operation, invocation, session and capture schemas. The subpaths hold tenancy, sources, session lifecycle, source application, marketplace and installation schemas. Authentication, authorization, disclosure and effects belong to the host.

## Native system packages

Each native system publishes its own package from its folder under `.ia/src/systems/`. The five executable owners export JavaScript APIs and ship their native payload beside them; the six declaration-only packages export `./native.ia.tgz` and `./system-package.json`. The [language floor](../../../.ia/src/floor/README.md) ([contract](../../../.ia/src/floor/SPEC.md)) is the closed kernel every system builds on.

| Package | Guide | Contract | Public entry points |
| --- | --- | --- | --- |
| `@inventarch/agent-system` | [README](../../../.ia/src/systems/agent-system/README.md) | [SPEC](../../../.ia/src/systems/agent-system/SPEC.md) | Root |
| `@inventarch/agent-composition-system` | [README](../../../.ia/src/systems/agent-composition-system/README.md) | [SPEC](../../../.ia/src/systems/agent-composition-system/SPEC.md) | Root; `./tools` |
| `@inventarch/authoring-system` | [README](../../../.ia/src/systems/authoring-system/README.md) | [SPEC](../../../.ia/src/systems/authoring-system/SPEC.md) | Root |
| `@inventarch/session-system` | [README](../../../.ia/src/systems/session-system/README.md) | [SPEC](../../../.ia/src/systems/session-system/SPEC.md) | Root; `./sqlite` |
| `@inventarch/template-system` | [README](../../../.ia/src/systems/template-system/README.md) | [SPEC](../../../.ia/src/systems/template-system/SPEC.md) | Root |
| `@inventarch/compliance-system` | [README](../../../.ia/src/systems/compliance-system/README.md) | [SPEC](../../../.ia/src/systems/compliance-system/SPEC.md) | `./native.ia.tgz`, `./system-package.json` |
| `@inventarch/governance-system` | [README](../../../.ia/src/systems/governance-system/README.md) | [SPEC](../../../.ia/src/systems/governance-system/SPEC.md) | `./native.ia.tgz`, `./system-package.json` |
| `@inventarch/hook-authoring-system` | [README](../../../.ia/src/systems/hook-authoring-system/README.md) | [SPEC](../../../.ia/src/systems/hook-authoring-system/SPEC.md) | `./native.ia.tgz`, `./system-package.json` |
| `@inventarch/learning-system` | [README](../../../.ia/src/systems/learning-system/README.md) | [SPEC](../../../.ia/src/systems/learning-system/SPEC.md) | `./native.ia.tgz`, `./system-package.json` |
| `@inventarch/work-system` | [README](../../../.ia/src/systems/work-system/README.md) | [SPEC](../../../.ia/src/systems/work-system/SPEC.md) | `./native.ia.tgz`, `./system-package.json` |
| `@inventarch/workspace-system` | [README](../../../.ia/src/systems/workspace-system/README.md) | [SPEC](../../../.ia/src/systems/workspace-system/SPEC.md) | `./native.ia.tgz`, `./system-package.json` |

The words each system owns are in the [vocabulary catalogue](../language/vocabulary.md).

## Apps

| Package | Binary | Guide | Contract |
| --- | --- | --- | --- |
| `@inventarch/cli` | `ia` | [README](../../../apps/cli/README.md) | [SPEC](../../../apps/cli/SPEC.md) |
| `@inventarch/mcp-door` | `ia-mcp-door` | [README](../../../apps/mcp-door/README.md) | [SPEC](../../../apps/mcp-door/SPEC.md) |
| `@inventarch/distribution` | `ia-distribution` | [README](../../../apps/distribution/README.md) | [SPEC](../../../apps/distribution/SPEC.md) |
| `@inventarch/runner` | `ia-runner` | [README](../../../apps/runner/README.md) | [SPEC](../../../apps/runner/SPEC.md) |
| `@inventarch/steward-hook` | none; the host payload's launcher runs it as the edit guard | [README](../../../apps/steward-hook/README.md) | [SPEC](../../../apps/steward-hook/SPEC.md) |
| VS Code extension | none | [README](../../../apps/vscode/README.md) | [SPEC](../../../apps/vscode/SPEC.md) |

Command and host behavior that spans packages is specified once in the [implemented specifications](../../specs/README.md).
