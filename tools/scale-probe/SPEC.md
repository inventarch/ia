# scale-probe tooling contract

## Purpose

Build synthetic and public IA trees, run every probed command on them under one or more CLIs, and compare the normalised outputs and the time and memory of each command. It captures the 3.7.0 reference outputs in [packages/db/tests/fixtures/reference-3.7.0](../../packages/db/tests/fixtures/reference-3.7.0/README.md) and checks a later build against them. It runs on a developer machine or a server, never in GitHub Actions.

## Modules

- [generate.mjs](generate.mjs) and [generate.d.mts](generate.d.mts) — the seeded synthetic tree: a fresh `ia init` workspace, then work records.
- [normalise.mjs](normalise.mjs) and [normalise.d.mts](normalise.d.mts) — the normalisation of one command's JSON output.
- [capture.mjs](capture.mjs) — runs each command on fresh copies of one tree and records digests, times and memory.
- [measure.mjs](measure.mjs) — runs the CLI in its own process and reports its wall time, CPU time and peak memory.
- [probe.mjs](probe.mjs) — builds each listed tree once and captures it under each CLI.
- [compare.mjs](compare.mjs) and [compare.d.mts](compare.d.mts) — compares two sets of captures.
- [trees.json](trees.json) — the reference trees: synthetic sizes and seeds, and public fixtures pinned to a commit.
- [scale-probe.test.ts](scale-probe.test.ts) — the generator, normaliser and comparison, with no CLI run.

## Commands

No public pnpm entry. Each script takes its options as described below, writes one JSON line or a Markdown table on stdout, and exits 0 on success, 1 on an evaluated failure and 2 on a usage or runtime error.

- `node tools/scale-probe/generate.mjs --cli <bin.js> --records <n> [--seed <n>] [--git] <out>` writes one synthetic tree. `--git` commits it with a fixed author and date and adds the `kb pack` selection.
- `node tools/scale-probe/capture.mjs --cli <bin.js> --label <label> --tree <dir> [--runs <n>] [--commands <a,b>] [--keep <dir>] [--no-measure] --out <file>` captures one tree. It exits 1 when two runs of one command disagree.
- `node tools/scale-probe/probe.mjs --init-cli <bin.js> --cli <label>=<bin.js>... [--only <names>] [--synthetic <n,n>] [--runs <n>] [--no-measure] [--work <dir>] --out <dir>` builds and captures the trees of `trees.json`, plus any extra synthetic sizes. Run it from the repository root.
- `node tools/scale-probe/compare.mjs <before> <after> [--outputs-only] [--slower <ratio>] [--larger <ratio>] [--json <file>]` exits 1 when an output differs or is missing, or, without `--outputs-only`, when a median wall time or peak memory is past its ratio (default 1.1) by more than 150 ms or 16 MB.

The reference is written with `probe.mjs --init-cli <3.7.0> --cli 3.7.0=<3.7.0> --runs 2 --no-measure --out <dir>`, and its `3.7.0` folder becomes `packages/db/tests/fixtures/reference-3.7.0/`. A build is checked against it with `probe.mjs --init-cli <3.7.0> --cli <label>=<build> --no-measure` and `compare.mjs packages/db/tests/fixtures/reference-3.7.0 <out>/<label> --outputs-only`.

## Inputs

The CLIs named by `--init-cli` and `--cli`, each a `dist/bin.js`; this repository's Git history for the `git` trees of `trees.json`; and `git` and `tar` on `PATH`.

## Outputs

Capture files in the `ia.scale-probe.capture.v1` format: per command, its exit code, the SHA-256 digest and size of its normalised output, a short summary, the digests of the files it writes, and whether every run agreed; with measurement, each run's wall time, CPU time and peak memory. Trees and copies are made under `--work` or the temporary directory and removed afterwards.

## Prerequisites

Node 22. The `--init-cli` must be `@inventarch/cli` 3.7.0 for a tree to match the reference: `ia init` writes the installed language the CLI carries, so another CLI builds another tree. Install it from npm into a folder of its own, outside the trees.

## Validation

Task ownership: `tools:test-scale-probe`. The test covers the generator's determinism, counts, references and layout, the `kb pack` selection, the normaliser's rules and the comparison's verdicts. The CLI runs themselves are measurements and stay out of the suite.

## Invariants

- No tree holds content from outside public IA: synthetic trees start from `ia init` and generated text, and git trees come from this repository.
- The two sides of a comparison run on separate fresh copies of the same tree, so evidence one run writes never reaches the other.
- Normalisation makes the workspace root relative and removes only evidence `observedAt` times, `timings`, a `cache` object's `state` and `observations`, and capture's prior-state fields `prior`, `previous`, `rotated`, `changed` and `new`. Everything else in an output is compared.
- The same size and seed give the same files and the same commit.

## Limits

- Outputs are compared by digest. A difference names the tree and command; `capture.mjs --keep <dir>` writes the normalised outputs for a diff.
- Times and memory depend on the machine, so they are compared only between CLIs run on the same machine in one probe. The reference holds outputs alone.
- `kb pack` runs only on trees with a commit, which the synthetic trees have.
