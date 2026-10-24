# Publishing IA packages to npm

The public scope is `@inventarch`. Every public npm package moves together at the single version selected in [releases/current.json](../../releases/current.json). The private workspace root is never published. The VS Code extension follows the cohort version and ships as a GitHub release asset, not an npm package. Public native systems and the bundled language archive use content-based versions within the npm major, joined to the npm cohort by the compatibility manifest. Artifacts 3.x retain IA syntax 1.0 and the existing schema, format, engine and protocol numbers.

## The release flow

1. **Pull request.** A change to a public package adds a pending release note with `pnpm release:note`. `pnpm release:check` runs in CI and refuses a changed package without one. Tooling, workflow and documentation changes outside package directories need no note.
2. **Release pull request.** On every push to main, the [Release pull request](../../.github/workflows/release-pr.yml) workflow runs `pnpm release:version`. It folds the pending notes into the next version and opens or updates a pull request from `release/next`. Review that changeset and changelog like any other change. Native selectors move only for a new major. Within a major, `pnpm native:version --write` selects each changed archive's version from its native note, and native archive regeneration and qualification remain pending, because the workflow installs no workspace dependencies. Before merge, regenerate vocabulary/public/authoring assets, run `pnpm native:version --write`, repeat generation and native selection to a fixed point, regenerate projections, then commit and run `pnpm release:version --write --refresh` to re-collect coverage, including the generated alignment of any native version the selection moved, and reseal final inputs, commit the refreshed changes, then run `pnpm release:check --strict`, `pnpm platform:qualify` and `pnpm npm:prepare` on the prepared head. Commit each preparation step on `release/next` with the line `IA-Release-Preparation: v1` in its message, for example `git commit -m "Prepare release assets" -m "IA-Release-Preparation: v1"`. A run of the Release pull request workflow before the release pull request merges, from a push to main or started by hand, can rebuild `release/next` from main and replace those marked commits, so prepare after the last change intended for the release has landed, and prepare again whenever the workflow rebuilds the branch. Any other commit on `release/next` stops the workflow, preserved, until a maintainer reconciles it: move the work to a marked commit or to main, then reset the branch. When the native selection moves or native notes target the release, both full and compact PR descriptions retain these instructions. If the full description exceeds its conservative 60,000-byte budget, the PR links to those complete files on `release/next` instead of copying the notes inline; the changeset digest and merge/publication warning stay visible.
3. **Publication.** Merging the release pull request changes `releases/current.json` and the changeset, which starts [Publish npm packages](../../.github/workflows/npm-publish.yml) for that merge commit. It waits for Public quality on that exact commit. Then it prepares and preflights the archives and pauses for approval on the `npm` environment. After approval it publishes with OIDC, verifies the registry cohort, tags `v<version>` and creates the GitHub release with the VSIX.

| Command | When | What it does |
| --- | --- | --- |
| `pnpm release:note` | In a pull request that changes a public package | Drafts `releases/pending/<id>.json` from the branch diff |
| `pnpm release:check` | CI on every pull request and push | Checks package manifest form and published exports, cohort versions, published changeset integrity, a note for every changed package and, while a release is prepared, native version coverage, including recorded paths reverted to baseline |
| `pnpm release:version` | Dry run at any time; `--write` by the release workflow or a maintainer | Computes the next version and, with `--write`, applies it |
| `pnpm release:check --strict` | Before preparing archives | Requires exact changed-file coverage and no pending notes |
| `pnpm release:collect` | After editing release prose by hand | Re-derives coverage and regenerates `CHANGELOG.md` |
| `pnpm npm:inputs` | Release preparation only; `release:version` runs it | Reseals `.ia/public-package-inputs.json` |
| `pnpm npm:prepare`, `npm:consumer`, `npm:plan`, `npm:preflight` | Release preparation, in the workflow or locally | Builds, qualifies, inspects and registry-checks the exact archives |
| `pnpm npm:setup` | Once, after adding a package, and when registry state is unclear | Inspects public readiness, authenticated package state, stages, trust and GitHub settings; `--apply` makes only supported setup writes |
| `pnpm npm:trust-commands` | Reference | Prints pinned npm 12.2.0 commands with the explicit npm registry; requires valid package identities but no current release seal, and runs no trust mutation |

