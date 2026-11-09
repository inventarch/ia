---
id: spec-registry
genre: spec
title: Distribution registry
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-18"
owners: [inventarch]
---

# Distribution registry

A registry is a read-only source of release, kit and workspace indexes and of the archives they name. Without `--catalog` or `--offline`, `ia install`, `ia update` and `ia restore` resolve from registries. `ia adopt` and `ia init --adopt` mount workspaces from them, and `ia doctor` reports which registry each provider uses. The [provider](../../../apps/distribution/src/registry-source.ts), [layout](../../../apps/distribution/src/registry-layout.ts), [configuration](../../../apps/distribution/src/registry-config.ts) and [consumer commands](../../../apps/cli/src/distribute.ts) implement this contract.

## 3 Provider interface

Section numbers are stable because source comments cite them; retired sections keep their numbers unused.

A registry base is a credential-free HTTPS URL or a local directory. Opening one reads `ia-registry.json` once; a base without it is not a registry. That file is exactly `{format, formatVersion, name}`, with `format` `registry` and `formatVersion` 1; the earlier `{format, name}` shape with `format` `ia.registry.v1` is still read. A registry exposes `base`, the decoded `info`, `index(id)` (also spelled `index('release', id)`), `index('kit', id)`, `index('workspace', id)`, `artifactUrl(digest)` and `artifactBytes(digest)`.

| Path | Holds |
| --- | --- |
| `packages/<provider>/<name>.json` | A release index (`registry-package`, `formatVersion` 1; `ia.registry-package.v1` is still read) of at most 1,000 releases |
| `kits/<provider>/<name>/index.json` | A kit index (`registry-kit`, `formatVersion` 1; `ia.registry-kit.v1` is still read) of at most 1,000 releases |
| `workspaces/<provider>/<name>/index.json` | A workspace index (`registry-workspace`, `formatVersion` 1; `ia.registry-workspace.v1` is still read) of at most 1,000 releases |
| `artifacts/<sha256>.ia.tgz` | One archive, named by its validated SHA-256 |

A release index is `{format, id, releases}`, with an optional reserved `signatures` key. A release is exactly `{version, archive, manifest, engine, language, dependencies, withdrawn, access}`: its version, archive and manifest digests, engine range, syntax versions (`language`, exactly `["1.0"]`), dependencies, `withdrawn` and `access`. A `public` release adds `artifact`, which is `artifacts/<archive>.ia.tgz`; a `licensed` one names none (§7). An unknown field refuses. Indexes are append-only: a published version's digests never change, and a registry that changes them is a conflict. Each index call reads fresh metadata, and an absent index means no releases. HTTPS registries expose artifact URLs; directory registries expose bounded artifact bytes and refuse links and hard links.

## 4 Selection and doctor

One chooser per command picks each id's registry by its provider. Each level is read at most once, and only when the levels above it leave the provider unmapped:

