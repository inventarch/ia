# @inventarch/cli

The IA 1.1.0 command-line interface creates workspaces, validates, inspects and captures native records, and manages native distributions and host registrations. It requires Node.js 22.22.0 or later within Node 22.

Install the [published package](https://www.npmjs.com/package/@inventarch/cli) globally with `npm install --global @inventarch/cli@1.1.0` to use `ia` across projects. For a project-local installation, run `npm install --save-dev --save-exact @inventarch/cli@1.1.0` in your JavaScript or TypeScript repository and use `npx ia` in place of `ia`. Either way, each initialized project keeps its own records in `.ia/`.

The [main quick start](https://github.com/inventarch/ia#-quick-start) walks through initialization, a first record, validation and VS Code setup. To run from a source checkout, run `pnpm install --frozen-lockfile` and `pnpm build`, then use `node /path/to/ia/apps/cli/dist/main.js` in place of `ia`.

```sh
ia --version
ia init demo --host none
ia init demo --host none --apply --yes
ia validate --root demo
ia capture --root demo
ia inspect --root demo
ia vocabulary plan --schema
```

`init` previews changes unless `--apply` is supplied. Its language base, `inventarch/language` 1.1.0, is bundled with the CLI, so creating a workspace needs no registry connection. Place authored `.ia` files in the generated `.ia/src/systems/demo/` directory. The starter system already requires the agent, work and workspace vocabularies, and its `@workspace` record composes the eleven public systems.

`ia capture` writes the admitted snapshot, with each record's digest and capture membership, to `.ia/work/snapshot/current.json` and keeps the most recent capture at another revision as `previous.json`; it reports how many records changed since the prior capture. `ia compile` is a deprecated alias of `ia capture`, kept for 2.x and removed in 3.0.

Use `ia --help` or `ia <command> --help` for the complete command syntax. `--json` returns structured output; applying a plan noninteractively requires `--yes`. Every consumer command refusal names the one command to run next, in `next` with `--json` and on the `→` line otherwise; the nine machine operations keep their one-line JSON. A recovery names `ia-distribution`, the binary of `@inventarch/distribution`, which a global install of `@inventarch/cli` does not put on `PATH`. `ia doctor` reports observed state and suggested repairs. Host registration is explicit through `ia host claude`, `ia host codex` or `ia host cursor` and their `--apply` option.

See [the package contract](SPEC.md) for command behavior, [the packaged language summary](LANGUAGE.md) for the words this release ships, and the [language guide](https://github.com/inventarch/ia/blob/main/docs/reference/language/README.md) for native syntax and evaluation limits.
