# Publishing IA packages to npm

The public scope is `@inventarch`. Every public npm package moves together at the single version selected in [releases/current.json](../../releases/current.json). The private workspace root is never published. The VS Code extension follows the cohort version and ships as a GitHub release asset, not an npm package. Native systems, language syntax and protocol formats keep independent versions, joined by the compatibility manifest.

## The release flow

1. **Pull request.** A change to a public package adds a pending release note with `pnpm release:note`. `pnpm release:check` runs in CI and refuses a changed package without one. Tooling, workflow and documentation changes outside package directories need no note.
2. **Release pull request.** On every push to main, the [Release pull request](../../.github/workflows/release-pr.yml) workflow runs `pnpm release:version`. It folds the pending notes into the next version and opens or updates a pull request from `release/next`. Review that changeset and changelog like any other change.
3. **Publication.** Merging the release pull request changes `releases/current.json` and the changeset, which starts [Publish npm packages](../../.github/workflows/npm-publish.yml) for that merge commit. It waits for Public quality on that exact commit. Then it prepares and preflights the archives and pauses for approval on the `npm` environment. After approval it publishes with OIDC, verifies the registry cohort, tags `v<version>` and creates the GitHub release with the VSIX.

| Command | When | What it does |
| --- | --- | --- |
| `pnpm release:note` | In a pull request that changes a public package | Drafts `releases/pending/<id>.json` from the branch diff |
| `pnpm release:check` | CI on every pull request and push | Checks cohort versions, published changeset integrity and a note for every changed package |
| `pnpm release:version` | Dry run at any time; `--write` by the release workflow or a maintainer | Computes the next version and, with `--write`, applies it |
| `pnpm release:check --strict` | Before preparing archives | Requires exact changed-file coverage and no pending notes |
| `pnpm release:collect` | After editing release prose by hand | Re-derives coverage and regenerates `CHANGELOG.md` |
| `pnpm npm:inputs` | Release preparation only; `release:version` runs it | Reseals `.ia/public-package-inputs.json` |
| `pnpm npm:prepare`, `npm:consumer`, `npm:plan`, `npm:preflight` | Release preparation, in the workflow or locally | Builds, qualifies, inspects and registry-checks the exact archives |
| `pnpm npm:setup` | Once, and after adding a package | Reports npm names, trusted publishers and GitHub settings; `--apply` fixes them |
| `pnpm npm:trust-commands` | Reference | Prints the trusted-publisher commands without running them |

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

`pnpm release:note` fills `packages` and `paths` from the files the branch changes. It infers `bump` only when every branch commit has a conventional type (`fix:` is a patch, `feat:` is minor, and `!` or `BREAKING CHANGE:` is major). Otherwise pass `--bump patch|minor|major`. Use `--bump none` for a package change with no consumer impact, such as tests or an internal refactor. Such a note satisfies the check and is folded into the next release, but never starts one. Pass `--title` and `--summary` to replace the commit-derived defaults. Review the file and commit it. Record user-facing behavior and limits, not filenames or test counts. Automated checks establish completeness and freshness only; a reviewer judges whether the prose is accurate.

## How the version is chosen

A version is published when its immutable `v<version>` tag exists. The tag is created only after registry verification. `pnpm release:version --write` behaves differently in each state.

- **Published.** It makes the tagged commit the new baseline. It applies the largest pending bump to the published version and consumes the notes into `releases/changesets/<version>.json`. With only `none` notes pending, it waits.
- **Prepared but untagged.** The release workflow waits (`--published-only`), because that release may already be publishing from its own commit. A maintainer who abandons or extends an unpublished release can run `pnpm release:version --write` locally. That amends it with the pending notes, renaming it if they raise the bump. Pass `--refresh` to re-collect an unpublished release whose coverage went stale without new notes.

Each write updates every cohort `package.json`, the VS Code extension manifest and its dependency notices, each system's `npmVersion` in `system-package-policy.json`, and `releases/current.json`. It then writes the changeset with exact file coverage, regenerates `CHANGELOG.md`, deletes the consumed notes and reseals the public inputs. Packages that no note names receive a generated version-only entry. Changed files outside every package are accounted for by an internal maintenance entry, which the changelog omits. A changed package that no note names refuses before anything is written. The write requires a clean checkout and stages every file it changes. If a later step fails, it restores the files it touched. The release workflow uses only Node built-ins and Git, so it installs no dependencies while it holds a write token.

Historical changesets are immutable. A published changeset that differs from its tagged bytes fails `pnpm release:check`.

## What a pull request has to seal

Nothing. `.ia/public-package-inputs.json` seals every tracked file for release preparation, and only release preparation requires it to be current: `pnpm release:check --strict`, `pnpm npm:prepare`, and publication refuse a stale seal. Ordinary qualification reads the selection the checkout would seal instead. That covers `pnpm release:check`, `pnpm public:qualify` and the release tests, and it still refuses a renamed, added or removed public package. Likewise, only release preparation requires exact changed-file coverage. A pull request adds a release note when it changes a package, and `pnpm release:version` reseals and re-collects on the release branch.

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

The version 2 release receipt retains exact source, changeset and compatibility digests, archive integrity, the complete packed dependency graph and explicit cycle groups. Packing adds native dependencies, so source manifests alone cannot define publication order. All 11 system packages currently form one reviewed cycle. Every new package name publishes first; the existing packages follow, each group before its consumers. The receipt's `packages` list is that order. Every internal dependency must be present at the exact cohort version, and version alignment does not eliminate cycles. A new packed cycle refuses until `cycles` in `releases/current.json` records it.

