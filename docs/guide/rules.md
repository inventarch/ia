# Rules

**Four words write down how a project should work. A `@law` is a rule that must hold, a `@principle` is a reason behind rules, a `@convention` is an agreed practice, and a `@playbook` is a procedure. IA delivers each one to whoever works on a record it applies to.**

## The four words

| Word | Use it for | Example |
| --- | --- | --- |
| `@law` | Something that must hold | "A shopping list never leaves the cook's device." |
| `@principle` | A reason that guides decisions | "Prefer formats a cook can read without our app." |
| `@convention` | An agreed way of doing something | "Name each item as the recipe spells it." |
| `@playbook` | Steps to follow, by stage of the work | "Read the task first; change only the files it names; record the test result." |

Laws, principles and conventions share one shape:

```ia
@law lists-stay-local
  meaning
    says "An exported shopping list is built on the cook's device and never sent to another service."
    answers "Where may a shopping list go?"
  governance
    severity blocking
  subject
    subject-word task
    covers ["src/export.mjs"]
```

| Field | Required | Says |
| --- | --- | --- |
| `meaning.says` | yes | The rule, in one sentence |
| `meaning.answers` | yes | The question the rule answers |
| `governance.severity` | yes | `blocking`, `advisory` or `informational` |
| `subject.subject-word` | no | The word of the records it applies to, such as `task` or `decision` |
| `subject.subject-kind` | no | The kind of records it applies to, such as `definition` |
| `subject.covers` | no, and not on principles | File paths it is about |

The `governance` section also accepts free clauses for longer statements, such as `requires "Keep plans out of package folders."`.

## How rules reach the work

IA does not run rules against your code. It delivers them, so the person or agent working on a matching record cannot miss them. When an agent asks for a [position](agents-and-authority.md#positions), it gets:

- **Blocking rules, always.** A rule with `severity blocking` that applies to the seat goes into a section of its own, outside the budget. However small a context an agent asks for, it still gets the blocking rules.
- **Other rules that apply by word.** Rules whose `subject-word` matches the seat's word are listed under *Applies by word*.
- **Rules linked by a relationship.** A rule that `governs`, `constrains` or `forbids` the seat appears among its pointers, with the link that put it there.

In Pantry, both rules apply to every task:

```text
Applies by word (field match, not a row)
  •  governance-system/governance/convention/plain-ingredient-names
…
Rules (reserved outside the budget)
  •  governance-system/governance/law/lists-stay-local
```

To aim a rule at specific records rather than a whole word, link it:

```ia
@law lists-stay-local
  …
  relationships
    governs @task write-exporter
    governs @task add-export-button
```

`ia position --shape governance` asks specifically for the rules, boundaries and checks that bear on a record.

## Playbooks

A playbook is a procedure split into **cells**. Each cell is the text for one **phase** of the work (`orient`, `plan`, `act`, `learn`) and one **primitive**, the kind of thinking involved (`Memory`, `Attention`, `Inference`, `Decision`, `Escalation`, `Learning`):

```ia
@playbook small-change
  meaning
    says "How Pantry makes a small code change."
    answers "What steps does a small change follow?"
  cognition
    orient
      primary Attention
      Attention means "Read the task, the decision it rests on and every rule in the position before touching code."
    act
      primary Decision
      Decision means "Change only the files the task names; write or update a test for the behavior."
    learn
      primary Learning
      Learning means "Run the tests and record the result as an observation on the task."
  subject
    subject-word task
```

An agent receives the cell that matches where it is. The phase comes from `--phase`; the primitive comes from `--primitive`, or else from the shape it asked for:

| Shape | Primitive it selects | Phase it implies |
| --- | --- | --- |
| `context` | Attention | orient |
| `governance` | Inference | plan |
| `execution` | Decision | act |
| `sequence` | Inference | plan |
| `learning` | Learning | learn |

```sh
ia position --seat work-system/definition/task/write-exporter --shape execution --phase act
```

```text
Cells
  •  governance-system/definition/procedure/small-change#act/Decision
     Change only the files the task names; write or update a test for the
     behavior.
```

When no cell matches, the position says so (`no cell; no phase has a cell at Inference`) rather than guessing. `ia read governance-system/definition/procedure/small-change#learn/Learning` prints one cell. With Claude Code, `ia host` also turns each playbook into a skill; see [Connecting agents](connecting-agents.md).

IA ships no playbooks of its own. The method is yours: IA only stores it and delivers the right step at the right time.

## Making a rule checkable

A rule's prose is not checked. Admission confirms that a law is well formed, not that it is true or obeyed. To go further:

| To | Use |
| --- | --- |
| Check something about records, such as every requirement having a case | A `@check` with a built-in evaluator. See [Checks and evidence](checks-and-evidence.md). |
| Stop an agent editing certain files | A `@mandate` that covers those paths, and a `@hook` edit guard. See [Agents and authority](agents-and-authority.md#covered-paths-and-the-edit-guard). |
| Show that code obeys a rule | Your tests or reviews, recorded as an `@observation`. See the [walkthrough](walkthrough.md#9-do-the-work-and-record-evidence). |

A check can say which rule or requirement it stands for with `enforces`. That records the intent; it is not itself a passing result.

## Common mistakes

| You see | Because |
| --- | --- |
| `IA-GRAPH-DIMENSION-UNKNOWN` | `severity` is not `blocking`, `advisory` or `informational` |
| A rule missing from a position | Its `subject-word` does not match the seat's word, and nothing links it to the seat. Only blocking rules are reserved outside the budget |
| `no cell` under *Cells* | The playbook has no text at that phase and primitive. Ask with the matching `--phase` and `--primitive` |
