# Product distribution packing

The public packer creates candidate archives from the reviewed source selection. It does not publish them.

Before preparing archives, review and stage every intended public source addition/deletion, then run `pnpm npm:inputs`. This refreshes the current input descriptor while retaining original extraction provenance; it does not apply a private-source export to this checkout. Commit the reviewed source and descriptor together. A dirty, stale or changed archive is not a publication qualification.

Select npm package versions in each package.json independently of native system versions in the matching .ia/src/systems/<name>/system.ia and examples/public-language declaration. Keep examples/public-language/manifest.json and tools/distribution/system-package-policy.json membership aligned; the latter records each selected npmVersion and native.version. Select the language archive version in examples/public-language/versions.json. Rebuild and regenerate public assets, run `pnpm npm:inputs`, then rerun package and installed-consumer qualification for the new exact bytes. Syntax version headers remain 1.0.

`pnpm npm:prepare` builds, validates generated public assets and public behavior, packs the selected archives and retains their digests and compatibility evidence. `pnpm npm:plan` verifies the exact receipt before producing publication commands. Repository release permissions and an explicit publication decision remain separate.

## Coordinated npm releases

`releases/current.json` selects one version for every public npm package, the published source baseline, the publication tag and complete allowed dependency cycles. Native-system and protocol versions remain independent. A new npm release must advance its published baseline and consume a reviewed changeset under `releases/changesets/<version>.json`.

The changeset names every public package with either described changes or a justified cohort-only entry. It groups user-facing changes and binds every changed tracked file since the baseline to a change entry and its exact SHA256 (or deletion). Only the self-referential changeset, generated changelog and public input descriptor are excluded from that file list; their exact bytes are sealed by the release receipt or existing input boundary. Unlisted files, missing packages, unknown packages, unconsumed entries, stale coverage and changed historical entries refuse qualification. Commit coverage is derived from Git history and retained with the exact source revision. Machines establish coverage and freshness; a maintainer reviews semantic accuracy and acknowledges the changeset digest at publication.

Publication receipts are version2 and retain the actual packed dependency graph. Strongly connected components are ordered before their consumers; a cycle must exactly match a reviewed complete group. Uniform versions cannot eliminate cycles or make sequential npm publication atomic. Every internal packed dependency must name a selected package at the exact cohort version.

A registry preflight checks the whole cohort before writes, refuses newer registry versions and conflicting immutable bytes, and permits retry only for identical archives with the expected tag. A separate read-only verification job checks all final registry versions, downloaded bytes, latest tags and provenance, then installs the exact registry cohort with scripts disabled and runs npm signature/attestation verification. An interrupted publish remains partial until the complete verification succeeds; neither a preparation run nor package existence proves trusted-publisher authorization.