| Level | Source | Directory bases |
| --- | --- | --- |
| 1 | `--registry <url\|dir>`, for every id in the command | Absolute, or relative to the caller's directory |
| 2 | `IA_REGISTRY`, for every id in the command; an empty value is ignored | Absolute, or relative to the caller's directory |
| 3 | The workspace's `.ia/registries.json` | Relative only, and inside the workspace |
| 4 | `registries.json` in the user configuration directory (`IA_CONFIG_HOME`, else the platform's) | Absolute only |
| 5 | The built-in default, which maps provider `inventarch` to `https://api.inventarch.dev/registry` | None |

Levels 3 and 4 are files of the form `{"format": "registries", "formatVersion": 1, "registries": {"<provider>|*": "<base>"}}`; an exact provider beats `*`. Every entry is checked, so one invalid entry refuses every provider that reaches that level. The user file lives in `IA_CONFIG_HOME`, which must be absolute; otherwise in `%APPDATA%\ia` on Windows, `~/Library/Preferences/ia` on macOS, and `$XDG_CONFIG_HOME/ia` or `~/.config/ia` elsewhere. A provider no level maps refuses with `IA-DIST-REGISTRY-UNMAPPED`, naming `.ia/registries.json`. HTTPS bases must carry no credentials, query or fragment, and other URL schemes refuse with `IA-DIST-INPUT-INVALID`. `--registry` cannot be combined with `--catalog` or `--offline`.

`ia doctor` adds a `registry-<provider>` row for each provider the lock names, with the base and the level that chose it. A provider that no level maps, or whose configuration refuses, is a `warn` row naming the refusal code, and no registry rows appear while an apply is interrupted. Doctor reads only the portable lock and the configuration files, so it reports a fresh clone, or an installation whose activation is missing, and it never contacts a registry. Choosing a registry or acquiring an archive never grants executable or host authority.

## 5 Resolution and acquisition

### 5.1 Reads and bounds

All registries one command opens share one budget of 256 document reads, one cancellation signal and the transport bounds: 4 MiB per document and no redirects. An id's index is read when the command names the id, when the lock has no usable cached archive for it, or when a known range excludes the locked version; otherwise the verified cached archive answers for it. An archive without source provenance, such as the bundled language base, is unpublished: no registry can list it, so a registry that does fails integrity. An archive is published when its release descriptor's `source.repository` names a URL and `source.commit` names a full commit hash. `ia init` records both from Git when it can (see [initialization](../workspace-initialization/README.md#2-inputs)); set them before `ia pack` to publish an archive to a registry. Exhausted budgets, transport failures and malformed metadata are attributable refusals.

### 5.2 Selection

Only admissible releases reach the shared release search: not withdrawn, accepted by the running distribution engine, and inside a range that a request or a followed dependency places on the id. A locked version stays selectable and is preferred.

### 5.3 Acquisition

Only the selected archives are fetched and verified, in id order: by artifact URL from an HTTPS registry, by bytes from a directory registry. Each verified manifest must match its index entry in id, version, engine, syntax versions, dependencies and manifest digest; a mismatch is `IA-DIST-INTEGRITY-MISMATCH`.

### 5.4 Offline

`--offline` resolves from the workspace's cached archives only. It reaches only the requested and locked ids and their dependencies, and it never falls back to the network. The retained lock and archive bytes make restore reproducible.

## 6 Consumer operations

### 6.1 Install

`ia install` plans before it applies anything, though acquiring for the plan may fill the archive cache, and `--apply` rechecks every input. The lock pins each package's version, archive and manifest digests and its location: `sha256:<digest>` from a directory registry, the artifact URL from an HTTPS one. With `--json`, a `registries` field lists `{provider, base, level}` for each provider a registry answered.

### 6.2 Update

`ia update <id>` without `--to` keeps the request's range and drops only that id's preferred pin, so the newest release the range permits wins. `--to` replaces the range. An id that is not a direct request is refused. The language bases the CLI carries are offered as candidates beside the registry's releases for `inventarch/language`, cold or warm, online or offline: the same major as the newest carried base, never below the locked version, admitted by the workspace's ranges. A registry's own `inventarch/language` releases are held to the same bound: one below the locked version, or below the minimum the workspace's records need when the plan computes it, is neither followed nor selected, so no plan moves the base down. A selected carried base is cached from the CLI's verified bytes, so a clone with no registry can move to it.

### 6.3 Restore

Online, `ia restore` asks each locked package's registry whether its release was withdrawn before it reacquires anything, and refuses a withdrawn release with `IA-DIST-RELEASE-WITHDRAWN` unless `--allow-withdrawn`. A locked release the registry no longer lists, or lists with other digests, is a conflict. Unpublished archives are skipped, because no registry lists them; a clone whose cache is empty restores the bundled base from the CLI's own archive.

Restore reacquires only artifact URLs. A package locked from a directory registry has a `sha256:` location, and restore reads its bytes from the workspace cache, never from the registry. A clone whose cache lacks them refuses with `IA-DIST-RESTORE-REQUIRED` until `ia restore --catalog <file>` names every locked archive.

### 6.4 Transport refusals

Every transport failure, including DNS, TLS and the 30-second timeout, is `IA-DIST-ARTIFACT-UNAVAILABLE` and names the URL. `ia install`, `ia update` and `ia restore` refuse a transport failure at exit 4, as they do a remote document or archive over its byte bound (`IA-DIST-LIMIT-EXCEEDED`); `ia adopt` refuses the same failure at exit 3. A configured base without `ia-registry.json` is not a registry (`IA-DIST-INPUT-INVALID`). A built-in default that answers without `ia-registry.json` is `IA-DIST-ARTIFACT-UNAVAILABLE` for install, update and restore, and its message names the other sources. A refusal on the registry route names a registry remedy, never a catalog one.

### 6.5 Remove, refresh, kits and adoption

`ia remove` reads only the lock and never chooses a registry. An applied install, update or remove re-renders each registered host projection; a refresh that fails after the change committed says the installation is applied and names its own repair.

A kit index groups distribution requests. `ia install <id>` treats an id as a kit only when its release index is empty. The kit's members pass the same resolution, integrity and admission checks, and the lock pins the resulting requests and archives, so restore needs no kit metadata. The kit's identity is kept beside the lock in `.ia/kit-collections.json`, never in it, and installing the kit again replaces the members it recorded. A workspace index carries source files: `ia adopt <id>[@version]` and `ia init --adopt` pin one release under `.ia/open/<binding>/<revision>/` at band 50, add it to the `@workspace` sources, capture, and refresh registered projections. Workspace indexes refuse executable and configuration files and the authority records `@mandate`, `@agent-profile`, `@execution-binding`, `@hook`, `@capability` and `@check`. Kits and adoption grant no execution, host or registry authority. The [registry collections contract](../../../apps/distribution/references/registry-collections.md) defines their limits, refusals and rollback.

## 7 Licensed releases

A `licensed` release lists no artifact, and this CLI has no licensed acquisition path. When only a licensed release satisfies a request, `ia install` refuses with `IA-DIST-LICENSE-REQUIRED` at exit 3 and names an install from a local catalog of the archive obtained through its licensed channel.

## 8 Registry builder

`ia-distribution`, the binary of `@inventarch/distribution`, builds directory registries. `ia-distribution registry add --registry <absolute dir> --archive <absolute file> [--name <text>]` adds one verified archive to an existing directory registry: the artifact first, then `ia-registry.json` if absent, then the release index, so an index never names a missing artifact. A relative path refuses with `IA-DIST-INPUT-INVALID`. Adding the same version with the same digests changes nothing; other digests are a conflict, and an unpublished archive (§5.1) is refused. `ia-distribution registry withdraw --registry <absolute dir> --id <provider/name> --version <semver>` marks one release withdrawn and removes nothing. `registryAddCollection` writes kit and workspace indexes and refuses to remove or change a listed version. The builder writes only inside the registry directory, refuses links and never contacts a network. Publishing the directory is a separate step.

[Registry tests](../../../apps/cli/tests/registry.test.ts) and [adoption tests](../../../apps/cli/tests/adopt.test.ts) cover the consumer commands; the distribution app's tests cover metadata and transport refusals.
