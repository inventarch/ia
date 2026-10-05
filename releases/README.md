# Release changesets

`current.json` selects the coordinated npm version, actual published baseline and allowed packed dependency cycles. Each version consumes one authored `changesets/<version>.json`. Record real user-facing changes and package impact, then explicitly collect and review file coverage. Consumed means allocated to a release; registry publication is separate.

Follow [the publishing guide](../tools/distribution/NPM-PUBLISHING.md). `release:check` refuses incomplete or stale release evidence. The generator cannot determine semantic accuracy of prose; a maintainer reviews the diff and acknowledges the exact changeset digest before publication.
