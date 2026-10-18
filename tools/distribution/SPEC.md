# distribution tooling contract

## Purpose

Generate public and authoring resources, assemble host payloads, qualify installed packages and currently host npm automation.

## Modules

- [generate-public.d.mts](generate-public.d.mts) — interface declaration; implementation checking is tracked separately.
- [generate-public.mjs](generate-public.mjs).
- [github-release.d.mts](github-release.d.mts) — interface declaration; implementation checking is tracked separately.
- [github-release.mjs](github-release.mjs).
- [github-release.test.ts](github-release.test.ts) — behavior and refusal coverage.
- [host-payload.d.mts](host-payload.d.mts) — interface declaration; implementation checking is tracked separately.
- [host-payload.mjs](host-payload.mjs).
- [host-payload.test.ts](host-payload.test.ts) — behavior and refusal coverage.
- [installed-consumer.d.mts](installed-consumer.d.mts) — interface declaration; implementation checking is tracked separately.
- [installed-consumer.mjs](installed-consumer.mjs).
- [installed-views.d.mts](installed-views.d.mts) — interface declaration; implementation checking is tracked separately.
- [installed-views.mjs](installed-views.mjs).
- [installed-views.test.ts](installed-views.test.ts) — behavior and refusal coverage.
- [language-guide.test.ts](language-guide.test.ts) — behavior and refusal coverage.
- [npm-consumer.mjs](npm-consumer.mjs).
- [npm-registry-consumer.mjs](npm-registry-consumer.mjs).
- [npm-release.d.mts](npm-release.d.mts) — interface declaration; implementation checking is tracked separately.
- [npm-release.mjs](npm-release.mjs).
- [npm-release.test.ts](npm-release.test.ts) — behavior and refusal coverage.
- [public-content-policy.json](public-content-policy.json) — explicit policy or execution data.
- [qualify-packages.mjs](qualify-packages.mjs).
- [qualify-public.mjs](qualify-public.mjs).
- [release-branch.mjs](release-branch.mjs).
- [release-branch.test.ts](release-branch.test.ts) — behavior and refusal coverage.
- [release-changes.d.mts](release-changes.d.mts) — interface declaration; implementation checking is tracked separately.
- [release-changes.mjs](release-changes.mjs).
- [release-fixtures.ts](release-fixtures.ts).
- [release-graph.d.mts](release-graph.d.mts) — interface declaration; implementation checking is tracked separately.
- [release-graph.mjs](release-graph.mjs).
- [release-hygiene.test.ts](release-hygiene.test.ts) — behavior and refusal coverage.
- [release-notes.d.mts](release-notes.d.mts) — interface declaration; implementation checking is tracked separately.
- [release-notes.mjs](release-notes.mjs).
- [release-packages.d.mts](release-packages.d.mts) — interface declaration; implementation checking is tracked separately.
- [release-packages.mjs](release-packages.mjs).
- [release-refusals.test.ts](release-refusals.test.ts) — behavior and refusal coverage.
- [release-setup-auth.d.mts](release-setup-auth.d.mts) — interface declaration; implementation checking is tracked separately.
- [release-setup-auth.mjs](release-setup-auth.mjs).
- [release-setup-auth.test.ts](release-setup-auth.test.ts) — behavior and refusal coverage.
- [release-setup-metadata.d.mts](release-setup-metadata.d.mts) — interface declaration; implementation checking is tracked separately.
- [release-setup-metadata.mjs](release-setup-metadata.mjs).
- [release-setup-metadata.test.ts](release-setup-metadata.test.ts) — behavior and refusal coverage.
- [release-setup.d.mts](release-setup.d.mts) — interface declaration; implementation checking is tracked separately.
- [release-setup.mjs](release-setup.mjs).
- [release-setup.test.ts](release-setup.test.ts) — behavior and refusal coverage.
- [release-version.d.mts](release-version.d.mts) — interface declaration; implementation checking is tracked separately.
- [release-version.mjs](release-version.mjs).
- [release-versioning.test.ts](release-versioning.test.ts) — behavior and refusal coverage.
- [resources.mjs](resources.mjs).
- [system-package-policy.json](system-package-policy.json) — explicit policy or execution data.

## Commands

