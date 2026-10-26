# Upgrading

**Upgrade the CLI with npm, then check the workspace with `ia doctor` and `ia validate`. Within one major version that is all. Moving from 2.x to 3.x, or from 1.x, takes the steps below.**

The [changelog](../../CHANGELOG.md) lists every change, release by release.

## Within 3.x

```sh
npm install --global @inventarch/cli@latest    # or update the pinned devDependency
ia --version
ia doctor
ia validate
```

If the team pins the CLI in `package.json`, update it in one commit so everyone moves together: a restore takes the language from the CLI, so mixed versions can disagree about the lock.

What each 3.x minor added:

| Release | Added |
| --- | --- |
| 3.4 | `ia validate --verify-conformance`, which runs the language's self-tests so a new workspace validates to a pass |
| 3.3 | `ia kb` and the five `ia_kb_*` MCP tools for [knowledge](knowledge.md); `--primitive` on `ia position` |
| 3.2 | Host session stores can check admission before each durable write; registry and archive downloads accept only credential-free HTTPS |
| 3.1 | Turning a Claude Code, Codex or Grok plugin into a workspace (`ia init --from`) and back (`ia project --product plugin`) |
| 3.0 | The governed write path (`ia preview`, `ia author`), commands checked against mandates, check bindings and evidence, generated host agents, skills and edit guards, registry kits, `ia adopt` and the runner |

## From 2.x to 3.x

3.0 changed how commands are authorized and how the installation is recorded. Before upgrading, commit or back up `.ia/`.

- **`ia compile` is gone.** Use `ia capture`.
- **Commands check mandates.** `ia read`, `next`, `validate`, `preview`, `author`, `capture`, `project` and a workspace `ia host --apply` refuse when the acting participant's mandate does not grant the move they need. A mandate that fails admission, including one with `authority.moves []`, closes all of them until it is fixed. See [Agents and authority](agents-and-authority.md#moves).
- **`ia validate` writes evidence** under `.ia/work/evidence/`, so a CI job needs a writable `.ia/work/`.
- **The lock moves to a new format.** The first `ia init`, `ia install` or `ia update` you apply with 3.x rewrites the workspace lock for a distribution engine that 2.x cannot read. After that, everyone on the team needs 3.x.

Read the [3.0.0 changelog entry](../../CHANGELOG.md#300) for the full list.

## From 1.0 or 1.1

Workspaces created by IA 1.0 or 1.1 use an older layout. Move them with `ia init --migrate`, previewing first:

```sh
ia init . --migrate
ia init . --migrate --apply --yes
```

The migration keeps the workspace's identity and every record's identity. It records its progress in `.ia/migration.json`, so an interrupted run can resume.

## If something goes wrong

| You see | Do |
| --- | --- |
| `IA-DB-SOURCE-UNAVAILABLE` with `engine-incompatible` | The lock was written by a newer IA. Upgrade the CLI; there is no in-place downgrade. |
| `IA-DB-SOURCE-UNAVAILABLE` with `restore-required` or `lock-drift` | Run `ia restore --apply --yes` |
| An install was interrupted | Commands name `ia recover`; run it |
| Generated host files are `outdated` in `ia doctor` | Run `ia host <host> --apply --yes` or `ia project <host> --apply --yes` again |

[Troubleshooting](troubleshooting.md) covers more refusals.
