# Publishing IA packages to npm

The public scope is `@inventarch`. Every public npm package moves together at the single version selected in [releases/current.json](../../releases/current.json). The private workspace root is never published. The VS Code extension follows the cohort version and ships as a GitHub release asset, not an npm package. Native systems, language syntax and protocol formats keep independent versions, joined by the compatibility manifest.

## The release flow

1. **Pull request.** A change to a public package adds a pending release note with `pnpm release:note`. `pnpm release:check` runs in CI and refuses a changed package without one. Tooling, workflow and documentation changes outside package directories need no note.
2. **Release pull request.** On every push to main, the [Release pull request](../../.github/workflows/release-pr.yml) workflow runs `pnpm release:version`. It folds the pending notes into the next version and opens or updates a pull request from `release/next`. Review that changeset and changelog like any other change.
3. **Publication.** Merging the release pull request changes `releases/current.json`, which starts [Publish npm packages](../../.github/workflows/npm-publish.yml) for that merge commit. It waits for Public quality on that exact commit. Then it prepares and preflights the archives and pauses for approval on the `npm` environment. After approval it publishes with OIDC, verifies the registry cohort, tags `v<version>` and creates the GitHub release with the VSIX.

| Command | When | What it does |
| --- | --- | --- |
| `pnpm release:note` | In a pull request that changes a public package | Drafts `releases/pending/<id>.json` from the branch diff |
| `pnpm release:check` | CI on every pull request and push | Checks cohort versions, published changeset integrity and a note for every changed package |
| `pnpm release:version` | Dry run at any time; `--write` by the release workflow or a maintainer | Computes the next version and, with `--write`, applies it |
| `pnpm release:check --strict` | Before preparing archives | Requires exact changed-file coverage and no pending notes |
| `pnpm release:collect` | After editing release prose by hand | Re-derives coverage and regenerates `CHANGELOG.md` |
| `pnpm npm:inputs` | Whenever tracked files are added, removed or changed | Reseals `.ia/public-package-inputs.json` |
| `pnpm npm:prepare`, `npm:consumer`, `npm:plan`, `npm:preflight` | Release preparation, in the workflow or locally | Builds, qualifies, inspects and registry-checks the exact archives |
| `pnpm npm:trust-commands` | One-time account setup | Prints the trusted-publisher commands without running them |

## Release notes

A note is one JSON file under `releases/pending/`. The file name is the change id:

```json
{
  "format": "ia.npm-change-note.v1",
  "bump": "minor",
  "title": "Add selected-context workflows to the CLI",
  "summary": "What changes for package consumers, and any limits that still apply.",
  "packages": ["@inventarch/cli"],
  "paths": ["apps/cli/"]
}
```

`pnpm release:note` fills `packages` and `paths` from the files the branch changes. It infers `bump` only when every branch commit has a conventional type (`fix:` is a patch, `feat:` is minor, and `!` or `BREAKING CHANGE:` is major). Otherwise pass `--bump patch|minor|major`. Use `--bump none` for a package change with no consumer impact, such as tests or an internal refactor. Such a note satisfies the check and is folded into the next release, but never starts one. Pass `--title` and `--summary` to replace the commit-derived defaults. Review the file, commit it, then run `pnpm npm:inputs`. Record user-facing behavior and limits, not filenames or test counts. Automated checks establish completeness and freshness only; a reviewer judges whether the prose is accurate.

## How the version is chosen

A version is published when its immutable `v<version>` tag exists. The tag is created only after registry verification. `pnpm release:version --write` behaves differently in each state.

- **Published.** It makes the tagged commit the new baseline. It applies the largest pending bump to the published version and consumes the notes into `releases/changesets/<version>.json`. With only `none` notes pending, it waits.
- **Prepared but untagged.** The release workflow waits (`--published-only`), because that release may already be publishing from its own commit. A maintainer who abandons or extends an unpublished release can run `pnpm release:version --write` locally. That amends it with the pending notes, renaming it if they raise the bump. Pass `--refresh` to re-collect an unpublished release whose coverage went stale without new notes.

Each write updates every cohort `package.json`, the VS Code extension manifest and its dependency notices, each system's `npmVersion` in `system-package-policy.json`, and `releases/current.json`. It then writes the changeset with exact file coverage, regenerates `CHANGELOG.md`, deletes the consumed notes and reseals the public inputs. Packages that no note names receive a generated version-only entry. Changed files outside every package are accounted for by an internal maintenance entry, which the changelog omits. A changed package that no note names refuses before anything is written. The write requires a clean checkout and stages every file it changes. If a later step fails, it restores the files it touched. The release workflow uses only Node built-ins and Git, so it installs no dependencies while it holds a write token.

