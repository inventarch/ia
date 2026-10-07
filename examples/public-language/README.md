# Public language examples

These small examples demonstrate representation and generic compilation. They contain an original label-reading procedure, not a curated agent or design method.

| File | Demonstrates |
|---|---|
| [composition.ia](records/composition.ia) | Agent, capability, user-authored method, profile, workspace, harness and entry binding |
| [quality.ia](records/quality.ia) | Adopted newline requirement, named check and declared scenario |
| [architecture.ia](records/architecture.ia) | Interface/storage boundaries, a dependency edge and adopted constraint |
| [evidence.ia](records/evidence.ia) | Evidence attribution with explicitly unavailable bytes |
| [language.ia](records/language.ia) | Workspace and distribution root composing the eleven public systems; the workspace's participant and its mandate |
| [work.ia](records/work.ia) | A plan, its milestone, one task and the open decision it waits on; a made decision grounding a spec that partially supersedes another |

The starter system that `ia init` writes requires `agent-system`, `work-system` and `workspace-system`, so a new workspace can author `@plan`, `@milestone`, `@task` and `@decision` records without editing it. A system may use only words owned by systems it directly requires; a system of your own that does not list `- work-system` in `requires` refuses each such record with `IA-COMP-DISCRIMINATOR-FOREIGN`.

Run `pnpm public-language:check` to compile the manifest-selected corpus. Run `pnpm exec vitest run --config vitest.tools.config.mts tools/native/public-language.test.ts` for positive and negative conformance cases, including real toy quality and architecture evaluations. No model or marketplace service is called.

The [manifest](manifest.json) lists all inputs: the public kernel, canonical schemas, neutral system declarations and these examples. The declarations retain existing vocabulary identities, with neutral stewards and public-only requirements. The loader does not discover other authored records. The [language guide](../../docs/reference/language/README.md) explains authoring, evaluation limits and extension.

This corpus verifies that the public language can be compiled from explicitly selected inputs. The CLI bundles a language-only archive generated from the same manifest, excluding the illustrative records other than its language distribution root. `ia init <directory> --host none --apply --yes` installs that archive and creates a consumer workspace. See the [repository quickstart](../../README.md) for installing the CLI, writing a first record and checking it. Package installation and platform qualification are separate checks from this corpus's structural and execution examples.
