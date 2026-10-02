# InventArch advisory PR review caller

This owner contains the dependency-free Node 22 caller, its TypeScript declarations and behavioral tests. The [workflow](../../.github/workflows/inventarch-review.yml) loads the caller from the default branch after a completed Public quality pull-request run, or through manual dispatch with that run's ID. Repository configuration explicitly enables it; [README.md](README.md) describes the API binding and activation variables.

`runner.mjs` treats PR source and downloaded execution evidence as data. It never checks out or executes PR code. It validates the upstream workflow, repository, open PR and current base/head identities before disclosure. An execution commit distinct from the reviewed head must have the exact current base/head merge parents. Ambiguous associations, stale revisions and conflicting execution commits refuse.

Source collection reads pinned Git trees and blobs, verifies blob identity and retains base/head versions, the head path inventory and omissions. Credential-like paths, unsupported files and symlinks are excluded. Bounds include 400 changed paths, 1.7 MB of source, 0.8 MB of task evidence and a 3 MiB serialized subject. Missing evidence and omitted source remain explicit review limitations; they do not establish clean approval.

The caller exchanges GitHub OIDC identity for a review-only API token using the configured HTTPS origin and account-owned repository binding. It uploads a SHA-256-addressed subject, starts or reuses a review keyed by run, attempt and head, and advances bounded inspection passes. A review without a result at the caller deadline is cancelled. Model credentials and inference execution belong to the API, not this owner.

Delivery renders the retained advisory verdict, findings, evidence gaps and provenance as a GitHub review with event `COMMENT` bound to the reviewed commit. A final PR read suppresses closed or stale-head delivery; a bot-authored review with the same commit and stable review marker suppresses duplicate delivery. Review text escapes supplied Markdown/HTML and mentions and refuses bodies over 60,000 bytes. It neither grants approval nor blocks merging. The retained result artifact is distinct from a successful delivery receipt.

`runner.test.ts` qualifies collection, refusal, rendering and delivery with simulated GitHub responses. The `tools:test-review` task owns these tests. Local tests establish caller behavior, not hosted API activation, live-model calibration or production delivery. Hosted deployment owns those broader gates.
