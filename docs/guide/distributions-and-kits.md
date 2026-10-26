# Distributions and kits

**A distribution is a versioned, digest-named archive of records: usually a system, with its words and schemas, and sometimes rules, playbooks and other records. Workspaces install distributions, and a lock pins exactly which archives they use. A kit is a named group of distributions installed together.**

## The language is a distribution

Every workspace already uses one distribution: `inventarch/language`, which holds the eleven public systems and their 44 words. The CLI carries a copy, and `ia init` installs it from there, with no network.

That explains the version numbers you will see:

| Number | Example | Is the version of |
| --- | --- | --- |
| The CLI | `3.4.0` | The `@inventarch/cli` npm package: the `ia` command |
| The language | `3.2.0` | The `inventarch/language` distribution the CLI bundles |
| The syntax | `1.0` | The `.ia` file format, in `#! ia 1.0` |
| Your workspace | `0.1.0` | Your own release, in `.ia/release.json` |

The CLI and the language move to the same major version together. Within a major, the language changes version only when its content changes.

## What a workspace pins

`.ia/distributions.lock.json` lists the distributions this workspace asked for and the exact archives it resolved, by sha256. It is committed. The installed copies live in `.ia/distributions/`, which is not committed. `ia restore --apply --yes` rebuilds it from the lock in a fresh clone.

## Installing a distribution

Distributions come from a **registry** or from a local **catalog**.

```sh
ia install <provider/name>                 # plan: what would be installed, from where
ia install <provider/name> --apply --yes   # do it
```

| Command | Does |
| --- | --- |
| `ia install <id>[@<range>]` | Adds one or more distributions. `@^1.2.0` limits the version. |
| `ia update <id> [--to <range>]` | Moves one installed distribution to the newest version in its range, or a new range |
| `ia remove <id>` | Removes one |
| `ia restore --apply` | Reinstalls exactly what the lock says |
| `ia recover` | Finishes or undoes an install that was interrupted; IA tells you when it is needed |

`install`, `update` and `remove` plan first and change nothing without `--apply`. They never touch your records in `.ia/src/`. These commands are not checked against mandates.

Once installed, a distribution's words work in your records straight away; you do not list its system in your `@workspace`. Its records appear at band 90, adopted, below your own at band 100.

### From a local catalog

A **catalog** is a JSON list of archive files. It is the simplest way to share a distribution inside one repository or team, with no registry. To use the [kitchen system](your-own-vocabulary.md) in Pantry, copy its archive into Pantry, say into `vendor/`, and list it together with the language archive, which a catalog must also provide:

```json
[
  { "path": "vendor/c0355becd3bd14aebfa45a8a96b3395af08c041a00be67f90d525883d150778c.ia.tgz", "withdrawn": false },
  { "path": ".ia/distributions/cache/7b36e4b4959a7bead1c57906cd346b419f32570dac0ac764af805ad20cd63b16.ia.tgz", "withdrawn": false }
]
```

```sh
ia install local/kitchen --catalog catalog.json --apply --yes
```

```text
Changes
  +  local/kitchen  0.1.0  sha256 c0355becd3bd…  direct
  1 added, 0 removed, 0 updated, 0 shadowed.
```

Pantry can now write `@allergen` records. A teammate's fresh clone restores with the same catalog. Without it, IA does not know where `local/kitchen` comes from and refuses with `IA-DIST-REGISTRY-UNMAPPED`:

```sh
ia restore --catalog catalog.json --apply --yes
```

Paths in a catalog are relative to the workspace root. An entry may give `{ "url": …, "digest": … }` instead of a path.

### From a registry

A **registry** is a folder or an HTTPS site with a fixed layout of index files and archives. IA picks a registry for each provider (the part of an id before the `/`) in this order:

1. `--registry <url-or-folder>` on the command line;
2. the `IA_REGISTRY` environment variable;
3. `.ia/registries.json` in the workspace;
4. `registries.json` in your user configuration folder;
5. the built-in default for the `inventarch` provider, `https://api.inventarch.dev/registry`.