- `pnpm host-payload:generate`: `node tools/distribution/host-payload.mjs --write`.
- `pnpm public:qualify`: `node tools/distribution/generate-public.mjs --check && node tools/distribution/qualify-public.mjs && pnpm packages:qualify`.
- `pnpm public:generate`: `node tools/distribution/generate-public.mjs --write`.
- `pnpm packages:qualify`: `node tools/distribution/qualify-packages.mjs`.
- `pnpm npm:prepare`: `node tools/distribution/release-changes.mjs check --strict && pnpm native:release:check && pnpm build && node tools/distribution/generate-public.mjs --check && node tools/distribution/qualify-public.mjs && pnpm packages:qualify --pack-destination artifacts/npm`.
- `pnpm npm:plan`: `node tools/distribution/npm-release.mjs plan`.
- `pnpm npm:consumer`: `node tools/distribution/npm-consumer.mjs`.
- `pnpm npm:trust-commands`: `node tools/distribution/npm-release.mjs trust-commands`.
- `pnpm npm:setup`: `node tools/distribution/release-setup.mjs`.
- `pnpm release:check`: `node tools/distribution/release-changes.mjs check`.
- `pnpm release:note`: `node tools/distribution/release-notes.mjs add`.
- `pnpm release:version`: `node tools/distribution/release-version.mjs`.
- `pnpm release:collect`: `node tools/distribution/release-changes.mjs collect`.
- `pnpm npm:preflight`: `node tools/distribution/npm-release.mjs preflight`.
- `pnpm npm:verify-registry`: `node tools/distribution/npm-release.mjs verify-registry`.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Public package manifests/exports, authored resource guides, policy JSON, built host closures, release receipts and selected archives.

## Outputs

Explicit generators write public resources and CLI host assets. Qualifiers write only owned installations/evidence. Release/setup mutations require their explicit modes and authorization.

## Prerequisites

Host payload needs built closure packages. Ordinary qualification and sealed release preparation have different trust predicates. Workflow-loaded release entries keep a built-in/relative-module closure.

## Validation

Task ownership: `tools:test-distribution`, `tools:test-installed-views`, `host-payload:generate`, `public:qualify`, `tools:test-npm-release`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Current package namespace assertions test actual forbidden payload entries. Only trust-command emission bypasses fresh seals. Release branches refuse foreign commits and lease the inspected head; setup uses validated private npm installation.

## Limits

Npm automation moves to an intermediate owner after recipe parity work. Live registry/settings/publication results cannot be inferred from local mocks.

## Detailed behavior

Exercises built authoring/resource APIs, public guide resolution and host projection success/refusal against the public native tree.

`resources.mjs` maintains one selection-advice entry per public word. It generates both native authoring-guide records and installed reference documents from that advice, alongside canonical schema fields. Each entry explains when to select the word, its nearest alternatives and what to establish before authoring. An unreviewed word fails generation rather than receiving generic fallback advice. Run `pnpm vocabulary:generate`, `pnpm public:generate` and the authoring/projection generators after changing the schema or guidance; resource pins are derived from the final bytes.

`pnpm packages:qualify` packs every public npm package and installs the archives into a temporary consumer outside the repository. Dependency installation prefers the local package cache and may retrieve missing registry metadata. It verifies release versions, runtime policy, dependency pins, license notices and every exported target, then imports all exports with the development condition enabled. A second consumer installs only the CLI and its declared dependencies. With network fetches refused and home/configuration paths isolated, that installed CLI initializes and validates a workspace and registers both supported hosts, then meets the installed-view expectations of `installed-views.mjs`. Its `qualifyInit` holds what `ia init --apply --json` printed and left to the CLI contract's `init` row: exactly three authored records (a `@workspace`, its participant `@agent` and that `@mandate`) in `.ia/src/workspace.ia`, no distribution, `.ia/.gitignore` holding `work/` and `distributions/`, the capture effect matching `.ia/work/snapshot/current.json`, and project skipped without `--host`. The scenarios are the three-record position, packet and format (K0 names the participant's one mandate, each host's receipt renders that one participant and no agent file, and `ia format --check` takes the starter file), the pack refusal without a distribution, naming `ia vocabulary distribution`, capture idempotence, read bodies and digests, next order and self-declared status, live edits, no writes, refusals and the removed `ia compile` refusal and workspace preservation. `installed-views.test.ts` runs the same expectations against the repository's built CLI in the tools suite, so a gate that runs without packing holds them too. It is its own task, `tools:test-installed-views`, whose `installed-cli` input profile hashes every app, package and distribution source and the native generators, because the test reaches the CLI only through the built `apps/cli/dist/main.js` path, which no import edge names, so a cached pass cannot outlive a CLI change. The same check packages the editor VSIX. Run the root build first; `pnpm public:qualify` includes this artifact check.

