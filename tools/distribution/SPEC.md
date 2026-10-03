# Public emitted qualification

Exercises built authoring/resource APIs, public guide resolution and host projection success/refusal against the public native tree.

`pnpm packages:qualify` packs every public npm package and installs the archives into a temporary consumer outside the repository. Dependency installation prefers the local package cache and may retrieve missing registry metadata. It verifies release versions, runtime policy, dependency pins, license notices and every exported target, then imports all exports with the development condition enabled. A second consumer installs only the CLI and its declared dependencies. With network fetches refused and home/configuration paths isolated, that installed CLI initializes and validates a workspace and registers both supported hosts. The same check packages the editor VSIX. Run the root build first; `pnpm public:qualify` includes this artifact check.

This establishes local installed-artifact behavior on the executing platform. It does not publish artifacts, establish registry ownership, or qualify a live editor or fresh agent session.

## npm publishing

The public npm scope is `@inventarch`. [NPM-PUBLISHING.md](NPM-PUBLISHING.md) owns account setup and release operation. Public package manifests declare the canonical Git repository, package directory, public access and npm registry. Packed dependencies must resolve to registry packages; consumers must not require installation lifecycle scripts.

`pnpm npm:prepare` builds and qualifies packages, then retains the exact checked archives in an initially empty `artifacts/npm` directory. `npm-release.json` records their dependency order, version, SHA-512 integrity, source commit and dirty-checkout state. `pnpm npm:consumer` exercises the retained archives with npm 12's install-time security defaults. `pnpm npm:plan` verifies the manifest and every archive without publishing; `pnpm npm:trust-commands` prints account-side setup commands without running them.

`.github/workflows/npm-publish.yml` permits manual dispatch from the canonical repository's main branch after Public quality passes for that exact main commit. The build job has no OIDC permission. Only the separate npm environment job can publish; it receives same-run artifacts, checks their source and integrity, and uses the npm CLI with provenance. Release builds restore no task or dependency cache. Publication requires a clean source commit and OIDC, refuses stored npm tokens, preflights all package versions, and skips an existing version only when the registry integrity matches. Cross-package publication is sequential and not atomic. A dry run establishes preparation, never npm account ownership or successful publication.