Historical changesets are immutable. A published changeset that differs from its tagged bytes fails `pnpm release:check`.

## Qualify exact archives

Development and ordinary platform checks use Node `>=22.22.0 <23`. Release preparation uses Node **22.22.2**, npm **12.2.0** and the pinned pnpm in `package.json`. `workspace:*` dependencies become exact package versions during isolated packing. To reproduce the workflow's preparation locally, use the version in `releases/current.json`:

```sh
pnpm install --frozen-lockfile
pnpm release:check --strict
pnpm npm:prepare
pnpm npm:consumer
pnpm npm:plan --version <version>
pnpm npm:preflight --version <version>
```

`artifacts/npm` must be absent or empty before preparation. The installed consumers import JavaScript exports and separately verify native data archives, bindings and complete dependency closure. npm 12 uses its default install security settings. On Windows, invoke `npm:consumer --npm-cli /path/to/npm/bin/npm-cli.js`.

The version 2 release receipt retains exact source, changeset and compatibility digests, archive integrity, the complete packed dependency graph and explicit cycle groups. Packing adds native dependencies, so source manifests alone cannot define publication order. All 11 system packages currently form one reviewed cycle; other groups are ordered before their consumers. Every internal dependency must be present at the exact cohort version, and version alignment does not eliminate cycles. A new packed cycle refuses until `cycles` in `releases/current.json` records it.

`npm:plan` validates local artifacts. `npm:preflight` reads live registry metadata without publishing. It refuses missing names, immutable byte conflicts, newer versions or inconsistent retry tags. Package existence does not prove permission to publish.

## One-time account and repository setup

**npm.** Use an npm account with write access and 2FA. No npm token belongs in repository secrets. Configure each package's trusted publisher for GitHub repository **inventarch/ia**, workflow **npm-publish.yml** and environment **npm**, with direct publishing allowed. `pnpm npm:trust-commands` prints the account-side commands for the complete inventory.

New package names must exist before a trusted publisher can be configured, and `npm:preflight` refuses any that do not. [npm staged publishing](https://docs.npmjs.com/staged-publishing/) can stage an exact qualified tarball, which creates a public `0.0.0-stage` placeholder for a new name. Review the staged payload and configure trust before approving the stage, or reject it in favor of OIDC publication. These are separately authorized account writes. Never publish dummy contents as a real version, overwrite a published version, repurpose an existing tag, or treat a registry 404 as proof of name ownership.

**GitHub.**

- Restrict the `npm` environment to the main branch and add required reviewers. That approval is the publication checkpoint, and the prepare job's summary shows the changeset digest and archive integrity being approved.
- Enable **Allow GitHub Actions to create and approve pull requests** so the release workflow can open `release/next`.
- The tag ruleset must keep allowing tag creation, because the release job creates `v<version>`.

Pull requests and pushes made with the workflow token start no other workflows. The release workflow therefore dispatches Public quality on `release/next`, and the publish workflow dispatches the release workflow after tagging.

## Publication and recovery

The publish job receives OIDC only after approval. It performs no workspace install or build, and it publishes the same-run archives with public access, provenance and ignored scripts. A dispatcher may pass `reviewed_changeset_sha256`; when given, publication refuses any other changeset. A manual dispatch with `publish=false` is a dry run of main's head.

The publisher preflights the entire cohort before any write. It retries an existing version only when the archive bytes and `latest` tag match. npm has no atomic transaction across packages, so an interruption can leave a partial cycle or cohort. To retry, re-run the failed jobs of the same workflow run. The run keeps its commit even after main moves on, and identical rebuilt bytes are skipped. An unexpected tag is a blocker, not permission to rewrite it.

If Public quality fails on the release commit, re-run it and then re-run the publish workflow, or land a fix. For a fix that changes a package, add a note and run `pnpm release:version --write` to amend the unpublished release. For a fix outside packages, run `pnpm release:version --write --refresh` to re-collect it. If the amended version differs, merging starts publication automatically. If the version stays the same, `releases/current.json` keeps its bytes, so dispatch the workflow with `publish=true` after merging.

A separate read-only job downloads and checks every published archive, exact version, `latest` tag and provenance. It installs the registry cohort with scripts disabled and runs `npm audit signatures` to verify signatures and attestations. Publication is complete only when this verification passes; only then is the version tagged. A failed final verification requires investigation. It does not authorize unpublishing or republishing immutable versions.

See [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [immutable npm versions](https://docs.npmjs.com/cli/v12/commands/npm-publish/) and [dist-tags](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag/). No preparation, dry run, local check or package-presence response establishes actual OIDC authorization or production framework readiness.
