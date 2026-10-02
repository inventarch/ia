# InventArch CI caller

`runner.mjs` runs with Node 22 and no installed dependencies. The default-branch workflow invokes it after Public quality, with only repository read, Actions read, issue read, PR comment and OIDC permissions. It collects PR source as Git blobs, never executes it, and sends a bounded pinned disclosure to the configured InventArch service.

Before enabling, deploy the API review resource and create an account-owned GitHub binding through `POST /v1/review-bindings`. The service's enabled OpenAPI document describes that operation. Configure repository variables `IA_REVIEW_API` (HTTPS origin), `IA_REVIEW_BINDING` (returned UUID) and `IA_REVIEW_ENABLED=true`. The workflow must exist on the default branch. No inference key or long-lived service token belongs in CI.

`IA_REVIEW_ENABLED` only admits the Actions job. API separately requires `REVIEW_ENABLED=1`, its deployed storage/migrations, gateway credentials, entitlement and a valid binding. The caller exchanges GitHub OIDC at `/v1/reviews/exchange`, uploads its pinned artifact and calls `/v1/reviews` and `/advance`. API retains the result before the caller publishes its advisory comment and acknowledges delivery. Enabling the variable alone does not qualify that path.

At API baseline `c07c8ae24bf2e9b11a64145cf1f9f8efe351571d`, `src/review-model.ts` uses a Vercel AI SDK `ToolLoopAgent` with `AI_REVIEW_MODEL`, falling back to `AI_GATEWAY_MODEL`. It reads the admitted `reviewing-a-pr.ia` playbook owned by `api-authoring-system`; it does not yet select a named native reviewer profile or compiled review entry. Its `prior` input consists of passes from the current run, not earlier GitHub review rounds. Current GitHub review reads in this caller suppress duplicate delivery; they do not supply history to the model.

The REV-M4-T03 amendment proposes a versioned history input, method changes, a native review entry and replay qualification. Keep judgment with the review capability, the API as its executing host, and GitHub collection/delivery with the provider adapter. The amendment remains proposed: the current caller still sends version 1, and these documentation changes do not activate history collection, a new entry or hosted review.

The binding must match numeric repository and owner IDs, repository name, default-branch ref and `.github/workflows/inventarch-review.yml`. Manual dispatch takes a completed Public quality PR run ID. Stale or ambiguous run/PR associations refuse before disclosure.

The admissible upstream run is a completed `pull_request` run of one workflow path, `.github/workflows/platform-quality.yml` by default. A host whose quality workflow lives elsewhere sets `IA_REVIEW_UPSTREAM_WORKFLOW` to that `.github/workflows/<name>.yml` path on both caller steps and names the matching evidence artifact in its workflow. The task evidence layout stays `<task>/evidence.json`. A checked-in copy of this caller in another repository is that repository's own default-branch code; keep it current from this file.

Execution reports retain the tested commit separately from the reviewed head. If CI tested a synthetic merge, the collector verifies its exact current base/head parents through GitHub's [Git commit API](https://docs.github.com/en/rest/git/commits). Conflicting or stale execution commits refuse.

The caller uploads a SHA-256-addressed subject, starts/reuses a review, advances its bounded passes, and retrieves a retained result. It publishes COMMENT only, suppresses stale-head delivery and recognizes a stable marker on retries. The comment names its reviewed head, computed verdict and advisory authority. Missing source, incomplete execution evidence or unreadable required-check policy cannot be presented as clean approval.

Limits are explicit: 400 changed paths, 1.7 MB disclosed source, 0.8 MB task evidence and a 3 MiB serialized subject. Required omitted source leads to an incomplete review. Unsupported file types and credential-like paths are excluded. The full path inventory remains available for the reviewer to locate missing producers/consumers. The result artifact contains the retained report; it is not a claim that GitHub delivery succeeded.

Run the behavioral tests with `pnpm exec vitest run --config vitest.tools.config.mts tools/review/runner.test.ts`. They use simulated GitHub responses and publish nothing.
