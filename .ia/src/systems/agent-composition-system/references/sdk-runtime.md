# Public SDK onboarding over existing exports

The supported executable recipe is plain JavaScript over built package exports. This documents current SDK evidence, not a product decision excluding a future CLI. It changes no native loader or binding semantics.

Start from the packaging owner's selected public tree, compiled archives and extraction receipt. Producer sources remain under `.ia/src/systems`. The fresh consumer installs ten receipt-selected current archives and dependencies; its native input is data copied from the public candidate.

The public packages retain the qualified Node profile `>=22.22.0 <23`. Current installed qualification used Node 22.22.0 on Windows, including `node:sqlite` under ordinary Node without additional flags. This does not qualify every platform or matching runtime. See the [versioned SQLite API reference](https://nodejs.org/download/release/v22.22.0/docs/api/sqlite.html).

```sh
node tools/runtime/qualify-sdk.mjs <public-tree> <archives-directory> <new-output-directory> <pnpm.cjs> <populated-offline-store>
```

The helper records extraction provenance and archive hashes, installs offline with lifecycle scripts disabled, then runs `tests/sdk-runtime/recipe.mjs` under ordinary Node without tsx or development conditions. `qualification.json` is local candidate evidence, not registry provenance or acceptance of unexamined archive contents. The packaging owner retains archive safety and public selection responsibility. The helper accepts the current archive namespace; renamed published packages require the corresponding qualified recipe.

The recipe uses existing `captureWorkspace`, `compileHarness`, `installed`, `executionManifest` and `Engine` exports. Neutral fixture bytes enter an authored example system in the capture and undergo normal admission/compilation. Files use `.ia.fixture` so test records cannot become framework records. The installed catalogue supplies validators, outcomes, mandate, context, host, model, mapping, entry, read operation and evaluator contracts. Native profiles select the mandate and read capability; installed mandate checks select the concrete before-effect evaluator. Method prose supplies instructions and cannot grant authority.

The host owns current grants, principal/workspace identity, full-manifest and source verification, implementation identity, input/context bounds, model and operation adapters. The fixture hashes installed runtime code plus its recipe/fixture bytes. It compares current full manifests, captured revisions and installed bytes; the read adapter asserts authority again before returning a bounded supplied public label. This is an explicit fake host for qualification, not a production grant service, tenant model or third-party loader.

Memory and SQLite prove one read, delegated child completion, typed clarification and exact reply, then completion after five scripted model calls. A failed repeatable read retries with the same invocation identity and retained accounting. Scheduler restart performs no new calls/effects; SQLite close/reopen retains completion. Negatives cover invalid task, another principal, changed catalogue pins, absent evaluator, stale question digest, operation revocation, stale manifest and failed evaluator. Revocation/stale-manifest failures spend no operation budget. Failed evaluation prevents adapter execution while retaining attempt accounting. No credentials, live provider, paid model call or write operation is used.

Application owners must replace fake adapters with explicit scoped authority and provider/operation consumers and qualify tenant isolation, writes and recovery before claiming production suitability. Local expert gates require explicitly adopted public policy and real enforcement. Private expert methodology remains in API workspaces and never downloads.

The user approved the first-party statically imported governed read boundary, documented in [installed-read.md](installed-read.md). Third-party executable code remains excluded. This earlier fake-adapter recipe remains existing-export evidence; the separate installed-read fixture qualifies the approved adapter against the final selected archives.