## Release notes

The native tasks in `.ia/src/records/npm-release.ia` track two distinct outcomes. `npm-release-hygiene-checks` requires `artifacts/npm/npm-release.json`, the exact archives it names, `system-compatibility.json`, platform qualification evidence and the npm-consumer result for those archives. `npm-release-publication-review` requires a retained review identifying those receipts and source revision, inspected registry setup and every unresolved publication prerequisite. Partial unit checks, local structural admission or an unavailable host catalog cannot close either task. Keep status open until the complete exit evidence exists; a success observation must match the task's current revision and does not mutate its authored status.

Audit and repair validation is retained separately with commands, source revision, outcomes and limitations. A repository-only check can establish the repository architecture boundary without establishing release readiness. Installed binding checks require an actual selected catalog, and kernel conformance evidence must match the evaluated floor revision; missing evidence remains unavailable or inconclusive.

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

  First it checks that npm has the published cohort. That cohort is every package the changeset at the tag lists, by npm name, including packages moved, renamed or removed since. A missing one refuses as an unfinished publication, naming the packages npm lacks. npm isn't asked about a package that changeset doesn't list; it publishes with the next version.

  Each package's `previous` version follows its npm name, wherever its directory is now:
  - A package the tag lists gets the published version.
  - A package that returns after a release dropped it gets the newest version an earlier changeset lists it at.
  - A package no changeset lists is new: its `previous` is `null`, and it publishes first, with the other new names.

  A tag whose commit has no changeset, or one that lists no packages, falls back to every current package and to the manifest at the same path, which must name the same package.
- **Prepared but untagged.** The release workflow waits (`--published-only`), because that release may already be publishing from its own commit. A maintainer who abandons or extends an unpublished release can run `pnpm release:version --write` locally. That amends it with the pending notes, renaming it if they raise the bump. Pass `--refresh` to re-collect an unpublished release whose coverage went stale without new notes.

Each write updates every cohort `package.json`, the VS Code extension manifest and its dependency notices, each system's `npmVersion` in `system-package-policy.json`, every native selector at a new major only, and `releases/current.json`. When no native archive changed since the baseline tag, it also moves `releases/native/current.json` and `releases/native/notes.json` onto that tag, so the release head passes `pnpm native:release:check` without a native regeneration. It then writes the changeset with exact file coverage, regenerates `CHANGELOG.md`, deletes the consumed notes and reseals the public inputs. Packages that no note names receive a generated version-only entry. Changed files outside every package are accounted for by an internal maintenance entry, which the changelog omits. A changed package that no note names refuses before anything is written. The write requires a clean checkout and stages every file it changes. If a later step fails, it restores the files it touched. The release workflow uses only Node built-ins and Git, so it installs no dependencies while it holds a write token.

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

The version 2 release receipt retains exact source, changeset and compatibility digests, archive integrity, the complete packed dependency graph and explicit cycle groups. Packing adds native dependencies, so source manifests alone cannot define publication order. The reviewed complete cycle groups are recorded in `cycles` in `releases/current.json`; qualification compares them with the actual packed dependency graph. Native dependency edges added during packing participate in that graph alongside emitted-code dependencies. Every new package name publishes first; the existing packages follow, each group before its consumers. The receipt's `packages` list is that order. Every internal dependency must be present at the exact cohort version, and version alignment does not eliminate cycles. A new packed cycle refuses until `cycles` in `releases/current.json` records it.

`npm:plan` validates local artifacts. `npm:preflight` reads live registry metadata without publishing. It refuses missing names, immutable byte conflicts, newer versions or inconsistent retry tags. Package existence does not prove permission to publish.

## Account and repository setup

Follow the maintained [setup guide](SETUP.md) for inspection, explicit setup changes, authentication recovery and owner-confirmed bootstrap. Reinspect before release; an old successful inspection does not establish current readiness.

## Publication and recovery

