# Publishing IA packages to npm

The public scope is `@inventarch`. All 21 public npm packages use the exact version in `releases/current.json`: currently **1.1.0**. The private workspace root and VS Code extension are excluded from npm publication. Native systems, language syntax and protocol formats retain independent versions joined by the compatibility manifest.

## Record and review a release

Every version bump requires a consumed changeset in `releases/changesets/<version>.json`. Consumed means assigned to that release, not published. Set the published baseline to its actual source commit/version, advance the cohort version, and update every public manifest and system npm-version policy together. Preserve historical changesets. Each package needs described changes or a justified cohort-only entry. Record user-facing behavior and limits, not merely filenames or a test count.

Review the actual commits and diff against the baseline. Scope each change entry to its affected files and packages. Stage intended additions/deletions, then run:

```sh
pnpm release:collect
pnpm release:check
pnpm npm:inputs
```

Collection refreshes exact file/deletion coverage and generates `CHANGELOG.md`; it preserves authored release prose. Missing scopes, package omissions, unknown identities, unconsumed entries, stale bytes and unchanged versions refuse. Review the collected coverage and generated changelog before committing them with the input descriptor. Commit history is retained in the final release receipt. Automated checks establish completeness and freshness; a maintainer must assess whether the prose is accurate.

The published input descriptor retains original extraction provenance. Refreshing it is explicit and does not import private sources. A release needs a clean exact source commit and freshly qualified archives. Old archive receipts cannot be relabeled after a source or version change.

## Qualify exact archives

Development and ordinary platform checks use Node `>=22.22.0 <23`. Release preparation uses Node **22.22.2**, npm **12.2.0**, and pinned pnpm **12.9.0**. `workspace:*` dependencies become exact package versions during isolated packing.

```sh
pnpm install --frozen-lockfile
pnpm release:check
pnpm npm:prepare
pnpm npm:consumer
pnpm npm:plan --version 1.1.0
pnpm npm:preflight --version 1.1.0
```

`artifacts/npm` must be absent or empty before preparation. The installed consumers import JavaScript exports and separately verify native data archives, bindings and complete dependency closure. npm 12 uses its default install security settings. On Windows, invoke `npm:consumer --npm-cli /path/to/npm/bin/npm-cli.js`.

The version 2 release receipt retains exact source, changeset and compatibility digests, archive integrity, the complete packed dependency graph and explicit cycle groups. Packing adds native dependencies, so source manifests alone cannot define publication order. All 11 system packages currently form one reviewed cycle; other groups are ordered before their consumers. Every internal dependency must be present at the exact cohort version. Version alignment does not eliminate cycles.

`npm:plan` validates local artifacts. `npm:preflight` reads live registry metadata without publishing and refuses missing names, immutable byte conflicts, newer versions or inconsistent retry tags. Package existence does not prove permission to publish.

## Account setup

Use an npm account with write access and 2FA. No npm token belongs in repository secrets. Configure each package's trusted publisher for GitHub repository **inventarch/ia**, workflow **npm-publish.yml**, environment **npm**, with direct publishing allowed. The GitHub environment should be restricted to main with maintainer approval. `pnpm npm:trust-commands` prints the account-side commands; it does not execute them.

New package names must exist before the publisher can proceed. [npm staged publishing](https://docs.npmjs.com/staged-publishing/) can stage an exact qualified tarball and creates a public `0.0.0-stage` placeholder for a new name. Review the staged payload and configure trust before approving it or rejecting the bootstrap stage in favor of OIDC publication. These are separately authorized account writes. Never use dummy contents as 1.0.0, overwrite a published version, repurpose an existing tag, or treat registry 404 as proof of name ownership. Preserve the existing 1.0.0 release.

The six new names are `compliance-system`, `governance-system`, `hook-authoring-system`, `learning-system`, `work-system` and `workspace-system`, all in the `@inventarch` scope. The complete 21-package inventory is derived by `npm:trust-commands`; it also includes `language`, `graph`, `compliance`, `db`, `runtime`, `service-contracts`, `session-system`, `agent-system`, `authoring-system`, `template-system`, `agent-composition-system`, `distribution`, `cli`, `mcp-door` and `steward-hook`.

## Prepare and publish through the workflow

The workflow runs only by manual dispatch from canonical main. A successful Public quality run must cover that exact main commit; a passing PR run does not substitute. First dispatch with `publish=false`. Preparation audits dependencies, validates the release ledger, builds and qualifies exact archives, exercises npm 12 consumers and retains the same-run artifacts for 14 days.

For a separately approved publication, the maintainer reviews the full changeset/diff and provides its SHA256 in `reviewed_changeset_sha256` with `publish=true`. A digest mismatch refuses publication. Only the protected publication job receives OIDC; it performs no workspace install or build. It publishes the same-run exact artifacts with public access, provenance and ignored scripts.

The publisher preflights the entire cohort before writes and retries an existing version only when its archive bytes and latest tag match. npm has no atomic transaction across packages: an interruption can leave a partial cycle or cohort. Retain the exact original artifacts, source and changeset for a retry; a newly built archive must not silently replace those bytes. An unexpected tag is a blocker, not permission to rewrite it.

A separate read-only job downloads and checks every published archive, exact version, latest tag and provenance. It installs the registry cohort with scripts disabled and runs `npm audit signatures` to verify signatures and attestations. Publication is complete only when this final verification passes. A failed final verification requires investigation; it does not authorize unpublishing or republishing immutable versions.

See [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [immutable npm versions](https://docs.npmjs.com/cli/v12/commands/npm-publish/) and [dist-tags](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag/). No preparation, dry run, local check or package-presence response establishes actual OIDC authorization or production framework readiness.
