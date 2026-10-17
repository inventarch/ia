# Releases

[![Release](https://img.shields.io/npm/v/@inventarch/cli?label=release)](https://github.com/inventarch/ia/releases/latest) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../LICENSE)

> This folder holds the reviewed inputs to IA releases: the version every public npm package shares, one changeset for each released version, release notes waiting for the next version, and the native archive ledger. Release tooling writes nearly all of it. A contributor usually adds only a release note.

## What is here

| Path | Holds | Written by |
| --- | --- | --- |
| `current.json` | The coordinated npm version, its dist-tag, the published baseline (commit and version) it advances, and the reviewed groups of packages that form dependency cycles once packed | `pnpm release:version --write` |
| `changesets/<version>.json` | The consumed changeset for one version: release prose, each package's impact and the SHA-256 of every file changed since the baseline | `pnpm release:version --write`; immutable once published |
| `pending/<id>.json` | Release notes not yet part of a version; the folder exists only while notes are pending | `pnpm release:note`, committed with your pull request |
| `native/current.json` | The native archive ledger: the published baseline tag and commit, the digest of the native notes, and each native archive's version, archive and manifest digests and dependencies | `pnpm native:version --write` |
| `native/notes.json` | Native release notes: a bump and a summary for each changed native archive, against the latest published release tag | Edited by hand and reviewed with the release |
| `native/baselines/` | The native digests published with npm 2.0.0, the first baseline the native check pins | Never changed |

Consumed means allocated to a release. Publication to the registry is separate, and the immutable `v<version>` tag records it.

## The release flow

1. **Pull request.** A change to a public package adds a release note. Changes outside package directories, such as tooling, workflows and repository docs, need none.
2. **Release pull request.** On every push to main, the [Release pull request](../.github/workflows/release-pr.yml) workflow runs `pnpm release:version`. It folds the pending notes into the next version and opens or updates a pull request from `release/next`. Review its changeset and changelog like any other change.
3. **Publication.** Merging that pull request changes `current.json` and the changeset, which starts [Publish npm packages](../.github/workflows/npm-publish.yml). It waits for Public quality on that commit and for approval on the `npm` environment, then publishes with OIDC, verifies the registry cohort, tags `v<version>` and creates the GitHub release.

## Rules for an ordinary pull request

- Do not edit package versions, `current.json`, `changesets/` or `CHANGELOG.md` by hand. `pnpm release:version --write` writes them on the release branch.
- Do not edit `native/current.json` by hand. `pnpm native:version --write` writes it.
- Add a note when you change a public package. `pnpm release:note` drafts `pending/<id>.json` from your branch diff and fills in its packages and paths. It infers the bump only when every branch commit has a conventional type. Otherwise pass `--bump patch|minor|major`, or `--bump none` for a change consumers cannot observe, such as tests; a `none` note satisfies the check but never starts a release. Pass `--title` and `--summary` to replace the text taken from your commits, and write the summary for package consumers.
- Put IA words in backticks. Release notes are published where a bare `@word` mentions a GitHub account, so `pnpm release:note` and `pnpm release:check` refuse one in a title or summary.

## Checks

| Command | When | What it does |
| --- | --- | --- |
| `pnpm release:check` | CI, on every pull request and push | Refuses a changed public package without a note, an invalid note, mismatched cohort versions and a published changeset that differs from its tagged bytes |
| `pnpm release:check --strict` | Before preparing archives | Also refuses pending notes and incomplete or stale changed-file coverage |
| `pnpm release:version` | Any time as a dry run; `--write` by the release workflow or a maintainer | Computes the next version and, with `--write`, applies it |
| `pnpm release:collect` | After editing release prose by hand | Re-derives coverage and regenerates `CHANGELOG.md` |
| `pnpm native:version` | When the npm target or a native archive changes | Previews the native selection: every archive aligns to `x.0.0` at a breaking npm major, and otherwise only changed archives move; `--write` applies it |
| `pnpm native:release:check` | In `pnpm platform:qualify` and `pnpm npm:prepare` | Rebuilds every native archive and refuses a stale selection, changed bytes under a published version or a stale ledger |

Since npm 3.0.0, native archive versions, for the language base and each native system, align to `x.0.0` whenever the npm target in `current.json` starts a new breaking major, including archives whose content did not change. Between majors each archive keeps its own version: npm releases alone never move it, and an archive whose bytes change, including through a changed dependency version, takes the bump its note names. Syntax, format, engine and protocol versions stay independent. `pnpm native:version --write` updates the system declarations, their public language copies, the native policies and `native/current.json`; it never publishes or changes npm versions. A change that alters a native archive's bytes needs its own entry in `native/notes.json` before the selection can be written. Within a major the note's bump selects that archive's next version, and the npm release's own bump must be at least the note's: a minor note needs at least an npm minor release, and no native change is selected while npm stays at its published version. The native check reads its baseline from the latest `v<version>` tag reachable from `HEAD`, so fetch the release tags first.

## What the checks do not establish

The tooling establishes completeness and freshness, not accuracy. A reviewer judges the prose in the release pull request, and approving the `npm` environment accepts the exact changeset digest. An untagged selection is preparation, not a release.

## Learn more

- [Publishing guide](../tools/distribution/NPM-PUBLISHING.md): the full flow, setup, publication and recovery
- [Release tooling contract](../tools/release/SPEC.md): coordinated and native versioning rules
- [Contributing guide](../CONTRIBUTING.md#release-notes) and the [changelog](../CHANGELOG.md)
- [Root README](../README.md)
