# Examples

The repository's [`examples/`](../../examples/) folder holds four sets of files. Two are for you to read and copy; two also serve the repository itself.

| Folder | What it is | Who it is for |
| --- | --- | --- |
| [pantry](../../examples/pantry/README.md) | The finished records of the [walkthrough](walkthrough.md): a spec, a decision, a plan with tasks, rules, a check, evidence, a playbook, a second participant, an agent profile and a small vocabulary of its own | **Start here.** Copy it into a workspace and run it |
| [knowledge](../../examples/knowledge/README.md) | One record bound to one Markdown document, with a selection file, for trying [`ia kb`](knowledge.md) | People trying knowledge search and packaging |
| [public-language](../../examples/public-language/README.md) | Small records showing the public words at work: [work](../../examples/public-language/records/work.ia), [quality](../../examples/public-language/records/quality.ia), [architecture](../../examples/public-language/records/architecture.ia), [evidence](../../examples/public-language/records/evidence.ia) and [agent composition](../../examples/public-language/records/composition.ia) | People looking for one example per area |
| [conformance](../../examples/conformance/SPEC.md) | Test fixtures: a copy of the language and two sample workspaces that the repository's package tests read | This repository's tests, not people. Do not copy from here |

## Two folders do more than teach

**`public-language`** is also a build input. Its `manifest.json`, `contracts/` and `versions.json` are what the build turns into the `inventarch/language` archive that the CLI bundles and `ia init` installs in every workspace. Only the files under `records/` are examples. The [public-language README](../../examples/public-language/README.md#how-this-repository-checks-them) explains how the two parts are checked.

**`conformance`** is test input only. Package tests in `apps/`, `packages/` and `.ia/src/systems/` read its files by path. Its records exercise edge cases, not good practice.

Each folder has a `SPEC.md` that says how this repository checks it.