`npm:plan` validates local artifacts. `npm:preflight` reads live registry metadata without publishing. It refuses missing names, immutable byte conflicts, newer versions or inconsistent retry tags. Package existence does not prove permission to publish.

## One-time account and repository setup

`pnpm npm:setup` reports what publication still needs, and `pnpm npm:setup --apply` makes those account writes. It is safe to re-run; each run changes only what is missing. To read and change everything, run it as a maintainer:

- logged in with `npm login` on an account with 2FA and write access;
- logged in with `gh auth login` as a repository admin;
- with Node 22.22.2 or later available, which the pinned npm 12.2.0 needs. The shell's own Node can be older: the command runs npm with the newest compatible Node that fnm has installed (`fnm install 22.22.2`), or with `--node <path>`. It installs the pinned npm into a temporary cache and never uses an npm token.

Reading or changing a trusted publisher needs 2FA even for a list, and npm can ask for it only in a terminal. So the read-only run reports which names are missing but not trust. `--apply` asks for 2FA once, before it writes anything. In the browser, tick **skip two-factor authentication for the next 5 minutes**, and the remaining reads and writes run without prompts.

**npm.** Every package must trust GitHub repository **inventarch/ia**, workflow **npm-publish.yml** and environment **npm** for direct publishing. npm accepts a trusted publisher only for a name that already exists, and `npm:preflight` refuses a name that does not. For a missing name, `--apply` stages a placeholder `0.0.0-bootstrap.0` under the `bootstrap` tag. [Staged publishing](https://docs.npmjs.com/staged-publishing/) creates the name with its public `0.0.0-stage` placeholder. The command then configures trust and rejects every pending placeholder stage, including one an interrupted run left. npm asks for 2FA again for each rejection; the five-minute skip does not cover it. The new name keeps npm's public `0.0.0-stage` placeholder as its `latest` tag until the workflow publishes the cohort version. The registry's CDN can answer 404 for a few minutes after a name is created, so `npm:preflight` may refuse it during that time; re-run once it resolves. Never approve a staged payload as the release. Final verification requires an npm provenance attestation on every published package, which only the workflow's OIDC publication adds, and none of the 1.0.0 versions carries one. Packages that already exist get any missing trust configuration. npm allows one configuration per package, so the command reports one that names another repository, workflow or environment and leaves it for you to revoke (`npm trust revoke <package> --id <id>`). `pnpm npm:trust-commands` prints the same trust commands. Never publish dummy contents as a real version, overwrite a published version, repurpose an existing tag, or treat a registry 404 as proof of name ownership.

The six names new in 1.1.0 are `compliance-system`, `governance-system`, `hook-authoring-system`, `learning-system`, `work-system` and `workspace-system`, all in the `@inventarch` scope.

**GitHub.** `--apply` restricts the `npm` environment to main and makes the code owner, or `--reviewer <login>`, its required reviewer. Approving that environment is the publication checkpoint; the prepare job's summary shows the changeset digest and archive integrity being approved. It also allows Actions to create pull requests, so the release workflow can open `release/next`. It makes the default workflow token read-only, since every workflow declares its own permissions, and it creates any ruleset in `.github/rulesets/` that is missing. The tag ruleset must keep allowing tag creation, because the release job creates `v<version>`.

Pull requests and pushes made with the workflow token start no other workflows. The release workflow therefore dispatches Public quality on `release/next`, and the publish workflow dispatches the release workflow after tagging.

## Publication and recovery

The publish job receives OIDC only after approval. It performs no workspace install or build, and it publishes the same-run archives with public access, provenance and ignored scripts. A dispatcher may pass `reviewed_changeset_sha256`; when given, publication refuses any other changeset. A manual dispatch with `publish=false` is a dry run of main's head.

The publisher preflights the entire cohort before any write. It retries an existing version only when the archive bytes and `latest` tag match. npm has no atomic transaction across packages, so an interruption can leave a partial cycle or cohort. Publishing new names first means a failed first publish of a new name stops before any existing package moves its `latest` tag. It does not cover the existing packages: 1.1.0 is the first trusted publish for each of them too, so make sure `pnpm npm:setup --apply` has configured every package's trusted publisher before approving. After an interruption, the receipt's order shows which packages already moved. To retry, re-run the failed jobs of the same workflow run. The run keeps its commit even after main moves on, and identical rebuilt bytes are skipped. An unexpected tag is a blocker, not permission to rewrite it.

If Public quality fails on the release commit, re-run it and then re-run the publish workflow, or land a fix. For a fix that changes a package, add a note and run `pnpm release:version --write` to amend the unpublished release. For a fix outside packages, run `pnpm release:version --write --refresh` to re-collect it. Either rewrites the changeset, so merging starts publication automatically.

A separate read-only job downloads and checks every published archive, exact version, `latest` tag and provenance. It installs the registry cohort with scripts disabled and runs `npm audit signatures` to verify signatures and attestations. Publication is complete only when this verification passes; only then is the version tagged. A failed final verification requires investigation. It does not authorize unpublishing or republishing immutable versions.

The release job creates a tag or GitHub release only after an explicit HTTP 404 for that resource and a successful repository lookup. Authentication, rate-limit, network and other lookup failures stop the job. Existing lightweight and annotated tags must resolve to the exact verified release commit. Tag creation never replaces an existing tag; a race or conflict stops for investigation. Rerun the failed release job after resolving a transient lookup failure; no npm republish is needed.

See [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [immutable npm versions](https://docs.npmjs.com/cli/v12/commands/npm-publish/) and [dist-tags](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag/). No preparation, dry run, local check or package-presence response establishes actual OIDC authorization or production framework readiness.
