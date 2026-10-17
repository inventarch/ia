# First-party installed captured-source read

The operator approved first-party statically imported governed read adapters for the initial installed slice. This boundary does not admit executable plugins, third-party imports or private expert methodology. The producer layout remains `.ia/src/systems`; release selection remains owned by the packaging task.

The implementation extends the existing `Corpus` read consumer through an installed descriptor and adapter, the existing native harness compiler, execution-manifest conversion and Engine. It reads exact retained native capture bytes only. It does not load an operation from a source path, add filesystem access, issue grants or mutate a store. StageE `executeOwned` constraints remain unchanged.

The host retains an exact capture, compiled harness, installed catalogue and execution manifest and owns current grants. A required current-capture callback supplies fresh source identity without choosing executable code. The adapter checks the whole executable manifest, selected installed operation/validator descriptors and actual installed first-party code bytes; it requires Engine's current-authority callback before and after reading. A repeatable retry uses the same checks. Installation and catalogue compilation never invoke the read consumer.

Qualification must establish ordinary installed root exports, bounded captured reads, explicit refusal of outside paths and forged arguments, absent/expired/revoked grants and denied effects, changed source/code/catalogue/manifest pins, cancellation and close, policy evaluation, repeatable recovery with retained accounting and fresh authority, and no invocation during installation. Windows evidence alone cannot qualify other platforms. The fake model used for qualification does not establish live provider behavior or production tenant authorization.

Use the existing root exports `INSTALLED_READ`, `installedReadCatalog` and `installedReadAdapters`; no new package subpath or module loader is needed. Merge the catalogue fragment's validators and operations into the host's explicit `CompositionCatalog`. Its fixed operation identity is `authoring-system/binding/operation/read-captured-source`, implementation `captured-source-read-v1`, handler `ia.captured-source.read.v1`. The native operation's physical owner must be `agent-composition-system`, with governed-v1, read-only effects, repeatable recovery and the fixed input/output validator ids. An authored or adopted occurrence may select that first-party binding; the path supplies data and never executable code.

The native [operation](../operations/read-captured-source.ia) implements the dedicated `REQ-RT-CAPTURED-INPUT`, `REQ-RT-CAPTURED-READ` and `REQ-RT-CAPTURED-REFUSE` clauses in the [runtime contract](../contract.ia). The [canonical execution binding](../records/read-captured-source-binding.ia) is available for explicit host selection; no shipped production harness selects it. Its presence grants no operation or effect. The [success and authority-refusal cases](../cases/read-captured-source.ia) name `tests/installed-read.test.ts`, which reads their admitted operation, contract and result declarations while checking actual retained-byte reads and authority refusals. The portable fixture selects this same binding in its test-owned harness.

After ordinary `compileHarness` and `executionManifest`, bind:

```ts
const read = installedReadAdapters(capture, {
  manifest, compiled, catalog, principal,
  currentCapture: () => hostOwnedCurrentCapture(),
});
const operations = { ...otherFirstPartyAdapters, ...read.operations };
// Supply operations to EngineHost; that host also owns authorization,
// full current-manifest/code verification, policy evaluation and preflight.
// Retain the captured reader throughout this host/session ownership.
```

Call `read.close()` when the owning host/session ends, after in-flight reads settle. Keep it open while a session may wait, resume or retry. Closing immediately after binding causes the first dispatch to refuse.

The constructor reconstructs the whole execution manifest and recompiles the selected harness from the same retained capture. A rehashed but forged compiled object therefore cannot establish the binding. This first slice uses a common task/definition capture; a separately retained hosted definition capture is not implicitly admitted. The host callback returns a current verified Capture, not a boolean assertion of freshness or a module path. It is never called during catalogue creation, compilation or adapter construction. Actual reads require a real Engine `assertCurrent` consumer before and after the read, a current permitted profile/agent, principal, workspace, operation, effect, capture and grant deadline. All required compiled evaluators and preflight remain Engine responsibilities; a forged no-op callback is not independently authenticated authority.

Inputs are a closed object with exact captured `path`, optional zero-based `start` (0–100000) and `limit` (1–400). Extra root, actor, module, source or authority selectors refuse. Inputs are snapshotted before awaits. The operation exposes only the existing Corpus read path, with a 10-second contract, 65536-byte complete-output ceiling, exact capture revision and one citation. It returns effect none, never draft artifacts, filesystem reads beyond the capture, writes or store access. An oversized result refuses rather than truncating data into an unpinned contract.

Installed byte hashing reuses the fixed installed first-party package entrypoints; it does not discover plugins or attest a signed release or already-loaded process code. Trusted release selection, an immutable deployment and actual host authority remain required. Captured native data are scoped at the granted Capture revision; this is not a new tenant or database authorization mechanism.

`tests/installed-read-fixture.mjs` runs under ordinary Node against installed root exports with deterministic fake-model adapters and memory/SQLite stores. Its optional `--mutate-installed-code` flag is only for a disposable installed consumer: it replaces and restores that consumer's fixed module directory entry to test byte drift before read and retry, without writing through pnpm store hard links. Final published namespace, public native operation selection and archive safety remain the release owner's separate qualification.
