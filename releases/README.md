# Releases

`current.json` selects the coordinated npm version, the published baseline it advances and the allowed packed dependency cycles. `changesets/<version>.json` is the consumed changeset for each version: release prose, every package's impact and exact coverage of every changed file. `pending/` holds release notes that are not part of a version yet. Consumed means allocated to a release; registry publication is separate, and the immutable `v<version>` tag records it.

Do not edit `current.json`, consumed changesets or `CHANGELOG.md` in an ordinary pull request. Add a note with `pnpm release:note` when a public package changes; `pnpm release:version` turns notes into the next version. The release workflow opens that change as the `release/next` pull request.

Follow [the publishing guide](../tools/distribution/NPM-PUBLISHING.md). `pnpm release:check` refuses changed packages without notes and edited published changesets; `pnpm release:check --strict` refuses incomplete or stale release evidence before publication. The tooling cannot judge whether prose is accurate. A reviewer checks it in the release pull request, and the `npm` environment approval accepts the exact changeset digest.
