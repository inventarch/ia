# runtime tooling contract

## Purpose

Retain the manual SDK release consumer until its planned move to distribution.

## Modules

- [qualify-sdk.mjs](qualify-sdk.mjs).

## Commands

No public pnpm entry; callers import the modules or use the manual contract below.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Five positional arguments: public tree, archives, new output, pnpm launcher and offline store; sealed release receipt and exact archive digests.

## Outputs

Creates a new isolated SDK consumer and evidence under the supplied new output.

## Prerequisites

Prepared release artifacts, pinned package manager and offline store.

## Validation

Caller tasks own execution; `tests:inventory` checks the complete assignment. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

No existing consumer directory is overwritten. Release identity and receipt checks precede installation.

## Limits

This transitional owner is removed after SDK qualification moves to distribution; ordinary qualification cannot substitute for sealed SDK release evidence.

## Detailed behavior

Verifies receipt-selected public archive bytes, dependency closure and independently installed ordinary Node consumers. Executes deterministic onboarding, first-party captured read and explicit specification-body fixtures. No private checkout, paid provider or publication is part of this gate.

The explicit pnpm launcher argument accepts either a JavaScript entry or a native executable through `tools/entry/package-manager.mjs`; a pnpm 12 binary is never parsed by Node. The caller supplies the qualified package-manager version and populated store. An offline install remains a separate observation from any earlier store population.

The candidate is verified against its committed v2 public input seal and the retained `npm-release.json` with its exact archive integrities and compatibility companion. SDK membership combines the core runtime packages with systems from the public language manifest. No extraction receipt in Git metadata is read. Run this only against a fully prepared local release candidate; it does not query or publish to a registry.
