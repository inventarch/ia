# 3.7.0 reference outputs

The outputs of `@inventarch/cli` 3.7.0 on the trees of [tools/scale-probe/trees.json](../../../../../tools/scale-probe/trees.json), captured once, so that a change meant to keep every output can be checked against a reference it cannot move. This is the m1 reference of the incremental-engine design (dec-018). From m3 on, the same build run with every store disabled takes its place.

Each `<tree>.json` is a capture in the `ia.scale-probe.capture.v1` format, without measurements: for each command, its exit code, the SHA-256 digest and size of its normalised output, a short summary, and the digests of the files it writes. The full outputs are not kept: the published 3.7.0 package rebuilds them, and `tools/scale-probe/capture.mjs --keep <dir>` writes them for a diff.

## Trees

- `synthetic-200` and `synthetic-2000`: a fresh 3.7.0 `ia init` workspace plus 200 or 2,000 generated work records (seed 1), committed with a fixed author and date so that `kb pack` has a commit.
- `ia-language-3.7.0`: this repository's own `.ia` at the `v3.7.0` tag.
- The rest: this repository's public test fixtures and examples at the commit `trees.json` names. Several are refused on purpose; a refusal is an output like any other.

## Rebuild and check

From the repository root, with 3.7.0 installed from npm into a folder of its own:

```sh
node tools/scale-probe/probe.mjs --init-cli <3.7.0>/dist/bin.js --cli 3.7.0=<3.7.0>/dist/bin.js --runs 2 --no-measure --out <dir>
node tools/scale-probe/compare.mjs packages/db/tests/fixtures/reference-3.7.0 <dir>/3.7.0 --outputs-only
```

To check another build, pass it as `--cli <label>=<build>/apps/cli/dist/bin.js`, keep `--init-cli` on 3.7.0, and compare against `<dir>/<label>`. See [tools/scale-probe/SPEC.md](../../../../../tools/scale-probe/SPEC.md).
