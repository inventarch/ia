# IA language

IA is a language and toolchain for named records, typed relationships, agent composition, work plans and evidence. Version 1.0.0 includes a compiler, graph and database APIs, a CLI, an MCP server and editor integrations. Start with the [language guide](docs/reference/language/README.md), [43-word vocabulary](docs/reference/language/vocabulary.md) and [worked examples](examples/public-language/README.md).

## Try it from source

Use Node.js 22.22.0 or later within Node 22, and pnpm 10.33.0. From this checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/main.js --version
node apps/cli/dist/main.js init ../ia-demo --host none
node apps/cli/dist/main.js init ../ia-demo --host none --apply --yes
node apps/cli/dist/main.js validate --root ../ia-demo
node apps/cli/dist/main.js inspect --root ../ia-demo
node apps/cli/dist/main.js vocabulary plan --schema
```

The first `init` command previews the files and bundled language dependency. The second creates the workspace. A new target must have an existing parent directory. The bundled base makes initialization independent of a registry connection. Author records under the generated `.ia/src/systems/ia-demo/` directory; the starter directly requires the agent, work and workspace systems. The [work example](examples/public-language/records/work.ia) can be added to its `records/` directory and checked with `validate`.

For a published 1.0.0 release, the CLI package is `@inventarch/cli` (`npm install --global @inventarch/cli@1.0.0`); use `ia` in place of `node apps/cli/dist/main.js`. Registry publication is separate from building this checkout.

## Commands and integrations

`ia --help` lists workspace commands (`init`, `validate`, `compile`, `format`, `inspect`, `vocabulary`) and distribution commands (`pack`, `install`, `update`, `remove`, `restore`, `doctor`, `host`). `ia <command> --help` describes its options. `ia doctor` reports observed runtime, workspace and installation state; an unavailable update check remains unknown. Commands that preview changes require `--apply` to perform them, and `--yes` when applying without a terminal. `compile` writes its output directly and `format --write` rewrites source formatting.

The CLI also exposes the machine operations `scope`, `context`, `select`, `get`, `records`, `resolve`, `search`, `traverse` and `report` through `--params`. See the [CLI contract](apps/cli/SPEC.md), [MCP server](apps/mcp-door/SPEC.md) and [VS Code extension](apps/vscode/README.md). Host registration is explicit: preview `ia host claude`, `ia host codex` or `ia host cursor` from your workspace, then apply the selected registration.

Native declarations describe structure and intent. Model execution, evidence evaluation and external effects require explicitly supplied consumers and host authority. Passing schema validation does not establish that a declared test ran or that its evidence is true.

## Contributing and qualification

`pnpm platform:qualify` runs the repository's tests, build, type checks, lint, formatting, native validation, documentation checks and emitted public-resource checks. Focused checks include `pnpm native:check`, `pnpm public-language:check` and `pnpm docs:audit`. Review [the repository contract](SPEC.md) and the nearest package `SPEC.md` before changing behavior.

The native kernel lives in [`.ia/src/floor`](.ia/src/floor/README.md); public systems own their schemas under `.ia/src/systems/`. Edit the corresponding source and run its generator when changing the vocabulary, authoring resources or host projections. The `*:check` commands refuse generated output drift.

IA is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