This establishes local installed-artifact behavior on the executing platform. It does not publish artifacts, establish registry ownership, or qualify a live editor or fresh agent session.

## npm publishing

`release-branch.mjs update --version <version>` consumes the already staged release-version outputs. It starts at `origin/main`, inspects the remote `release/next` head, and accepts either a merged branch or one bot-authored automation commit with the versioned ownership marker and its exact main parent. Unknown commits, including maintainer amendments or legacy unmarked automation commits, stop the update for reconciliation. Both update and delete use the inspected head in an explicit push lease; a concurrent remote change refuses. The local bare-remote tests qualify preservation and normal updates without GitHub writes.

Setup's automatically installed npm CLI lives in a fresh owned temporary directory. Package identity, version, physical paths and POSIX ownership/write permissions are checked before invoking its version command; failed setup and successful completion remove only that installation. An explicit `--npm-cli` remains operator-selected and is validated but never removed. Shared predictable executable caches are not reused. GitHub's workflow permission permits both creation and approval of PRs; setup discloses both capabilities, while the release workflow itself creates and updates PRs without approving them.

The public npm scope is `@inventarch`. [NPM-PUBLISHING.md](NPM-PUBLISHING.md) owns account setup and release operation. Public package manifests declare the canonical Git repository, package directory, public access and npm registry. Packed dependencies must resolve to registry packages; consumers must not require installation lifecycle scripts.

`pnpm release:check`, strict or not, first refuses a package manifest the release tools cannot rely on. Every `package.json` directly under `packages/`, `apps/` or `.ia/src/systems/`, private ones included, must be exactly `JSON.stringify(manifest, null, 2)` and one final newline: `pnpm release:version` rewrites each cohort version on its two-space top-level line, and Biome does not format JSON. Packing replaces a public package's `exports` with `publishConfig.exports`, so both must declare the same subpaths, and each published entry must equal its `exports` entry without the `development` condition, conditions in the same order. `manifestProblems` in [release-packages.mjs](release-packages.mjs) lists every violation.

`pnpm npm:prepare` builds and qualifies packages, then retains the exact checked archives and the qualified VSIX in an initially empty `artifacts/npm` directory. `npm-release.json` records their dependency order, version, SHA-512 integrity, source commit and dirty-checkout state. `pnpm npm:consumer` exercises the retained archives with npm 12's install-time security defaults. `pnpm npm:plan` verifies the manifest and every archive without publishing. `pnpm npm:trust-commands` prints the trust commands without running them.

`pnpm npm:setup` inspects public package metadata through the publisher's registry reader, authenticated exact-package metadata, access status, stages and trusted publishers, plus the required GitHub settings. Visibility is distinct from existence: npm's `private` access label is reported as `non-public` and proves neither existence nor absence. Only validated exact-name metadata, exact-package stage records or a well-formed trust record from the exact-package request establish existence. Empty or malformed trust identities cannot supply that evidence. Metadata 404 and empty stages leave existence unconfirmed unless another positive source establishes it; a metadata 404 conflicting with positive evidence remains blocked. Public release readiness additionally requires public visibility, public metadata and intended trust. A failed read or malformed response cannot produce a ready result. Read-only and apply runs exit nonzero when npm readiness remains incomplete. `--apply` uses inspected state to create only missing trust, never replacing a different configuration or changing package visibility, and reinspects before reporting readiness. Matching trust and an existing pending bootstrap stage with exact package/version identity are reused. Multiple bootstrap candidates or uncertain stage identity/status block setup. A reusable bootstrap must report npm status `staged`; a `validating` stage is retained and requires a later inspection.

The metadata helper loads existing configuration from pinned npm 12.2.0 without invoking login, commands, interactive authentication or configuration writes. It performs a bounded fresh GET of the raw packument at the canonical npm registry, independent of configured scoped registries and npm view's version/tag selection. A successful response must identify the exact requested package and contain a versions object, including an empty one. Only validated identity or an allowlisted error code crosses the helper boundary; credentials, configuration, metadata bodies and raw errors are never reported. Missing, malformed or unsuccessful helper output remains unknown and blocked. Mocked transport tests do not establish live authenticated access.

