# @ia/cli

The IA 1.0.0 command-line interface creates workspaces, validates and inspects native records, compiles artifacts, and manages native distributions and host registrations. It requires Node.js 22.22.0 or later within Node 22.

After the package is published, install it with `npm install --global @ia/cli@1.0.0`. To run from a source checkout, run `pnpm install --frozen-lockfile` and `pnpm build`, then use `node apps/cli/dist/main.js` in place of `ia`.

```sh
ia --version
ia init demo --host none
ia init demo --host none --apply --yes
ia validate --root demo
ia inspect --root demo
ia vocabulary plan --schema
```

`init` previews changes unless `--apply` is supplied. Its language base is bundled with the CLI, so creating a workspace needs no registry connection. Place authored `.ia` files in the generated `.ia/src/systems/demo/` directory. The starter already requires the agent, work and workspace vocabularies.

Use `ia --help` or `ia <command> --help` for the complete command syntax. `--json` returns structured output; applying a plan noninteractively requires `--yes`. `ia doctor` reports observed state and suggested repairs. Host registration is explicit through `ia host claude`, `ia host codex` or `ia host cursor` and their `--apply` option.

See [the package contract](SPEC.md) for command behavior and the [language guide](https://github.com/inventarch/ia/blob/main/docs/reference/language/README.md) for native syntax and evaluation limits.