`registries.json` maps providers to registries:

```json
{ "format": "ia.registries.v1", "registries": { "acme": "https://ia.example.com/registry", "*": "../shared-registry" } }
```

Registry URLs must be HTTPS, with no credentials, query or fragment. A folder registry in `.ia/registries.json` must be a relative path inside the workspace. A provider with no registry refuses with `IA-DIST-REGISTRY-UNMAPPED`.

The [registry specification](../specs/registry/README.md) describes the layout. To build a folder registry, use `ia-distribution registry add` from [`@inventarch/distribution`](../../apps/distribution/README.md). A registry lists only archives that record where their source lives: `source.repository` and `source.commit` in `.ia/release.json`.

## Kits

A **kit** is an entry in a registry that names several distributions to install together, such as a team's standard rules plus its review playbooks. `ia install <kit-id>` installs each member as an ordinary distribution, and the lock pins the members, so a restore needs no kit information. Installing a kit grants nothing; it only adds records.

## Packaging your own

A workspace created with `ia init --system` can be packed. Its `.ia/release.json` names a `@distribution` record, and the distribution lists the root records to ship:

```ia
@distribution kitchen-distribution
  meaning
    says "The release root of the kitchen system."
    answers "Which records does this release ship?"
  distribution
    records [@system kitchen]
```

```sh
ia pack --descriptor .ia/release.json
```

This writes `<sha256>.ia.tgz` to `.ia/work/dist/`. The file name is the archive's digest, so anyone can check a copy before installing it. `ia pack` refuses a workspace whose descriptor names no distribution, and refuses to overwrite an existing archive unless you pass `--force`. Raise `version` in `.ia/release.json` for each new release.

[`distributions/product-structure`](../../distributions/product-structure/README.md) in this repository is a complete example of an optional distribution: one system, `product-system`, that adds one word, `@product`, with its schema, steward, contract, cases and an authoring guide.

## Adopting a workspace

`ia adopt <id>[@version]` brings in another workspace's records from a registry as pinned source, under `.ia/open/`, instead of as an installed archive. They appear at band 50, open, below both your records and installed ones. Adoption refuses records that carry authority or execution: mandates, agent profiles, execution bindings, hooks, capabilities and checks.

## Plugins as kits

IA can treat an existing Claude Code, Codex or Grok plugin as a workspace:

```sh
ia init my-kit --from path/to/my-plugin --apply --yes
ia project claude --product plugin --check --compare path/to/my-plugin --root my-kit
ia project claude --product plugin --out rendered --root my-kit --apply --yes
```

The first command turns the plugin into records, with a map of how each file was lowered and a `MIGRATION.md` listing anything it could not represent. The second checks that rendering the records back reproduces the plugin exactly. The third writes the plugin. You can then maintain the plugin as records, with validation, and render it for each host.

## Common refusals

| Code | Because | Do |
| --- | --- | --- |
| `IA-DB-SOURCE-UNAVAILABLE` (`restore-required`) | A fresh clone has no installed distributions | `ia restore --apply --yes` |
| `IA-DB-SOURCE-UNAVAILABLE` (`lock-drift`) | The lock no longer matches what is installed, after a pull or a line-ending change | `ia restore --apply --yes`; see [Workspaces](workspaces.md#working-in-a-team) |
| `IA-DB-SOURCE-UNAVAILABLE` (`engine-incompatible`) | The lock was written by a newer IA | Use that IA version or newer |
| `IA-DIST-REGISTRY-UNMAPPED` | No registry or catalog for a provider | Map it in `.ia/registries.json`, or pass `--registry` or `--catalog` |
| `IA-DIST-ARTIFACT-UNAVAILABLE` | The registry or archive could not be reached | Check the network or the path, or use `--offline` with a cache |
| `IA-DIST-CONFLICT` | No set of versions satisfies every request | Widen a range, or add the missing archive to the catalog |
