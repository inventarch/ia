---
id: spec-workspace-initialization
genre: spec
title: Workspace initialization
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-12"
owners: [inventarch]
---

# Workspace initialization

The starter is implemented by [init](../../../apps/cli/src/init.ts) and the bundled language builder. The detailed migration contract is in the [CLI specification](../../../apps/cli/SPEC.md).

## 1 Purpose

Create an ordinary consumer workspace over an explicit, pinned native language base. Planning is read-only; mutation requires the apply command.

## 2 Inputs

The target is a directory, optionally named by a provider/package id. Host registration is separately selected. Existing files, unsafe paths and an incompatible initialized state refuse with a repair command.

## 3 Bundled language

The CLI carries `assets/base.json` and exactly the digest-named archive it pins. [language-base.ts](../../../tools/native/language-base.ts) selects floor, public system contracts and schemas, and the language distribution root from [the public manifest](../../../examples/public-language/manifest.json). Example work records are excluded. The native language version comes from [versions.json](../../../examples/public-language/versions.json), independently of the coordinated npm version and syntax `1.0`.

## 4 Authored starter

The ordinary starter is `.ia/src/workspace.ia` containing a workspace, its agent participant and its mandate. It declares authored sources and composes installed systems. It defines no local system or distribution. The mandate is cooperative authority, not host permission or authentication.

`--system` explicitly opts into ownership of vocabulary: it adds a system and steward plus a distribution record, and composes the new local system.

## 5 Persistent state

The descriptor and lock pin the installed base. `.ia/.gitignore` is created only if absent and excludes generated work and distributions. Capture writes the runtime snapshot. A selected host adds packet projection as a separate effect.

## 6 Migration

`init --migrate` accepts the known legacy starter shape after a complete conflict and admission preflight. It preserves the descriptor id and retained record identities, moves retained source bytes, authors the new three-record starter, and removes the empty local system unless `--system` retains it. It refuses destinations or identities that collide and unfamiliar shapes. Migration is not a general corpus rewrite.

## 7 Acceptance

[Initialization tests](../../../apps/cli/tests/init.test.ts) cover starter shape, admission, repeat execution, migration preservation and conflicts. A fresh install must restore the exact pinned language offline from retained archive bytes; a passing local candidate does not establish registry publication.
