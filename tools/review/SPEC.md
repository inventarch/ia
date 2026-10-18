# InventArch advisory PR review caller

This owner contains the dependency-free Node 22 caller, its TypeScript declarations and behavioral tests. The [workflow](../../.github/workflows/inventarch-review.yml) loads the caller from the default branch after a completed Public quality pull-request run, or through manual dispatch with that run's ID. Repository configuration explicitly enables it; [README.md](README.md) describes the API binding and activation variables.

`runner.mjs` owns the executable and API lifecycle. `github.mjs` owns bounded repository reads, pagination and upstream-run identity; `subject.mjs` owns immutable source and evidence collection; `result.mjs` validates result identity and delivers it; `render.mjs` owns presentation. Their transitive imports use local modules and Node built-ins, so workflow execution needs no dependency installation. Entry detection follows physical paths, including Windows junctions.

`runner.mjs` treats PR source and downloaded execution evidence as data. It never checks out or executes PR code. It validates the upstream workflow, repository, open PR and current base/head identities before disclosure. An execution commit distinct from the reviewed head must have the exact current base/head merge parents. Ambiguous associations, stale revisions and conflicting execution commits refuse.

Source collection reads pinned Git trees and blobs, verifies blob identity and retains base/head versions, the head path inventory and omissions. Credential-like paths, unsupported files and symlinks are excluded. Bounds include 400 changed paths, 1.7 MB of source, 0.8 MB of task evidence and a 3 MiB serialized subject. Missing evidence and omitted source remain explicit review limitations; they do not establish clean approval.

Invalid UTF-8 source is explicitly omitted after blob identity verification. Malformed gate JSON refuses with its evidence path and never discloses its body in the diagnostic. Branch protection and rulesets are read independently: available contexts are retained when the other read fails, while complete policy and passing checks remain unknown.

The caller exchanges GitHub OIDC identity for a review-only API token using the configured HTTPS origin and account-owned repository binding. It uploads a SHA-256-addressed subject, starts or reuses a review keyed by run, attempt and head, and advances bounded inspection passes. A review without a result at the caller deadline is cancelled. Model credentials and inference execution belong to the API, not this owner.

Delivery renders the retained advisory verdict, findings, evidence gaps and provenance as a GitHub review with event `COMMENT` bound to the reviewed commit. A final PR read suppresses closed or stale-head delivery; a bot-authored review with the same commit and stable review marker suppresses duplicate delivery. Review text escapes supplied Markdown/HTML and mentions and refuses bodies over 60,000 bytes. It neither grants approval nor blocks merging. The retained result artifact is distinct from a successful delivery receipt.

Before result persistence or GitHub delivery, the repository, PR number, head commit and SHA-256 subject identity must exactly match the submitted packet. A mismatch refuses before any delivery API call. The original subject remains the authority for delivery even when another PR has a matching current head.

`runner.test.ts` qualifies collection, refusal, rendering and delivery with simulated GitHub responses. The `tools:test-review` task owns these tests. Local tests establish caller behavior, not hosted API activation, live-model calibration or production delivery. Hosted deployment owns those broader gates.