Trust inspection normally captures structured output, which prevents npm's terminal-only 2FA prompt. `EOTP` remains unknown and blocked unless the owner explicitly opts into `--interactive-auth` with both standard input and standard output attached to terminals. The recovery command is `pnpm npm:setup --interactive-auth --skip-github`, without pipes or redirection. The helper uses the same resolved Node and pinned npm 12.2.0 as setup, never a potentially older PATH npm. It performs only the challenged trust-list read, gives npm the terminal for native authentication, and returns the completed read on a separate result channel for existing strict trust validation. Prompt output cannot satisfy inspection. Classic OTP input is masked and remains in the helper for that request; setup never records it or passes it through command arguments or the result channel, logs in or persists credentials. Challenges are request-scoped and may recur for each package or fresh inspection. Failed, cancelled or timed-out authentication stops later interactive attempts in that run; the helper deadline is five minutes. Noninteractive execution provides an actionable refusal and cannot turn unread state into permission to write. Interactive retry of mutations is outside this option. Mocked checks do not establish live authentication success or cross-platform terminal transport, and authentication success does not establish public package readiness.

A new bootstrap additionally requires explicit owner confirmation through repeatable `--bootstrap-name <full-package-name>` options; even authenticated 404 does not prove absence. Creation is allowed only when public metadata, authenticated metadata and authenticated access all return 404, stage listing succeeds empty, and trust is absent or returns 404. This correction does not broaden that gate: non-public visibility with unconfirmed existence refuses creation even with the option. Positive existence evidence, failed authentication or permissions, or unknown state also refuses creation. The `0.0.0-bootstrap.0` payload is never approved. Setup retains and reports its exact package, version and stage ID, including after a partial failure, without approving, rejecting or automatically cleaning up any stage. Cleanup requires separate owner authorization after the normal workflow verifies a real release, with the exact stage identity and current status checked again. Retention improves the bootstrap lifecycle; it does not establish the cause of or repair npm registry inconsistency. [NPM-PUBLISHING.md](NPM-PUBLISHING.md) describes inspection and owner recovery. The publisher's public missing-name check remains mandatory before any publication.

`pnpm release:note`, `pnpm release:version` and `pnpm release:check` own pending release notes, version selection and the pull-request release check; [NPM-PUBLISHING.md](NPM-PUBLISHING.md) describes their states. `.github/workflows/release-pr.yml` versions pending notes into the `release/next` pull request without installing dependencies or receiving OIDC. The complete PR body, including metadata and consumed-note IDs, is limited to 60,000 UTF-8 bytes, conservatively below GitHub's 65,536-character limit. Bodies within that budget retain the full inline notes; larger bodies replace the prose and ID list with links to the complete `CHANGELOG.md` and changeset on `release/next` and a note count. The changeset digest, review instructions, pending native regeneration and publication warning remain. The versioner uses the shared Node-builtins-only native selector to align system declarations, public copies and native policies, including explicit same-version refreshes; it leaves archive generation pending. Its generated alignment coverage requires exact file equality and a fresh version-only proof, and late failures restore every touched native selector along with npm release files. Rendering never truncates or modifies the release files.

`.github/workflows/npm-publish.yml` starts when a main push changes `releases/current.json` or a consumed changeset, or by manual dispatch from main. It proceeds only for an untagged version, after Public quality passes for that exact main commit, and it preflights the registry before approval is requested. The build job has no OIDC permission. Only the separate npm environment job can publish; it receives same-run artifacts, checks their source and integrity, and uses the npm CLI with provenance. Release builds restore no task or dependency cache. Publication requires a clean source commit and OIDC, refuses stored npm tokens, preflights all package versions, and skips an existing version only when the registry integrity matches. Cross-package publication is sequential and not atomic. Only after registry verification does a separate job tag `v<version>` and create the GitHub release with the qualified VSIX. A dry run establishes preparation, never npm account ownership or successful publication.

`github-release.mjs` checks repository access and uses HTTP status codes to distinguish absent tags and releases (404) from authentication, rate-limit, server and transport failures. Successful responses must identify the requested resource. Existing lightweight or annotated tags must resolve to the exact published commit; malformed, broken or conflicting tags refuse. All lookups finish before creation. Tag creation is create-only: a concurrent creation or failed write stops the job without replacing a tag or dispatching the next release workflow. An existing release is retained; a missing release is created with `--verify-tag` and the qualified assets. Input assembly requires exactly one qualified VSIX, includes both release and compatibility manifests, and writes the selected changeset's release notes without modification. The release job pins Node 22.22.2, applies a 30-second deadline to each API request, and dispatches its successor only after the helper succeeds under strict bash.
