# 3.7.0 reference outputs

The outputs of `@inventarch/cli` 3.7.0 on the trees of [tools/scale-probe/trees.json](../../../../../tools/scale-probe/trees.json), captured once, so that a change meant to keep every output can be checked against a reference it cannot move. This is the m1 reference of the incremental-engine design (dec-018). From m3 on, the same build run with every store disabled takes its place.

Each `<tree>.json` is a capture in the `ia.scale-probe.capture.v1` format, without measurements. For each command it records:
- its exit code;
- the SHA-256 digest and size of its normalised standard output, and the digest of its standard error;
- a short summary;
- the digest of every file it added, changed or removed.

The full outputs are not kept. The published 3.7.0 package rebuilds them, and `tools/scale-probe/capture.mjs --keep <dir>` writes them for a diff. The digests are the same on Windows and Linux.

## Trees

- **`synthetic-200` and `synthetic-2000`:** a fresh 3.7.0 `ia init` workspace plus 200 or 2,000 generated work records (seed 1). They are committed with a fixed author and date, so that `kb pack` has a commit. Every command is admitted on both.
- **`ia-language-3.7.0` and `ia-language-f766ff05`:** this repository's own `.ia` at the `v3.7.0` tag and at a later commit. Both are admitted, and `validate` writes evidence.
- **The rest:** this repository's public test fixtures and examples at the commit `trees.json` names. Most are refused, several before admission. They pin those refusals and no more. `trees.json` says what each one covers and which exit each command gives.

## Rebuild and check

From the repository root, with 3.7.0 installed from npm into a folder of its own:

```sh
node tools/scale-probe/probe.mjs --init-cli <3.7.0>/dist/bin.js --cli 3.7.0=<3.7.0>/dist/bin.js --runs 2 --no-measure --out <dir>
node tools/scale-probe/compare.mjs packages/db/tests/fixtures/reference-3.7.0 <dir>/3.7.0 --outputs-only
```

To check another build, pass it as `--cli <label>=<build>/apps/cli/dist/bin.js`, keep `--init-cli` on 3.7.0, and compare against `<dir>/<label>`. See [tools/scale-probe/SPEC.md](../../../../../tools/scale-probe/SPEC.md).
