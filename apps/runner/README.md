# @inventarch/runner

[![npm](https://img.shields.io/npm/v/@inventarch/runner?label=npm)](https://www.npmjs.com/package/@inventarch/runner) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json)

> `ia-runner` runs one admitted `@agent-profile` locally, with bounded execution and a durable journal. It composes the agent-system engine, session-system's SQLite journal and replay, the composition compiler and the runtime Door.
>
> It selects no model provider and creates no credentials. Each model turn waits for a response that you, or a host that embeds the runner, supply.

## ⚡ Quick start

```sh
npm install --global @inventarch/runner
```

Before you start, the workspace must select the installed `runner-local-v1` host contract, the `runner-read-v1` mandate contract and the `runner-entry-v1` entry mapping, and must admit `agent-composition-system`'s own `@operation read-captured-source`; a copy authored outside that system refuses with `IA-COMPOSITION-CONFLICT`. A workspace created by `ia init` alone provides none of these. The conformance composition's [`runner.ia`](../../examples/conformance/composition/.ia/src/systems/agent-composition-system/records/runner.ia) shows the `@agent`, `@mandate`, `@capability`, `@agent-profile`, entry `@execution-binding` and `@harness` declarations; the runner tests run it with this repository's public systems adopted.

A contract's version is the `version` of its installed entry, not part of its name, so the runner also installs each contract under a plain name (`runner-local`, `runner-read`, `runner-entry`, and likewise for the task, external model, outcomes, context and identity entries) and reads records that name either. Older, separately released programs accept only the names with the trailing `-v1`, so this release writes them: `runnerAliases()` is empty, and a record that names an original contract compiles to the original entry, which the runner installs unchanged. The plain names are written once `WRITE_PLAIN_NAMES` (`src/written-names.ts`) flips in the follow-up release (dec-008, A15); `runnerAliases()` then sends records that still name an original contract to the plain entry.

Run a profile, answer its pending model request, then step it to the end:

```sh
ia-runner run --root . --profile reader-profile --task "Read the captured task source"
ia-runner submit --root . --profile reader-profile --id <run-id> --attempt <attempt-id> --response response.json
ia-runner step --root . --profile reader-profile --id <run-id>
```

Each command prints one JSON line, `{id, sequence, run, pending}`. `run` captures the workspace, compiles the profile's harness, opens a durable run and advances it until it finishes or waits. A waiting run lists its model request under `pending`, with the attempt id and the position packet for that turn. `submit` takes one response for that attempt from a file such as:

```json
{"action":{"type":"outcome","kind":"answer","message":"Captured source read.","continuation":"finish"},"usage":1,"model":"runner/external","provider":"local"}
```

Repeat `step`, which advances one scheduler action, until `run.status` is `completed`. A refusal prints `{code, message, next}` on stderr and exits 1. Node 22 also prints an `ExperimentalWarning` for SQLite on stderr. `ia-runner --help` gives the full syntax, including `--harness` and `--entry`, which pick one when the composition offers several.

## 🧭 What it does

| Surface | What it does |
| --- | --- |
| `ia-runner run` | Captures source, compiles the harness, starts a run (`--id` names it) with `--task`, and advances it until it finishes, waits or reaches its step bound. |
| `ia-runner step` | Resumes the run `--id` names and advances one scheduler action. |
| `ia-runner submit` | Accepts one model response for a pending attempt, from an unchanged regular file of at most 64 KiB. |
| `openRunner(options)` | For hosts: opens `profile` under `root`, with an optional trusted `model` adapter, `authorize` and `evaluate` callbacks, and returns `start`, `step`, `run`, `resume`, `submit` and `close`. |
| `runnerCatalog()` | The installed contracts above and their defaults. |
| `RunnerError` | A refusal with a stable `code` and a `next` command. |

- **Bounded.** The `runner-local-v1` ceiling is 64 steps, 16 model calls, 16 operations, 200,000 tokens, 8 MB, one hour and no child runs. A governing `@mandate`'s `execution` limits narrow it, as `limit-operations 1` does in the conformance mandate.
- **Positioned.** Every model turn gets a phase-specific position through the Door, and the request journal keeps its key, body and host note.
- **Durable.** Journals live under `.ia/work/runs/` with hash-chain replay. Resume requires the original principal, manifest and source capture, and keeps the original deadline.
- **Evidence.** Receipts under `.ia/work/runner-evidence/` can be admitted as runtime-placed `@run` and `@observation` records. They never move the authored revision or change mandate authority.

## ⚖️ What it does not do

- **No live model provider and no credentials.** The default model defers to you and only records the pending request.
- **Installation supplies no authority.** Native source never selects an import, executable or credential. Observation permission is required before each model turn, and the applicable `@mandate` moves and excluded words are checked before each operation dispatch.
- **The built-in grant is read-only.** The local host installs only the captured-source read. Host authorization can narrow that ceiling, never widen it.
- **No writes, delegation, publication or review.** This host implements no write operations, delegated execution, external publication or independent review authority.
- **A journal is not proof.** Journal integrity is not external attestation, execution authorization or proof of real-world effects. Runtime files are local evidence, not committed source or release artifacts.

## 📚 Learn more

- [SPEC.md](SPEC.md): execution, context, persistence and evidence boundaries
- [LANGUAGE.md](LANGUAGE.md): the packaged summary of the words this release ships
- [Conformance fixtures](../../examples/conformance/SPEC.md)
- [agent-system](../../.ia/src/systems/agent-system/SPEC.md), [session-system](../../.ia/src/systems/session-system/SPEC.md) and [agent-composition-system](../../.ia/src/systems/agent-composition-system/SPEC.md): the engine, journal and compiler it composes
- [`@inventarch/runtime`](../../packages/runtime/README.md): the Door that delivers each position
- [Architecture reference](../../docs/reference/architecture/README.md)
- [Root README](../../README.md)
