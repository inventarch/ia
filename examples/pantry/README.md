# Pantry

The finished records of the [walkthrough](../../docs/guide/walkthrough.md): Pantry, a small recipe app, adds a shopping-list export. Every file here appears in the guide.

| File | Holds | Explained in |
| --- | --- | --- |
| [records/shopping-list.ia](records/shopping-list.ia) | The spec, the made decision, the plan, its milestone and three tasks | [Walkthrough](../../docs/guide/walkthrough.md#2-write-down-what-you-want), [Planning work](../../docs/guide/planning-work.md) |
| [records/rules.ia](records/rules.ia) | A blocking law and an advisory convention that apply to tasks | [Walkthrough](../../docs/guide/walkthrough.md#6-set-the-rules), [Rules](../../docs/guide/rules.md) |
| [records/checks.ia](records/checks.ia) | A contract, its success and failure cases, and a check on the built-in `COMP-SCHEMA` evaluator | [Walkthrough](../../docs/guide/walkthrough.md#7-add-a-check), [Checks and evidence](../../docs/guide/checks-and-evidence.md) |
| [records/evidence.ia](records/evidence.ia) | The observation that makes `write-exporter` done | [Walkthrough](../../docs/guide/walkthrough.md#9-do-the-work-and-record-evidence) |
| [records/playbook.ia](records/playbook.ia) | A three-step playbook for small changes | [Rules](../../docs/guide/rules.md#playbooks) |
| [records/reviewer.ia](records/reviewer.ia) | A second participant whose mandate allows reading and checking only | [Agents and authority](../../docs/guide/agents-and-authority.md#an-example-a-read-only-reviewer) |
| [records/agents.ia](records/agents.ia) | A capability and an agent profile that Claude Code receives as a generated agent | [Connecting agents](../../docs/guide/connecting-agents.md#describing-agents-in-records) |
| [src/](src/) | The exporter and its test | [Walkthrough](../../docs/guide/walkthrough.md#9-do-the-work-and-record-evidence) |
| [kitchen/](kitchen/) | A separate system defining an `@allergen` word, and a record of it | [Your own vocabulary](../../docs/guide/your-own-vocabulary.md) |

## Try it

From an empty folder named `pantry`:

```sh
ia init . --id local/pantry --host none --apply --yes
cp path/to/examples/pantry/records/*.ia .ia/src/
ia validate
ia next
```

`ia validate` admits the workspace and the `records-conform` check passes. `ia next` shows `write-exporter` done, `add-export-button` ready and `document-export` blocked behind it.

The workspace must be named `pantry`: the contract governs `@workspace pantry` and the reviewer's mandate is scoped to it.

`records/evidence.ia` records the digest of `write-exporter` as written here. Change that task and its evidence stops counting, which the walkthrough shows on purpose.

The kitchen system belongs in its own workspace: run `ia init . --id local/kitchen --system --host none --apply --yes`, copy `kitchen/system.ia` and `kitchen/schemas/` into `.ia/src/systems/kitchen/`, and `kitchen/allergens.ia` into `.ia/src/`.

See the [examples contract](SPEC.md) for how this repository checks these files.
