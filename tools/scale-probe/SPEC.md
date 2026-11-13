# scale-probe tooling contract

## Purpose

Build synthetic and public IA trees, run every probed command on them under one or more CLIs, and compare the normalised outputs and the time and memory of each command. It captures the 3.7.0 reference outputs in [packages/db/tests/fixtures/reference-3.7.0](../../packages/db/tests/fixtures/reference-3.7.0/README.md) and checks a later build against them. It runs on a developer machine or a server, never in GitHub Actions.

## Modules

- [generate.mjs](generate.mjs) and [generate.d.mts](generate.d.mts) — the seeded synthetic tree: a fresh `ia init` workspace, then work records.
- [normalise.mjs](normalise.mjs) and [normalise.d.mts](normalise.d.mts) — the normalisation of one command's output or written file.
- [capture.mjs](capture.mjs) — runs each command on fresh copies of one tree and records digests, times and memory.
- [measure.mjs](measure.mjs) — runs the CLI in its own process and reports its wall time, CPU time and peak memory.
- [probe.mjs](probe.mjs) and [probe.d.mts](probe.d.mts) — builds each listed tree once, captures it under each CLI, and checks the exits each tree expects.
- [compare.mjs](compare.mjs) and [compare.d.mts](compare.d.mts) — compares two sets of captures.
- [trees.json](trees.json) — the reference trees: synthetic sizes and seeds, public fixtures pinned to a commit, what each covers and the exit each command is expected to give.
- [scale-probe.test.ts](scale-probe.test.ts) — the generator, normaliser, expected exits and comparison, with no CLI run.

## Commands

No public pnpm entry. Each script takes its options as described below, writes one JSON line or a Markdown table on stdout, and exits 0 on success, 1 on an evaluated failure and 2 on a usage or runtime error.

- `node tools/scale-probe/generate.mjs --cli <bin.js> --records <n> [--seed <n>] [--git] <out>` writes one synthetic tree. `--git` commits it with a fixed author and date and adds the `kb pack` selection.
- `node tools/scale-probe/capture.mjs --cli <bin.js> --label <label> --tree <dir> [--runs <n>] [--commands <a,b>] [--keep <dir>] [--no-measure] --out <file>` captures one tree. It exits 1 when two runs of one command disagree, and 2 when a run does not finish.
- `node tools/scale-probe/probe.mjs --init-cli <bin.js> --cli <label>=<bin.js>... [--only <names>] [--synthetic <n,n>] [--runs <n>] [--no-measure] [--work <dir>] --out <dir>` builds and captures the trees of `trees.json`, plus any extra synthetic sizes. Run it from the repository root. It exits 1 when two runs disagree or a command exits otherwise than its tree's `expect`. It exits 2, before building anything, when `<out>/<label>` already holds captures for one of its CLIs: a tree the run did not finish would keep the earlier capture, and a comparison would read it as this run's.
- `node tools/scale-probe/compare.mjs <before> <after> [--outputs-only] [--slower <ratio>] [--larger <ratio>] [--json <file>]` exits 1 when an output differs, is missing or was unstable in its capture, when two captures under one name are of different trees, or, without `--outputs-only`, when a median wall time or peak memory is past its ratio (default 1.1) by more than 150 ms or 16 MB. It exits 2 when there is nothing to compare: neither side holds a capture, or no capture holds a command output.

The reference is written with `probe.mjs --init-cli <3.7.0> --cli 3.7.0=<3.7.0> --runs 2 --no-measure --out <dir>`, and its `3.7.0` folder becomes `packages/db/tests/fixtures/reference-3.7.0/`. A build is checked against it with `probe.mjs --init-cli <3.7.0> --cli <label>=<build> --no-measure` and `compare.mjs packages/db/tests/fixtures/reference-3.7.0 <out>/<label> --outputs-only`. Within each command, a probe alternates its runs between the CLIs, so a burst of load on the machine falls on both sides rather than on one side's runs. Run it with five or more runs when its times and memory matter. Peak memory moves by tens of megabytes between runs of one build with garbage collection, and on a shared or virtual machine wall time moves by tens of percent.

## Inputs

The CLIs named by `--init-cli` and `--cli`, each a `dist/bin.js`; this repository's Git history for the `git` trees of `trees.json`; and `git` and `tar` on `PATH`.

## Outputs

Capture files in the `ia.scale-probe.capture.v1` format. For each command they record:
- its exit code;
- the SHA-256 digest and size of its normalised standard output, and the digest of its normalised standard error;
- a short summary;
- the digest of every file it added, changed or removed in its copy;
- whether every run agreed;
- with measurement, each run's wall time, CPU time and peak memory.

Trees and copies are made under `--work` or the temporary directory and removed afterwards.

## Prerequisites

- Node 22, and `git` 2.28 or later, for `init --initial-branch`.
- A clone with the history `trees.json` pins; a shallow clone cannot archive those commits.
- The `--init-cli` must be `@inventarch/cli` 3.7.0 for a tree to match the reference: `ia init` writes the installed language the CLI carries, so another CLI builds another tree. Install it from npm into a folder of its own, outside the trees.

## Validation

Task ownership: `tools:test-scale-probe`. The test covers:
- the generator: its determinism, the digest of the files the reference was captured on, counts, references and layout;
- the `kb pack` selection;
- the normaliser's rules;
- the expected exits;
- the probe's refusal of an `--out` that already holds captures;
- the comparison's verdicts.

The CLI runs themselves are measurements and stay out of the suite.

## Invariants

- No tree holds content from outside public IA. Synthetic trees start from `ia init` and generated text, and git trees come from this repository.
- The two sides of a comparison run on separate fresh copies of the same tree, so evidence one run writes never reaches the other.
- Normalisation removes or blanks only these:
  - the workspace root, made relative where it stands alone in a string, with the separators of the path after it turned to slashes;
  - every `observedAt`, `capturedAt` and `timings` field;
  - a `cache` object's `state` and `observations`;
  - capture's prior-state fields `prior`, `previous`, `rotated`, `changed` and `new`;
  - the values of `observed-at` and `captured-at` lines in text.

  Everything else in an output, its standard error and the files it writes is compared.
- The same size and seed give the same files and the same commit, whatever a machine's global git ignore file or template says.

## Limits

- Outputs are compared by digest. A difference names the tree and command; `capture.mjs --keep <dir>` writes the normalised outputs for a diff.
- Times and memory depend on the machine, so they are compared only between CLIs run on the same machine in one probe. The reference holds outputs alone.
- Every run starts from a cold copy. A second run over state an earlier run wrote is not exercised here: stored results belong to the equivalence tests of later milestones.
- Several public fixtures are refused before admission. They pin those refusals and no more, and `trees.json` says what each tree covers.
- `kb pack` runs only on trees with a commit, which the synthetic trees have.
- A fixture holding a symbolic link may not extract on Windows without the right to create links.
