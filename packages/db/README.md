# @inventarch/db

[![npm](https://img.shields.io/npm/v/@inventarch/db?label=npm)](https://www.npmjs.com/package/@inventarch/db) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.22.0%20%3C23-brightgreen)](package.json)

> `@inventarch/db` reads an IA workspace from disk. It discovers the workspace's `.ia/src` sources, installed distributions and adopted mounts, admits them through `@inventarch/language`, `@inventarch/graph` and `@inventarch/compliance`, and serves the admitted records through scoped read handles. [`@inventarch/runtime`](../runtime/README.md), the `ia` CLI and the other IA apps read workspaces through it.

## ⚡ Quick start

```sh
npm install @inventarch/db
```

Read the workspace from the [root README quick start](../../README.md#-quick-start) without writing to it:

```js
import { open } from '@inventarch/db';

const workspace = open('path/to/your-project', { cache: false });
try {
  const { token } = workspace.resolveScope();
  const decision = workspace.get('work-system/definition/decision/api-response-format', { within: token });
  console.log(decision.band, decision.source.path);
  console.log(workspace.resolveSeat('.ia/src/decision.ia', { within: token }));
} finally {
  workspace.close();
}
```

```text
100 .ia/src/decision.ia
{
  path: '.ia/src/decision.ia',
  seat: 'workspace-system/definition/workspace/my-project',
  by: 'root',
  claimants: []
}
```

`open` admits the workspace once. `resolveScope` issues an opaque token, and every read that passes it as `within` stays inside that scope. Band 100 marks a record the workspace authors. `cache: false` makes the open fully read-only. Without it, the handle keeps a disposable graph cache at `.ia/.iadb/graph.json`; a handle opened with `checks: 'structural'` or `evidence: true` never reads or writes that cache. The `.ia/.gitignore` that `ia init` writes does not list `.iadb/`, so add it to your ignore file.

## 🧭 What it does

| Export | Use it for |
| --- | --- |
| `open(root, options)` | Discover and admit a workspace and return a `Handle`. `checks: 'structural'` admits `@check` records the way `ia validate`, `ia preview` and `ia author` do. `evidence: true` also reads the evidence recorded for the current authored revision, at runtime placement (band 0). `conformance: 'verify'` verifies COMP-KERNEL and COMP-FIXTURES in-process; the editor readers take it too. `adopted`, `authoredRoots`, `floor` and `locations` replace discovered inputs; see [SPEC.md](SPEC.md). |
| `resolveScope(request)` | Issue a scope token for a root, a phase or a list of identities. A child scope only narrows. |
| `get`, `records`, `snapshot`, `search`, `traverse`, `resolve`, `referencedBy`, `directedView` | Read admitted records and their relationships through a token. |
| `resolveSeat`, `roots`, `words` | Find the seat a path is declared at and the records that claim it, the declared source roots, and the registered words. |
| `report`, `refused`, `unadmitted` | Admission findings and the records admission left out, for privileged host inspection. |
| `revision`, `authoredRevision`, `staleness`, `readiness`, `refresh()` | Track change. The authored revision leaves out runtime-placed sources such as `ia validate` evidence; `staleness` and `readiness` compare a record with the previous retained snapshot. |
| `preview(changes)` | Admit in-memory drafts against the current sources without writing anything. |
| `planCapture`, `writeCapture` | Plan or write the capture pair under `.ia/work/snapshot/` that `ia capture` maintains. |
| `bindChecks`, `writeEvidence`, `readEvidence` | Bind each `@check` to an evaluator and keep the `@observation` evidence `ia validate` records under `.ia/work/evidence/`. |
| `writeRunnerEvidence` | Record a verified runner journal under `.ia/work/runner-evidence/`. |
| `readWorkspaceBytes(root, path, limit)` | Read one workspace file's exact bytes, refusing links, escaping paths and files over the limit. |
| `DbError`, `DB_CODES` | Every operational refusal is a `DbError`. Its `code` is one of the eleven `IA-DB-*` codes in `DB_CODES`, and its optional `path` names the workspace-relative entry at fault. An installation refusal is an `InstallationError` from `@inventarch/db/distribution`, a `DbError` that adds a `reason`. A `readWorkspaceBytes` limit or a capture text of the wrong form is a `TypeError`. |
| `@inventarch/db/editor` | `EditorDatabase` and `EditorSnapshot`: cache-free readers with unsaved overlay buffers. |
| `@inventarch/db/distribution` | Strict decoders and canonical bytes for release descriptors, manifests, locks, generation membership, activation pointers and the installed-implementation catalog, and `readInstalledGeneration`, which verifies the active installed generation. |
| `@inventarch/db/descriptors` | Pure, bounded compilers for `domain-model`, `storage-binding` and `app-composition` descriptor resources; see [their contract](src/descriptors/SPEC.md). |

The `./internal/*` subpaths serve specific toolchain consumers and are not a stable contract.

## ⚖️ What it does not do

- **It never writes authored source.** Its only writes are the disposable cache, which `cache: false` turns off, and the capture pair and evidence files, each only when you call its writer.
- **It makes no network request and no installation write.** Reads verify installed distributions and refuse missing, corrupt or drifted state. Acquiring and installing archives belongs to the application, such as the `ia` CLI.
- **Admission is not evaluation.** Opening a workspace runs no conformance suite unless you pass `conformance: 'verify'`, which runs `@inventarch/compliance`'s `package-v1` profile in the same process, and never a prose case. `bindChecks` runs no evaluator that is not built in: such a check stays `not-evaluated`, which is never a pass.
- **A scope narrows reads; it does not decide who reads.** Unscoped reads and issuing independent scopes are privileged host inspection, and the host that holds the handle decides what it discloses. Call `isCompleteScope(token)` before you show `report`, `refused` or `unadmitted` to a reader: only a whole-workspace scope may disclose them.
- **Evidence is not attestation.** A runner journal's hash chain establishes internal integrity, not an external observer, authorized execution or real-world effects.

## 📚 Learn more

- [SPEC.md](SPEC.md): the database contract for revisions, scopes, retention, capture and evidence.
- [LANGUAGE.md](LANGUAGE.md): the public vocabulary this release carries.
- The [root README](../../README.md) and the [architecture reference](../../docs/reference/architecture/README.md).
- Related packages: [`@inventarch/language`](../language/README.md), [`@inventarch/graph`](../graph/README.md), [`@inventarch/compliance`](../compliance/README.md) and [`@inventarch/runtime`](../runtime/README.md).
