# Publishing IA packages to npm

The public npm scope is **`@inventarch`**. The CLI is `@inventarch/cli`; its binary remains `ia`. All 15 public packages share the release version. The private workspace root and VS Code extension are excluded from npm publication.

The [publishing workflow](../../.github/workflows/npm-publish.yml) uses GitHub Actions OIDC with npm trusted publishing. No npm token belongs in repository secrets. npm's [July 2026 security changes](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/) make dependency scripts, Git dependencies and remote tarball dependencies opt-in, and announce the retirement of direct publishing with 2FA-bypass tokens.

## Toolchains

| Use | Version |
| --- | --- |
| Package consumers and ordinary development | Node `>=22.22.0 <23` |
| Release preparation and publication | Node `22.22.2`, npm `12.2.0`, pnpm `10.33.0` |

npm 12.2.0 requires Node 22.22.2 or a supported newer major. Publishing uses Node 22.22.2 while preserving the existing package runtime range. Workspace installation and packing use pnpm so `workspace:` and `catalog:` references become publishable versions. The publish job uses the npm CLI for OIDC authentication.

## Account and package setup

Use an npm account with write access to the `@inventarch` organization and enable account 2FA. Sign in interactively with `npm login --auth-type=web`. Do not put passwords, tokens or one-time codes in source files or workflow inputs.

For each public package, configure this trusted publisher in its npm settings:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `inventarch` |
| Repository | `ia` |
| Workflow filename | `npm-publish.yml` |
| Environment | `npm` |
| Allowed action | Direct publishing with `npm publish` |

The matching GitHub environment is `npm`, restricted to the `main` branch. The workflow also checks the repository and branch. It has no automatic tag, release or pull-request trigger: a maintainer dispatches it deliberately.

`pnpm npm:trust-commands` prints one `npm trust github` command per package in dependency order. These commands configure npm and require interactive authentication/2FA. They are separate from the tokenless publishing job. See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) and [trust command reference](https://docs.npmjs.com/cli/v12/commands/npm-trust/).

After verifying trusted publishing works, select **Require two-factor authentication and disallow tokens** in each package's publishing settings. Dist-tag management permission is unnecessary: the workflow sets `latest` as part of publishing a new version and does not run `npm dist-tag`.

### First publication of a new package

npm requires a package to exist before its trusted publisher can be configured. Preparation and a dry run do not create npm packages or prove publisher authorization.

After completely unpublishing an older package, npm requires a 24-hour wait before a new version can be published under the same name. A registry 404 confirms that the package is unavailable; it does not prove the waiting period has expired. Keep the original `@inventarch/*` names and complete preparation during this wait. See npm's [unpublish policy](https://docs.npmjs.com/policies/unpublish/).

For a new name, npm supports [staged publishing](https://docs.npmjs.com/staged-publishing/). With an authenticated account, `npm stage publish <qualified-tarball> --access public` creates a public `0.0.0-stage` placeholder and holds the actual release for review. This reserves a package name; it is an external write. The staged payload becomes public only after a maintainer approves it with 2FA.

Use the tarballs from a successful preparation workflow. Once package names exist, configure their trusted publishers. Review staged entries with `npm stage list` and `npm stage view`; either approve the intended first publication through npm, or reject the bootstrap stages before publishing the release through OIDC. Approval and rejection require interactive authentication. Do not use dummy package contents as version 1.0.0.

The existing GitHub `v1.0.0` release predates the npm scope migration and contains `@ia` tarballs. Do not publish those under new names or move that tag. Build the `@inventarch` packages from the main commit containing this publishing setup; npm provenance records that exact commit.

## Prepare and review

Commit the intended release to `main` and wait for **Public quality** to pass on that exact commit. The workflow refuses a passing pull-request run or a successful run for another commit. A newer main commit needs its own successful run.

Dispatch **Publish npm packages** from `main`, enter the stable version in all public package manifests, and leave **publish** unchecked. For example:

```sh
gh workflow run npm-publish.yml --repo inventarch/ia --ref main -f version=1.0.0 -F publish=false
```

Preparation installs from the frozen lockfile, checks dependency advisories, builds the workspace, validates public resources, and qualifies the packed packages and VSIX. It retains the exact qualified tarballs in the workflow artifact `npm-release-<commit>`, along with `npm-release.json` containing package identities, dependency order, source commit and SHA-512 integrity values.

A second consumer installs those tarballs using npm 12's default security settings, imports their exports, and initializes and validates a workspace. No dependency-script approvals or Git/remote-tarball opt-ins are added.

For local preparation with the release toolchain:

```sh
pnpm install --frozen-lockfile
pnpm npm:prepare
pnpm npm:consumer
pnpm npm:plan --version 1.0.0
```

`artifacts/npm` must be absent or empty before preparation. Local plans report whether the source checkout is dirty. Such artifacts are reviewable but cannot be published by the workflow. On Windows, pass `--npm-cli /path/to/npm/bin/npm-cli.js` to `npm:consumer` so it can launch npm without a shell wrapper.

## Publish

After account setup and review, dispatch the same workflow with **publish** checked:

```sh
gh workflow run npm-publish.yml --repo inventarch/ia --ref main -f version=1.0.0 -F publish=true
```

The preparation job runs again. A separate `npm` environment job downloads its same-run artifact, rechecks version, source and every archive's integrity, and publishes in dependency order. Only this job receives `id-token: write`. It runs no workspace installation or build, restores no cache, and uses `npm publish --access public --provenance --ignore-scripts` against `https://registry.npmjs.org`.

Before the first write, it reads every package's registry metadata. Missing package names require account setup. An already-published version is skipped only if npm reports the identical SHA-512 archive integrity; a mismatch refuses the entire plan. npm does not provide an atomic transaction across packages: a later failure can leave an earlier package published. Retry the same commit and version after addressing the failure; never overwrite an existing version or silently change its bytes.

Provenance and successful publication must be checked on npm. A successful local test, `npm whoami`, or workflow preparation does not establish OIDC publishing authorization.

## Package inventory

`pnpm npm:trust-commands` derives this inventory from the current workspace manifests. The release contains:

- `@inventarch/language`, `@inventarch/graph`, `@inventarch/compliance`, `@inventarch/db`, `@inventarch/runtime`, `@inventarch/service-contracts`
- `@inventarch/session-system`, `@inventarch/agent-system`, `@inventarch/authoring-system`, `@inventarch/template-system`, `@inventarch/agent-composition-system`
- `@inventarch/distribution`, `@inventarch/cli`, `@inventarch/mcp-door`, `@inventarch/steward-hook`

Native system identities and `#! ia 1.0` syntax retain their existing names. The npm scope change affects package names and imports.
