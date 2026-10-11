# @inventarch/cli

The IA 1.2.0 command-line interface creates workspaces, validates, inspects, reads and captures native records, shows the position body for a scope key and a plan's delivery view, compiles artifacts, and manages native distributions and host registrations. It requires Node.js 22.22.0 or later within Node 22.

Install the [published package](https://www.npmjs.com/package/@inventarch/cli) globally with `npm install --global @inventarch/cli@1.2.0` to use `ia` across projects. For a project-local installation, run `npm install --save-dev --save-exact @inventarch/cli@1.2.0` in your JavaScript or TypeScript repository and use `npx ia` in place of `ia`. Either way, each initialized project keeps its own records in `.ia/`.

The [main quick start](https://github.com/inventarch/ia#-quick-start) walks through initialization, a first record, validation and VS Code setup. To run from a source checkout, run `pnpm install --frozen-lockfile` and `pnpm build`, then use `node /path/to/ia/apps/cli/dist/main.js` in place of `ia`.

```sh
ia --version
ia init demo --host none
ia init demo --host none --apply --yes
ia validate --root demo
ia capture --root demo
ia inspect --root demo
ia read agent-system/binding/agent/public-agent-system-steward --root demo
ia vocabulary plan --schema
```

`init` previews changes unless `--apply` is supplied. Its language base, `inventarch/language` 1.2.0, is bundled with the CLI, so creating a workspace needs no registry connection. Place authored `.ia` files in the generated `.ia/src/systems/demo/` directory. The starter system already requires the agent, work and workspace vocabularies, and its `@workspace` record composes the eleven public systems.

`ia capture` writes the admitted snapshot, with each record's digest and capture membership, to `.ia/work/snapshot/current.json` and keeps the most recent capture at another revision as `previous.json`; it reports how many records changed since the prior capture. It refuses, writing nothing, a directory whose `.ia/src` declares no `@workspace` and a floor, installed or adopted source that fails to parse; any other finding is written into the snapshot. `ia compile` still writes the 1.x `ia.compiled.v1` artifact, unchanged, and is deprecated in favour of `ia capture`: it prints one deprecation line on stderr, and in 2.0 it becomes an alias of `ia capture`.

`ia read <locator>` prints the body behind a locator with its SHA-256 and the line `body not certified by this read`: the text of one cell (`<identity>#<phase>/<Primitive>`) or one requirement (`<identity>#<REQ-ID>`); else the document a record's source locator names (`work.source` on a `@spec`, `@plan`, `@milestone`, `@task` or `@decision`, `reference.document`, `template.resource`), only the section under its heading when the locator carries a markdown anchor, and for an adopted record from the directory `.ia/workspace.json` binds its mount to; else the record's own `meaning.says`. `<path>:<line>` reads the record whose source spans that line. It writes nothing, and `ia inspect` keeps the record's structure.

`ia position [--seat <id|path>] [--shape <H>] [--phase <P>] [--depth <d>] [--budget <n>] [--word <w>]` prints the position body for a scope key: with no flag K0, the repository's workspace with its pointers and tallies only; otherwise the seat and the records loaded within the budget, the pointers past it (48 listed, the rest tallied), the rules and playbooks that apply by word with their playbook cells, the blocking rules reserved outside the budget, the mandates, the frontier and the unknowns. It prints the key used and the capture's freshness first, and the two widening keys last as `ia position` commands. `--word` restricts what loads, the pointers, their tallies and the frontier to one word, and never the reserved rules, the rules and playbooks that apply by word with their tallies and cells, or the mandates, so a word hides no blocking rule. With `--json` it prints `{version: 1, ok: true, body, digest, hostNote}`, what the runtime Door's `position` operation returns. A shape, phase, depth or budget outside its closed set or cap names the same call with the set or the cap in its place. It needs no capture and writes nothing, and `ia scope` stays the machine route.

`ia next [--seat <plan|milestone|task>]` prints one plan's delivery view, computed per read and never stored: the plan `--seat` belongs to, or without it the only `@plan` the workspace authors; its milestones; its tasks in prerequisite order, each with its verdict (`exit evidence recorded (…)`, `no declared blocker` or `blocked (…)`), a basis line per requirement, its `work.status` marked self-declared, which is never the verdict's basis, and five state lines; the review items; and the command for the next task with no declared blocker. Exit evidence is a success `@observation` on the task at its current digest. With `--json` it prints `{version: 1, ok: true, view}`, the view the runtime Door's `next` operation returns. A workspace `ia init` creates authors no plan, so there `ia next` names the records to author. It writes nothing.

Use `ia --help` or `ia <command> --help` for the complete command syntax. `--json` returns structured output; applying a plan noninteractively requires `--yes`. Every consumer command refusal names the one command to run next, in `next` with `--json` and on the `→` line otherwise; the nine machine operations keep their one-line JSON. A recovery names `ia-distribution`, the binary of `@inventarch/distribution`, which a global install of `@inventarch/cli` does not put on `PATH`. `ia doctor` reports observed state and suggested repairs. Host registration is explicit through `ia host claude`, `ia host codex` or `ia host cursor` and their `--apply` option.

See [the package contract](SPEC.md) for command behavior, [the packaged language summary](LANGUAGE.md) for the words this release ships, and the [language guide](https://github.com/inventarch/ia/blob/main/docs/reference/language/README.md) for native syntax and evaluation limits.
