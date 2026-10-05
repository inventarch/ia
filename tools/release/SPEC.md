# Product distribution packing

The public packer creates candidate archives from the reviewed source selection. It does not publish them.

Before preparing archives, review and stage every intended public source addition/deletion, then run `pnpm npm:inputs`. This refreshes the current input descriptor while retaining original extraction provenance; it does not apply a private-source export to this checkout. Commit the reviewed source and descriptor together. A dirty, stale or changed archive is not a publication qualification.

Select npm package versions in each package.json independently of native system versions in the matching .ia/src/systems/<name>/system.ia and examples/public-language declaration. Keep examples/public-language/manifest.json and tools/distribution/system-package-policy.json membership aligned; the latter records each selected npmVersion and native.version. Select the language archive version in examples/public-language/versions.json. Rebuild and regenerate public assets, run `pnpm npm:inputs`, then rerun package and installed-consumer qualification for the new exact bytes. Syntax version headers remain 1.0.

`pnpm npm:prepare` builds, validates generated public assets and public behavior, packs the selected archives and retains their digests and compatibility evidence. `pnpm npm:plan` verifies the exact receipt before producing publication commands. Repository release permissions and an explicit publication decision remain separate.
