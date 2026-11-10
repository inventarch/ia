# Public interoperability contracts

`@inventarch/service-contracts` owns browser-safe structural service wire contracts under the Apache-2.0 license. Zod is its only runtime dependency. Importing any export initializes no filesystem, network, identity, native runtime, provider or storage. Installed consumers use emitted JavaScript and declarations; development source conditions are removed during packing.

| Export | Contract owner |
|---|---|
| `.` | Version/limits, binding, offering/operation descriptors, invocation and attachment, capture requests/refusals, session start/advance/recovery/control, questions/proposals, public sessions/events/pending/results, errors, strict decoding and JSON Schema |
| `./tenancy` | Organization, department, membership and workspace commands/views/pages |
| `./sources` | Exact source references, upload/commit/activation/history/admission and bounded file chunks |
| `./session-lifecycle` | Directory summaries, continuation and deadline renewal intent |
| `./source-apply` | Exact candidates, preparation, review, application and bounded inspection |
| `./marketplace` | Native release descriptors, build/publish/withdraw requests, release pins and terms, catalog pages, the distribution lock, acquisition quotes/receipts, bounded artifact chunks, and registry kit and workspace indexes |
| `./installation` | Installation planning, explicit review, application and inspection |

Objects reject unknown fields. Four fields accept any JSON value, which the host validates: `invocation.input`, `captureRequest.capture`, `exactQuestionReply.answer` and `publicProposal.candidate`. Selectors, permissions in a published view, command IDs, digests and opaque tokens are data, never grants. Exact source byte verification, semantic admission, current tenancy authorization, disclosure filtering, replay, scheduler fencing and effects belong to an independently supplied host. No SQL directory, marketplace implementation, transport or inspection method is included. Internal compatibility exports expose the same pure modules; they do not expand authority.

## Entry points

`.`: `SERVICE_VERSION` is 1. `LIMITS` holds `requestBytes` 768 KiB, `responseBytes` 256 KiB, `pageItems` 100, `offerings` 100 and `operations` 32. An `id` matches `[A-Za-z0-9._-]{1,128}`; a `digest` is 64 lowercase hex characters. An `operationDescriptor` declares one to four effects (`read`, `model`, `write`, `external-write`) and input and output bounds within `LIMITS`; an `offeringDescriptor` holds one to 32 operations. A `publicSession` carries states and counts, never model text, manifests or grants.

`.` errors: `decode(schema, value)` returns the parsed value or throws `ServiceError` with category `invalid` and code `invalid-request`. A `ServiceError` carries a category, a code and, optionally, a `capture` refusal checked against `captureFailure`. `failure(error)` returns the `errorResult` `{code, category, message, capture?}` of a `ServiceError`, its message cut to 500 characters, and `{code: 'internal', category: 'internal'}` with a fixed message for any other error. `status` maps each category to its HTTP status: `invalid` 400, `unauthenticated` 401, `forbidden` 403, `not-found` 404, `conflict` 409, `expired` 410, `quota` 429, `unavailable` 503 and `internal` 500. `jsonSchema(schema)` returns draft-07 JSON Schema and throws for a schema it cannot represent.

`./tenancy`: each command carries `commandId` and `expectedRevision`, which is 0 for `createOrganizationRequest`. Roles are `owner`, `admin`, `editor` and `viewer`; a department membership cannot grant `owner`. A view carries `commandRevision` only for an administrator. A personal workspace has no organization or department, and an archived workspace's permissions hold no `write` or `execute`. A `directoryReceipt`'s ids must fit its `action`. A page holds at most 100 items and a host-signed `next` cursor of at most 2,048 characters.

`./sources`: `SOURCE_LIMITS` holds the source bounds, among them 100 files, 256 KiB per source and 512 KiB per revision. `isOwnedSourcePath` admits a portable NFC path under `.ia/src/` that ends in `.ia`, has at most 500 characters and lies outside `.ia/src/floor/`: no empty, `.` or `..` segment, no segment ending in a dot or a space, no backslash, control or `<>:"|?*` character, and no Windows device name. A source manifest's paths must not collide in letter case. A file chunk request reads at most 32 KiB, returned as base64 `data`.

`./session-lifecycle`: a session list page holds at most `LIMITS.pageItems` summaries. A `sessionContinuation` states one of `executable`, `renewal-required`, `runtime-incompatible`, `authority-denied`, `evidence-unavailable`, `unsupported-wait`, `budget-exhausted` or `terminal`, with a renewal `{token, deadline}` or null. A continue request names a new session `id` that differs from `sessionId`.

`./source-apply`: a `sourceChangeCandidate` (plain names are read: `source-change` with `formatVersion` 1, and the released literal `ia.source-change.v1` with none; the released literal is what the distribution writes until the follow-up release flips its switch, dec-008, A15) holds one to 100 changes, sorted by path and distinct in letter case. Each change must change the bytes, and none deletes an absent file. Its new text totals at most 512 KiB. A review states a rationale of 1–4,096 characters. Inspection returns proposals, one application, or a file chunk of at most 32 KiB.

`./marketplace`: a `packageId` is a lowercase `<scope>/<name>` of at most 256 characters. A `releaseDescriptor` has `formatVersion` 1 and language `1.0`. `releaseTerms.text` admits 1–16,384 characters, enough for the complete Apache-2.0 text; `license` and `revision` admit 1–128. A `distributionLock` holds 1–100 requests and 1–100 packages. An artifact read asks for at most 96 KiB, and a chunk's `data` holds at most 128 KiB of text. The registry indexes are read as `registry-kit` and `registry-workspace`, each declaring `formatVersion` 1, or as the released literals `ia.registry-kit.v1` and `ia.registry-workspace.v1` with none; the released literals are written until the follow-up release flips the distribution's switch (dec-008, A15). Each has at most 1,000 releases.

The `distributionLock`, `releaseDescriptor` and `installationPointer` schemas accept an optional plain `format` beside `formatVersion` 1 (`distribution-lock`, `release-descriptor`, `activation-pointer`), as the released documents carry `formatVersion` alone (decision dec-008).

`./installation`: a plan request names `install`, `update` or `remove`. A review states a non-blank rationale of at most 4,096 characters, and an apply names the reviewed plan, digest and decision. An `installationPointer` has `formatVersion` 1 and a counter of at least 1. Inspection reads the `current` installation or one `plan`.

## Release qualification

The original strict codec tests remain public obligations rather than being renamed or removed. Release qualification (`pnpm packages:qualify`) inspects each packed archive's dependencies and exports, checks that no development condition reaches the published `exports`, installs the packed package in a consumer and imports every subpath. `tools/dependencies/check.ts` refuses any import but `zod` and the package's own modules. No browser bundle is built. This proves an installable emitted boundary, not hosted authentication, deployment, registry publication or a complete application journey.
