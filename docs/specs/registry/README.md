---
id: spec-registry
genre: spec
title: Distribution registry
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-12"
owners: [inventarch]
---

# Distribution registry

The public registry is a provider interface owned by [registry-source](../../../apps/distribution/src/registry-source.ts), [layout](../../../apps/distribution/src/registry-layout.ts), [configuration](../../../apps/distribution/src/registry-config.ts) and the [consumer distribution commands](../../../apps/cli/src/distribute.ts).

## 3 Provider interface

A registry exposes `base`, decoded `info`, `index(id)`, `artifactUrl(digest)` and `artifactBytes(digest)`. Opening reads `ia-registry.json` once. Each index call reads fresh metadata; an absent package index means no releases. Artifacts are addressed by a validated SHA-256 under `artifacts/<digest>.ia.tgz`. HTTPS providers expose URLs; directory providers expose bounded bytes and refuse links or hard links.

## 4 Selection and doctor

Selection precedence is command `--registry`, `IA_REGISTRY`, workspace `.ia/registries.json`, user configuration, then the built-in Inventarch default. The chooser reads configuration once per command. HTTPS bases require no credentials, query or fragment; other URL schemes refuse. Directory bases resolve against the declared caller directory.

Doctor reads the portable lock and configuration only and reports selected provider locations even when local activation is missing. It does not contact providers. A registry selection or acquired archive never grants executable host authority.

## 5 Resolution and acquisition

Registry reads share a command budget, cancellation and byte limits. Index documents are bounded to 4 MiB. Declared package identities, versions, dependencies and archive/manifest digests must agree with the installed artifacts. Transport, malformed metadata and exhausted budgets remain attributable refusals.

### 5.4 Offline

Offline resolution uses cached archives and reaches only requested/locked ids and their dependencies. It must not fall back to network or an arbitrary installed credential. Retained lock and archive bytes support reproducible restore.

## 6 Consumer operations

Install/update plan before mutation and recheck at apply. Update without `--to` keeps the request range while dropping that package's preferred pin, selecting the newest permitted release. Online restore checks withdrawals before reacquiring locked bytes. Remove reads the lock without choosing a provider. Projection refresh follows the admitted installed set; its failure reports any completed installation.

Provider extensions, kit indexing and workspace adoption retain this transport boundary and must state their own source placement and projection behavior. [Registry tests](../../../apps/cli/tests/registry.test.ts) cover consumers; provider implementation tests cover metadata and transport refusals.

The [registry collections contract](../../../apps/distribution/references/registry-collections.md) defines kit and workspace indexes, source-only workspace adoption, trust refusals, projection refresh and rollback for these extensions.
