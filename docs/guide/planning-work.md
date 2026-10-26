# Planning work

**Five words describe work: `@spec` for what is required, `@decision` for what was chosen, and `@plan`, `@milestone` and `@task` for what to do. `ia next` reads them and says, for each task, whether it is done, ready or blocked, and why.**

The [walkthrough](walkthrough.md#4-plan-the-work) builds a small plan step by step. This page explains the rules behind it.

## The five words

| Word | Is | Required fields | Status values |
| --- | --- | --- | --- |
| `@spec` | A requirement or specification | `meaning.says`, `work.title`, `work.status` | `draft`, `accepted`, `superseded`, `withdrawn` |
| `@decision` | A question, and once made, its answer | the above, plus `decision.question` | `open`, `made`, `superseded`, `withdrawn` |
| `@plan` | A body of work toward one outcome | `meaning.says`, `work.title`, `work.status` | `proposed`, `open`, `held`, `closed`, `dropped`, `superseded` |
| `@milestone` | An outcome inside one plan, with an exit condition | the above, plus `work.plan` and `work.exit` | as for plans |
| `@task` | One action toward one milestone | the above, plus `work.milestone` | as for plans |

All five may also have `work.owner`, `work.start`, `work.due` and `work.ended` (dates as `"2026-11-01"`) and `work.source`, a pointer to a document.

The structure is fixed: a task belongs to exactly one milestone, a milestone to exactly one plan, and plans do not nest.

### Specs

```ia
@spec shopping-list-export
  meaning
    says "A cook can export the ingredients of the recipes they picked as one shopping list."
  work
    title "Shopping-list export"
    status accepted
    source "docs/specs/shopping-list.md"
```

`work.source` points at a longer document if there is one, and [`ia kb`](knowledge.md) can read and search it. A spec can be `grounded-by` the decision it follows from. A new spec can replace an old one with `supersedes @spec <old>`; if it replaces only part of it, say which part in `work.replaced-scope`. `work.covers` lists paths the spec applies to.

### Decisions

```ia
@decision list-format
  meaning
    says "Choose the file format of an exported shopping list."
  work
    title "Shopping-list file format"
    status made
  decision
    question "Which file format does the export produce?"
    options ["Markdown checklist", "CSV", "PDF"]
    decider "Priya"
    choice "Markdown checklist"
    rationale "Cooks tick items off on their phones."
```

Record a decision as soon as the question exists, with `status open` and no `choice`. Work that needs it shows as blocked until it is answered. Fill in `choice` and `rationale` when it is made, and optionally `constraints`, the conditions the choice must respect, and `effective-revision`, the workspace revision from which it applies.

### Plans, milestones and tasks

```ia
@milestone export-ready
  meaning
    says "A cook can export a shopping list from the recipe page."
  work
    title "Export ready"
    status open
    plan @plan shopping-list
    exit "Every task in the milestone has exit evidence."
  relationships
    requires @decision list-format

@task add-export-button
  meaning
    says "Add an Export shopping list button to the recipe page."
  work
    title "Add the export button"
    status open
    milestone @milestone export-ready
    action "Add the button and wire it to shoppingList()."
    expected-artifact "src/recipe-page.mjs"
  relationships
    requires @task write-exporter
```

A task may also name `work.owner-agent`, the `@agent` that owns it, and `work.exit-evidence`, the observation that proves it done (see [below](#when-a-task-is-done)).

## Dependencies

Tasks and milestones declare what they wait for with `requires`:

| From | May require |
| --- | --- |
| `@task` | another task, a milestone or a decision |
| `@milestone` | another milestone, a task or a decision |

A task inherits its milestone's requirements, so a decision the milestone requires blocks every task in it. A cycle of requirements is refused with `IA-RUNTIME-NEXT-CYCLE`.

`grounded-by @decision <name>` says a task, milestone, plan or spec rests on a decision. It does not block anything; `ia next` uses it to say why the work exists.

## Asking what is next

```sh
ia next
```

With one plan in the workspace, `ia next` reads it. With several, name one: `ia next --seat work-system/definition/plan/<name>`. A milestone or task identity works too.

The output lists milestones, then tasks in an order that puts prerequisites first. Each task gets one verdict:

| Mark | Verdict | Means |
| --- | --- | --- |
| ✔ | `exit evidence recorded` | The task is done: a successful observation covers its current version |
| • | `no declared blocker` | Everything it requires is satisfied; it can start |
| ▲ | `blocked (…)` | Something it requires is not satisfied; the reasons follow in brackets |

The summary line names the next task that can start, and the output ends with the `ia position` command an agent should run for it.

### What satisfies a requirement

| Required record | Satisfied when |
| --- | --- |
| A task | It has exit evidence |
| A milestone | It has its own successful observation, or every one of its tasks has exit evidence |
| A decision | `decision.choice` is filled in |

`work.status` plays no part, on anything. `ia next` prints it as `status open (self-declared)` so you can see it, but a decision marked `made` with no `choice` still blocks, and a task marked `closed` without evidence is still not done. Statuses are for people; IA follows the content.

### The state lines

Under each task, five lines explain where it stands:

| Line | Says |
| --- | --- |
| `intent` | Whether a decision grounds the task with both a `choice` and an `effective-revision` |
| `definition` | Whether the task record is admitted, and its current digest |
| `realizable` / `realized` | Not applicable to tasks; kept for consistency with other records |
| `worked` | Whether an observation names the task: `observed success`, `stale`, `unobserved` and so on |

The `definition` line is where you find the task's digest when you record evidence.

### Review items

At the end, `ia next` lists anything that needs a person's attention: two decisions grounding the same record, two accepted specs where one supersedes the other without saying what it replaced, or a work record that failed admission.

## When a task is done

A task is done when an `@observation` exists that:

1. names the task, either as its `evidence.subject` or because the task names it in `work.exit-evidence`;
2. has `evidence.verdict success`;
3. has `evidence.subject-revision` equal to the task's current digest.

The third rule is what makes evidence trustworthy over time. The digest is a fingerprint of the task record. Change the task, even its title or status, and the digest changes. Old evidence then shows as `worked stale` and the task is no longer done. Either record new evidence for the new version, or make all your edits to the task before you record its evidence.

To find the digest, run `ia next` and copy the 64 characters after `definition admitted: db admission at digest`. Adding other records never changes it. The [walkthrough](walkthrough.md#9-do-the-work-and-record-evidence) shows a complete observation. [Checks and evidence](checks-and-evidence.md#observations) explains every field.

Two more rules:

- **Who recorded it.** If the task names an agent in `work.owner-agent` and the observation's `evidence.evaluator` is that same agent, `ia next` marks the evidence as self-attributed. Someone checking their own work is weaker evidence than a reviewer or CI checking it.
- **Check evidence is separate.** `ia validate` writes observations for passing checks under `.ia/work/evidence/`. Those are about the check, not a task, and `ia next` does not read them. Exit evidence for a task is always an observation you or an agent writes into `.ia/src/`.

## Refusals

| Code | Because | Do |
| --- | --- | --- |
| `IA-RUNTIME-NEXT-NO-PLAN` | No `@plan` in `.ia/src/`, or the seat belongs to none | Add a plan; `ia preview plan` shows its fields |
| `IA-RUNTIME-NEXT-AMBIGUOUS` | Several plans and no `--seat` | Add `--seat` with the plan you mean; the refusal names one |
| `IA-RUNTIME-NEXT-SEAT` | The seat is not an admitted plan, milestone or task | Check the identity with `ia inspect` |
| `IA-RUNTIME-NEXT-CYCLE` | Requirements form a loop | Remove one `requires` row |

`ia next` needs the Observation move. With a mandate that does not grant it, it refuses with `IA-RUNTIME-MANDATE-MOVE`.
