# Public language examples

[![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../../LICENSE)

> Small, original records that show the public vocabulary at work: agent composition, quality, architecture, evidence, the language root and project work. They demonstrate representation and generic compilation. They are not a curated agent team, design method or quality standard.

| File | Demonstrates |
| --- | --- |
| [composition.ia](records/composition.ia) | An agent, a user-authored playbook that reads a label, a capability, an agent profile, a workspace, an entry execution binding, a harness that composes them, and a distribution root |
| [quality.ia](records/quality.ia) | A workspace adopting a versioned newline requirement, a check that enforces it, and a success case and a failure case |
| [architecture.ia](records/architecture.ia) | Interface and storage boundaries, a `uses` dependency edge, an adopted boundary constraint and its success and failure cases |
| [evidence.ia](records/evidence.ia) | Two observations: one whose evidence bytes are explicitly unavailable, and one typed as a check result about one record at one revision |
| [language.ia](records/language.ia) | The workspace and distribution root that compose the eleven public systems |
| [work.ia](records/work.ia) | A plan, its milestone, two ordered tasks and the open decision the first one waits on; a made decision grounding a spec that partially supersedes another |

## Try one in your workspace

Each file is admitted when copied into the `.ia/src/` of a workspace that `ia init` created. Copy `records/work.ia` to `.ia/src/work-example.ia`, then run:

```sh
ia validate
ia next --seat work-system/definition/plan/example-plan
```

`ia next` reports `example-task` blocked because `example-decision` has no choice yet, and `example-reference-review` blocked behind `example-task`. Validation also shows what the other examples leave unproven: the quality and architecture requirements stay `not-evaluated` without an evaluator, and the composition example's `example-entry` binding is `unavailable` because no installed catalog lists an entry implementation.

- Copy `evidence.ia` together with `quality.ia`: its observations cite the quality contract, and on their own they report `IA-GRAPH-TARGET-MISSING`.
- Leave `language.ia` out of your workspace. It declares a second `@workspace` over `.ia/src`, so `ia position` without `--seat` could no longer pick your workspace as the default seat.

## How this repository checks them

- [manifest.json](manifest.json) lists every input: the kernel floor, the canonical schemas, the neutral system declarations in `contracts/` and these records. The loader discovers nothing else. The declarations keep each word's identity, schema and consent, with neutral stewards and public-only requirements.
- `pnpm public-language:check` compiles that corpus and the example harness. No model, account or marketplace service is called.
- `pnpm exec vitest run --config vitest.tools.config.mts tools/native/public-language.test.ts` runs the positive and negative conformance cases. Missing fields, dangling relationships, a missing profile, a recursive capability and an unavailable host implementation are refused. Toy evaluators observe the newline requirement pass and fail on real bytes and the boundary requirement fail when the `uses` edge is removed, and a missing or throwing evaluator stays `not-evaluated`.
- `fixtures/` holds fixture-only release selectors for tests, apart from the public language base.
- [versions.json](versions.json) selects the version of the language base the CLI bundles. That archive is generated from the same manifest and keeps only the vocabulary and the language distribution root; `ia init` installs it in every new workspace.

## What the examples do not establish

Admission checks structure. The observation's fields show the shape of evidence: schema conformance does not verify timestamps, content digests, provenance, retention transitions or that external evidence exists, and the placeholder digest is not an attestation. Declared cases and observations never manufacture execution evidence, and the toy requirements endorse no architecture or quality method.

See the [examples contract](SPEC.md), the [language guide](../../docs/reference/language/README.md), the [walkthrough](../../docs/guide/walkthrough.md) and the [architecture reference](../../docs/reference/architecture/README.md).