When setup or the publisher reports a name as not publicly ready, begin with `pnpm npm:setup` without `--apply`. For trust-read `EOTP`, an owner can use `pnpm npm:setup --interactive-auth --skip-github` in a terminal as described above. This selects the pinned npm 12.2.0 even when the shell's npm lacks the `trust` command. Any additional read-only access, stage or trust diagnostics must also use that pinned CLI and the existing authorized login. Retain the reported package/version/stage identity and sanitized status results. Stop if further diagnosis requires a new login, credential or permission change; do not change account settings as part of inspection.

The publish job receives OIDC only after approval. It performs no workspace install or build, and it publishes the same-run archives with public access, provenance and ignored scripts. A dispatcher may pass `reviewed_changeset_sha256`; when given, publication refuses any other changeset. A manual dispatch with `publish=false` is a dry run of main's head.

The publisher preflights the entire cohort before any write. It retries an existing version only when the archive bytes and `latest` tag match. npm has no atomic transaction across packages, so an interruption can leave a partial cycle or cohort. Publishing new names first means a failed first publish of a new name stops before any existing package moves its `latest` tag. Existing names also require the intended trusted-publisher configuration. Verify that configuration for every selected package before approving publication. After an interruption, the receipt's order shows which packages already moved. To retry, re-run the failed jobs of the same workflow run. The run keeps its commit even after main moves on, and identical rebuilt bytes are skipped. An unexpected tag is a blocker, not permission to rewrite it.

If Public quality fails on the release commit, re-run it and then re-run the publish workflow, or land a fix. For a fix that changes a package, add a note and run `pnpm release:version --write` to amend the unpublished release. For a fix outside packages, run `pnpm release:version --write --refresh` to re-collect it. Either rewrites the changeset, so merging starts publication automatically.

A separate read-only job downloads and checks every published archive, exact version, `latest` tag and provenance. npm accepts a publish before it serves the new version, so the job first waits until npm shows every package at the release version, for about 15 minutes from its first read. Every 20 seconds it reads again each package whose metadata answered 404 or lacked the version, or whose read timed out, failed on the network (including a body that fails to decompress) or returned HTTP 429 or a 5xx status. When its first read already shows every package, it checks that read; otherwise, once every package has shown, it reads the whole cohort once more and checks that read. It waits for nothing else: differing bytes, a newer stable version, an unexpected `latest` tag, missing provenance, an unexpected origin, another HTTP status or malformed JSON refuses at once. A package that still has not shown after about 15 minutes refuses the cohort as incomplete, with its last read failure if it had one. The job then downloads every archive, installs the registry cohort with scripts disabled and runs `npm audit signatures` to verify signatures and attestations. It then runs `pnpm conformance:qualify --registry <version>`. That installs the published language, graph, compliance and db packages and verifies COMP-KERNEL and COMP-FIXTURES in a worker that can read only `node_modules` (see [SPEC.md](SPEC.md)). These steps do not wait. Publication is complete only when this verification passes; only then is the version tagged. A failed final verification requires investigation. It does not authorize unpublishing or republishing immutable versions. If the cohort was refused only as incomplete, or right after the wait an archive download returned 404 (`<name>: archive download returned 404`) or `npm install` reported "No matching version found" or "404 Not Found", re-run the failed jobs of the same run once npm shows every version.

The release job creates a tag or GitHub release only after an explicit HTTP 404 for that resource and a successful repository lookup. Authentication, rate-limit, network and other lookup failures stop the job. Existing lightweight and annotated tags must resolve to the exact verified release commit. Tag creation never replaces an existing tag; a race or conflict stops for investigation. After resolving a transient release failure, choose **Re-run failed jobs** on the same workflow run while its qualified artifacts remain available (retained for 14 days); no npm republish is needed. **Re-run all jobs** or a new dispatch repeats selection, which treats an existing version tag as complete and can skip the missing GitHub release. Once the artifacts expire, stop for explicit recovery using the verified release commit and artifacts whose provenance and integrity have been re-established; do not substitute current-main artifacts or replace the existing tag.

See [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [immutable npm versions](https://docs.npmjs.com/cli/v12/commands/npm-publish/) and [dist-tags](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag/). No preparation, dry run, local check or package-presence response establishes actual OIDC authorization or production framework readiness.
