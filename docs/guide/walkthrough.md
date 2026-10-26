# Walkthrough: one piece of work, start to finish

This walkthrough follows one small feature from an idea to a finished, evidenced task. Along the way you meet every part of IA that a typical project uses: records, the checker, plans, decisions, rules, checks, an agent's position and evidence.

It takes about 30 minutes. You need Node.js 22 (`>=22.22.0 <23`) and the `ia` command; [install it first](README.md#install-the-cli) if you have not. Every command below was run with IA 3.4.0. Outputs are shortened: `…` marks lines left out, and long paths are shown as `~/pantry`. The finished records are in [`examples/pantry`](../../examples/pantry/README.md).

> [!TIP]
> Read [How IA works](how-ia-works.md) first if you want the big picture before the details. This page shows the same picture in motion.

## The project

**Pantry** is a small recipe app. Its maintainer, Priya, wants a new feature: a cook picks some recipes and exports one shopping list with every ingredient they need.

Priya will do some of the work and hand some to a coding agent. Three things matter:

1. The requirement, the choices behind it and the plan should live next to the code, not in a chat history.
2. The agent should start from exactly what applies to its task: the requirement, the decision, the rules and what it is allowed to do.
3. "Done" should mean something specific that anyone can check, not just "the agent said so".

Each step below adds one piece and shows what IA does with it.

| Step | You add | IA gives you |
| --- | --- | --- |
| [1](#1-create-the-workspace) | A workspace | A checked home for records in `.ia/` |
| [2](#2-write-down-what-you-want) | A `@spec` | A requirement with an identity and status |
| [3](#3-record-the-open-question) | A `@decision` | An open question that blocks work until it is answered |
| [4](#4-plan-the-work) | A `@plan`, `@milestone` and `@task`s | `ia next`: what can start, and what is blocked by what |
| [5](#5-make-the-decision) | A choice, through `ia preview` and `ia author` | A safe, attributed edit, and unblocked work |
| [6](#6-set-the-rules) | A `@law` and a `@convention` | Rules that reach the agent working on a task |
| [7](#7-add-a-check) | A `@contract`, `@case`s and a `@check` | A pass or fail, with evidence written to disk |
| [8](#8-hand-a-task-to-an-agent) | A host projection | The agent's starting context, from `ia position` |
| [9](#9-do-the-work-and-record-evidence) | Code, a test and an `@observation` | A task that counts as done, and stops counting if it changes |

## 1. Create the workspace

Start in the project folder. Pantry is a git repository with a `README.md` and a `src/` folder:

```sh
cd ~/pantry
ia init . --id local/pantry --host none
```

`ia init` without `--apply` is a preview. It writes nothing and shows what it would do:

```text
Plan  init                                        ~/pantry

  This is a preview. Nothing has been written.

Would own
  +  .ia/src/                     authored records
  +  .ia/.gitignore               ignores work/ and distributions/; written
     once, only if absent
  +  .ia/release.json             the release descriptor, written once
  +  .ia/distributions.lock.json  direct requests and resolved versions
  +  .ia/distributions/           install state, store and generations
  +  .ia/work/snapshot/           the capture taken once the workspace is
     initialized
…
Starter
  •  Starter records  @workspace pantry composing 11 systems; its participant
     @agent pantry; @mandate pantry-mandate
…
→  Apply with "ia init . --id local/pantry --apply --yes".
```

Most commands that change files work this way: a plan first, then the same command with `--apply`. Apply it:

```sh
ia init . --id local/pantry --host none --apply --yes
```

```text
  ✔  Initialized local/pantry; release descriptor .ia/release.json.
     Installed generation db44220a04c0…, counter 1.

  ✔  Authored 3 records:
     workspace-system/definition/workspace/pantry
     agent-system/binding/agent/pantry
     agent-system/policy/mandate/pantry-mandate
     Wrote .ia/.gitignore, ignoring work/ and distributions/.

  ✔  Captured 174 records at revision 1a0a269f278a… to
     .ia/work/snapshot/current.json.
```

You now have:

```text
.ia/
├── .gitignore               # keeps work/ and distributions/ out of git
├── distributions.lock.json  # which language version this workspace uses
├── release.json             # this workspace's own name and version
├── src/
│   └── workspace.ia         # the three starter records
├── distributions/           # the installed language (rebuilt per clone; not committed)
└── work/                    # snapshots and evidence (rebuilt per clone; not committed)
```

Open `.ia/src/workspace.ia`. It holds three records:

- `@workspace pantry` says this repository is a workspace and lists the eleven **systems** whose words you can use. A system is a group of related words; `work-system`, for example, owns `@plan`, `@task` and `@decision`.
- `@agent pantry` is the **participant**: the coding agent that works here, whichever vendor it comes from.
- `@mandate pantry-mandate` says what that participant may do. The starter mandate allows everything: all five moves (Observation, Verification, Synthesis, Delegation and Execution) in this workspace. You can narrow it later; see [Agents and authority](agents-and-authority.md).

Check the new workspace:

```sh
ia validate
```

```text
  ✔  Admitted. 174 records, 0 errors, 2 warnings.
     Admission outcome: not-evaluated. No evaluator was supplied for 2 checks,
     so this run is not a pass.

Warnings
  ▲  (whole workspace)  COMP-FIXTURES
     IA-COMP-NOT-EVALUATED  matching-revision verification evidence was not
     supplied
  ▲  (whole workspace)  COMP-KERNEL
     IA-COMP-NOT-EVALUATED  matching-revision verification evidence was not
     supplied
```

**Admitted** with **0 errors** means every record is well formed and every reference resolves. The 174 records are mostly the language's own definitions, which `ia init` installed.

The two warnings are IA being honest. `COMP-KERNEL` and `COMP-FIXTURES` are self-tests of the language itself, and nobody ran them, so the result is `not-evaluated`. IA never counts something that did not run as a pass. Step 7 shows how to run them.

Commit `.ia/src/`, `.ia/release.json`, `.ia/distributions.lock.json` and `.ia/.gitignore`. A teammate who clones the repository runs `ia restore --apply --yes` to rebuild the ignored folders.

## 2. Write down what you want

A **record** is one `@word name` block in a `.ia` file. Records can live in any file under `.ia/src/`; the word decides what kind of record it is. Create `.ia/src/shopping-list.ia` and start with the requirement:

```ia
#! ia 1.0

@spec shopping-list-export
  meaning
    says "A cook can export the ingredients of the recipes they picked as one shopping list."
    answers "What must the shopping-list export do?"
  work
    title "Shopping-list export"
    status accepted
    owner "Priya"
```

Read it from the top:

- `#! ia 1.0` is required on the first line of every `.ia` file.
- `@spec` is the word. A spec is a requirement. The word decides which fields the record must and may have; this is its **schema**.
- `shopping-list-export` is the name. Other records point at this one as `@spec shopping-list-export`.
- `meaning` and `work` are **sections**; `says`, `title` and `status` are **fields**. Indent with two spaces.

Not sure which fields a word takes? Ask:

```sh
ia preview spec
```

```text
Word  spec                    work-system
…
Fields
  must meaning.says        text
  may meaning.answers      text
  must work.title          text
  must work.status         id in [draft, accepted, superseded, withdrawn]
  may work.owner           text
…
```

## 3. Record the open question

Priya has not yet chosen a file format for the list. That is a decision, and it is still open. Add it to the same file:

```ia
@decision list-format
  meaning
    says "Choose the file format of an exported shopping list."
  work
    title "Shopping-list file format"
    status open
    owner "Priya"
  decision
    question "Which file format does the export produce?"
    options ["Markdown checklist", "CSV", "PDF"]
```

`options` is a **list**: values in square brackets, separated by commas.

## 4. Plan the work

Add a plan, one milestone and three tasks:

```ia
@plan shopping-list
  meaning
    says "Ship the shopping-list export."
  work
    title "Shopping-list export"
    status open
    owner "Priya"

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

@task write-exporter
  meaning
    says "Write the function that merges the picked recipes' ingredients into one list."
  work
    title "Write the exporter"
    status open
    milestone @milestone export-ready
    expected-artifact "src/export.mjs"
  relationships
    grounded-by @decision list-format

@task add-export-button
  meaning
    says "Add an Export shopping list button to the recipe page."
  work
    title "Add the export button"
    status open
    milestone @milestone export-ready
  relationships
    requires @task write-exporter

@task document-export
  meaning
    says "Explain the export in the README."
  work
    title "Document the export"
    status open
    milestone @milestone export-ready
  relationships
    requires @task add-export-button
```

Records connect in two ways:

- A **field** can hold a reference, like `plan @plan shopping-list`.
- A **relationship** row in the `relationships` section links two records with a verb: `requires`, `grounded-by`, `supersedes` and so on. Here every task in the milestone waits for the format to be decided, the button needs the exporter, and the docs need the button.

Validate again. IA now checks 181 records, including your seven:

```sh
ia validate
```

```text
  ✔  Admitted. 181 records, 0 errors, 2 warnings.
```

Now ask what can start:

```sh
ia next
```

```text
Plan  work-system/definition/plan/shopping-list    revision 995815064d3c…

  •  0 of 3 tasks have exit evidence; every other task is blocked

Milestones
  ▲  work-system/definition/milestone/export-ready
     not satisfied: exit evidence missing for 3 of 3 tasks
     status open (self-declared)

Tasks
  ▲  work-system/definition/task/write-exporter
     blocked (decision work-system/definition/decision/list-format: no choice
     (via work-system/definition/milestone/export-ready))
     status open (self-declared)
     …
     definition admitted: db admission at digest
     2b3f89bec1dd33f5d44e6b1cb56678ecd7a20bc5288e3a27dee732e4a48f59c2
     …
  ▲  work-system/definition/task/add-export-button
     blocked (task work-system/definition/task/write-exporter: no exit evidence;
     decision work-system/definition/decision/list-format: no choice (via
     work-system/definition/milestone/export-ready))
…
```

Three things to notice:

- **Every record has a full identity.** `@task write-exporter` became `work-system/definition/task/write-exporter`: the owning system, a kind, the word and the name. You can always write the short `@task write-exporter` inside records.
- **Nothing can start.** Every task is blocked, and `ia next` says exactly why: the decision has no choice yet.
- **`status open (self-declared)`.** IA prints the status you wrote, but never uses it to decide whether a task is done. A task is done when it has **exit evidence**: a record saying it was checked. You will add that in step 9.

## 5. Make the decision

You can edit records by hand at any time. IA also has a safer path that agents use and you can too: `ia preview` shows an edit without making it, and `ia author` makes exactly that edit, only if the file has not changed in between.

Preview setting the choice:

```sh
ia preview --set "@decision list-format" "decision.choice=Markdown checklist"
```

```text
Preview  .ia/src/shopping-list.ia                 existing file

  ✔  Clean candidate: 0 errors, 0 warnings in what it changes.

  record    work-system/definition/decision/list-format
  sha256    1ea33aae5b62a8c3a05dcffcb2dba6206318d22de18045f6d41fe019dc2fb6ba
            the file as it is now; an absent file reads as empty
…
After
  @decision list-format
    …
    decision
      question "Which file format does the export produce?"
      options ["Markdown checklist", "CSV", "PDF"]
      choice "Markdown checklist"

→  Preview writes nothing.
```

Apply it with the same arguments plus the `sha256` the preview printed. If your file differs from this page by even one byte, for example because your editor saves Windows line endings, your digest will differ too:

```sh
ia author --set "@decision list-format" "decision.choice=Markdown checklist" \
  --digest 1ea33aae5b62a8c3a05dcffcb2dba6206318d22de18045f6d41fe019dc2fb6ba
```

```text
Authored  .ia/src/shopping-list.ia                existing file

  ✔  Wrote work-system/definition/decision/list-format, 0 warnings in what it
     changed.
…
Record
  # authored-by @agent pantry under @mandate pantry-mandate at 995815064d3c…
  @decision list-format
  …
```

`ia author` added one comment line naming the participant it acted as and that participant's mandate. Unless you pass `--actor`, that is the workspace's steward, `@agent pantry`, even when you run the command yourself. The comment is a plain record of the edit, not a signature: anyone can edit it, and the next `ia author` on this record replaces it. If the file had changed since the preview, `ia author` would have refused with `IA-CLI-EDIT-STALE` and written nothing.

Set `work.status` to `made` and add a `decision.rationale` the same way, one preview and one author per field:

```sh
ia preview --set "@decision list-format" "work.status=made"
ia author --set "@decision list-format" "work.status=made" --digest <sha256-from-that-preview>
ia preview --set "@decision list-format" "decision.rationale=Cooks tick items off on their phones, and Markdown renders as a checklist almost everywhere."
ia author --set "@decision list-format" "decision.rationale=Cooks tick items off on their phones, and Markdown renders as a checklist almost everywhere." --digest <sha256-from-that-preview>
```

The decision now reads:

```ia
# authored-by @agent pantry under @mandate pantry-mandate at 9887869d6626…
@decision list-format
  meaning
    says "Choose the file format of an exported shopping list."
  work
    title "Shopping-list file format"
    status made
    owner "Priya"
  decision
    question "Which file format does the export produce?"
    options ["Markdown checklist", "CSV", "PDF"]
    choice "Markdown checklist"
    rationale "Cooks tick items off on their phones, and Markdown renders as a checklist almost everywhere."
```

Run `ia next` again:

```text
  •  0 of 3 tasks have exit evidence; next:
     work-system/definition/task/write-exporter, with no declared blocker
…
→  Run
   "ia position --seat work-system/definition/task/write-exporter --shape sequence"
   for the position of work-system/definition/task/write-exporter, the next task
   with no declared blocker.
```

`write-exporter` can start. What unblocked it is `decision.choice`, not `status made`: IA follows the content, not the label. The last line names the command an agent would run to start that task; you will run it in step 8.

## 6. Set the rules

Pantry has one hard rule and one style preference. Create `.ia/src/rules.ia`:

```ia
#! ia 1.0

@law lists-stay-local
  meaning
    says "An exported shopping list is built on the cook's device and never sent to another service."
    answers "Where may a shopping list go?"
  governance
    severity blocking
  subject
    subject-word task
    covers ["src/export.mjs"]

@convention plain-ingredient-names
  meaning
    says "Write each item with the ingredient's name as the recipe spells it."
    answers "How is an item named on the list?"
  governance
    severity advisory
  subject
    subject-word task
```

A `@law` is a rule that must hold; a `@convention` is an agreed way of doing things. `severity` is `blocking`, `advisory` or `informational`. `subject-word task` says these rules apply to work on tasks.

To see what a rule does, look at the task the way an agent will. First refresh the workspace snapshot that IA keeps in `.ia/work/snapshot/`, then ask for the task's position:

```sh
ia capture
ia position --seat work-system/definition/task/write-exporter --shape sequence
```

```text
Position  work-system/definition/task/write-exporter    revision b100b4bdbc58…

  •  key  seat work-system/definition/task/write-exporter, shape sequence, phase
     plan, depth 1, budget 16
     freshness  current: the capture is at this authored revision
     digest  sha256 a611a8fd1da2…
…
Loaded
  •  work-system/definition/task/write-exporter
     @task of work-system, band 100, hop 0, the seat
  •  work-system/definition/task/add-export-button
     @task of work-system, band 100, hop 1, required-by row from
     work-system/definition/task/write-exporter, declared by source

Pointers
  •  work-system/definition/decision/list-format
     @decision of work-system, band 100, hop 0, grounded-by row from
     work-system/definition/task/write-exporter, declared by target
  •  work-system/definition/milestone/export-ready
…
Applies by word (field match, not a row)
  •  governance-system/governance/convention/plain-ingredient-names
…
Rules (reserved outside the budget)
  •  governance-system/governance/law/lists-stay-local
…
Mandates
  •  agent-system/policy/mandate/pantry-mandate
…
```

This is the agent's starting context for the task, called its **position**. It includes:

- the task and what depends on it;
- pointers to the decision and the milestone;
- the convention, because it applies to tasks;
- the law, in a section of its own. A blocking rule that applies to the task's word is always delivered, however small the budget an agent asks for;
- the mandate that says what the agent may do.

Each entry names the record, its word and owning system, and how it got there. `band 100` means you wrote it; records the language installed are band 90. `hop 0` is the seat itself or something attached to it directly, `hop 1` is one link away. *Loaded* records are inside the budget of 16; *pointers* are identities to read if needed. [Agents and authority](agents-and-authority.md#positions) explains every section and flag.

The same question always gets the same answer: the `digest` line identifies this exact context, so two agents asking it read the same thing.

> [!IMPORTANT]
> IA delivers the law to whoever works on the task. It does not inspect `src/export.mjs` to see whether the code obeys it. Checking code is the job of your tests and reviews; IA records their results (step 9).

The position reported `freshness current` because you captured first. The position itself never depends on the snapshot, but the snapshot is what IA compares against to tell what changed, and after an edit a position says `stale` and names `ia capture`.

## 7. Add a check

A **check** asks IA to evaluate a requirement itself and keep the result. The evaluators IA runs on its own are about records: schemas, references, coverage. Priya wants every Pantry record to stay well formed, with evidence of it. Create `.ia/src/checks.ia`:

```ia
#! ia 1.0

@contract pantry-records
  version "1.0.0"
  meaning
    says "What Pantry's own records must satisfy."
    answers "Which requirement do Pantry's records adopt?"
  outputs
    REQ-RECORDS-CONFORM "Every Pantry record conforms to its word's schema."
  relationships
    governs @workspace pantry

@case records-conform-case
  meaning
    says "A workspace whose records all match their schemas."
    answers "What does a passing run look like?"
  scenario
    kind success
    given "Every record in .ia/src uses only the fields its word's schema allows."
    request "Run ia validate."
    expected "The records-conform check passes."
    evaluator "COMP-SCHEMA"
  relationships
    implements @contract pantry-records#REQ-RECORDS-CONFORM

@case records-conform-failure
  meaning
    says "A workspace with a record that breaks its schema."
    answers "What does a failing run look like?"
  scenario
    kind failure
    given "A task in .ia/src has a work.status its schema does not allow."
    request "Run ia validate."
    expected "The records-conform check fails and ia validate refuses the workspace."
    evaluator "COMP-SCHEMA"
  relationships
    implements @contract pantry-records#REQ-RECORDS-CONFORM

@check records-conform
  meaning
    says "Every record in the workspace conforms to its schema."
    answers "Do the Pantry records conform?"
  check
    runs COMP-SCHEMA
    scope "*"
  relationships
    enforces @contract pantry-records#REQ-RECORDS-CONFORM
```

Four words work together here:

- The `@contract` states the requirement, `REQ-RECORDS-CONFORM`. `pantry-records#REQ-RECORDS-CONFORM` points at that one requirement inside the contract.
- The two `@case` records describe what passing and failing look like. IA insists on both, a success case and a failure case, for every requirement. Leave one out and validation refuses with `IA-COMP-COVERAGE-KIND`.
- The `@check` names an **evaluator**, `COMP-SCHEMA`, one of IA's built-in checks, and what to run it over: `"*"` means the whole workspace.

Validate:

```sh
ia validate
```

```text
  ✔  Admitted. 187 records, 0 errors, 2 warnings.
…
Checks
  ✔  compliance-system/check/gate/records-conform
     COMP-SCHEMA: bound, pass
     built-in COMP-SCHEMA: 187 selected verdicts, pass
  •  Recorded 1 observation in
     .ia/work/evidence/3b9ee4d70b488ad9163a95e5adacec309102acebfd863d1ad17d1dea53c0731e.ia.
```

The check passed, and IA wrote the result as an `@observation` record: what was checked, by which evaluator, at which revision, and what the result does not cover.

Now break something. Change `document-export`'s `status open` to `status done`, which is not one of the allowed values, and validate:

```text
  ✖  Refused. 186 records, 1 errors, 2 warnings.

Errors
  ✖  .ia/src/shopping-list.ia:71
     work-system/definition/task/document-export
     IA-COMP-FIELD-VALUE  'work.status' admits one of proposed, open, held,
     closed, dropped, superseded; found "done"
…
Checks
  ✖  compliance-system/check/gate/records-conform
     COMP-SCHEMA: bound, fail
…
  •  No evidence recorded: admission was refused, so nothing is recorded or
     pruned.

→  Fix the errors above and run "ia validate" again.
```

The error names the file, line, record, rule and the value it found. The check fails and no evidence is written. Put `status open` back.

Finally, run the language's self-tests behind the two warnings from step 1. They pass for this run; a plain `ia validate` reports them as not-evaluated again, so use the flag wherever you want them evaluated, such as in CI:

```sh
ia validate --verify-conformance
```

```text
  ✔  Admitted. 187 records, 0 errors, 0 warnings.

Conformance
  ✔  COMP-FIXTURES
     pass, verified
…
  ✔  COMP-KERNEL
     pass, verified
…
→  Every declared structural obligation is satisfied at this revision.
```

> [!WARNING]
> A `@check` can name an evaluator that is not built in, such as `runs npm-test`. In this release IA never runs such an evaluator: the check stays `not-evaluated`, `ia capture` records it as an `IA-COMP-CHECK-UNKNOWN` error, and `ia host` and `ia project` refuse the workspace until you remove it. Record results from your own tools as evidence instead, as in step 9. [Checks and evidence](checks-and-evidence.md) lists the built-in evaluators.

## 8. Hand a task to an agent

To work with IA, an agent needs two things: to know the workspace exists, and a way to ask it questions. Capture the records you added in step 7, then generate the files Claude Code reads:

```sh
ia capture
ia project claude --apply --yes
```

```text
Files
  +  .claude/rules/ia-workspace.md  sha256 f8709a2564c9…
  +  .claude/skills/ia-authoring/SKILL.md  sha256 fdbb68cc1797…

→  Run "ia doctor" for the observed projection state.
```

`.claude/rules/ia-workspace.md` is the **position packet**: a generated summary that Claude Code loads at startup. It lists the workspace, its participant and mandate, the systems and their words, the record counts and the `ia` commands with what each needs. It tells the agent to start every task with `ia position`. `ia host claude --apply --yes` writes the same files, installs IA's host programs under `~/.ia/hosts/`, and registers IA's read-only MCP server in `.mcp.json`, so the agent can ask questions without a shell. For Codex, use `codex` instead of `claude`.

> [!NOTE]
> These files are machine-local. The packet ends with a note about this clone's state, and the entries `ia host` registers point at your Node and your IA home. Do not commit them. Each person runs `ia project` or `ia host` in their own clone.

From here the agent works the way you have been working:

1. `ia next` names `write-exporter` as the next task and gives the command for its position.
2. `ia position --seat work-system/definition/task/write-exporter --shape sequence` returns what you saw in step 6: the task, the decision it rests on, the law and convention, and its mandate.
3. It looks closer where it needs to: `ia inspect <identity>` shows where a record lives and how it connects, and `ia read <identity>` prints its body (for most records, the `meaning.says` sentence; for a record with `work.source`, that document) with a digest.
4. It changes records through `ia preview` and `ia author`, and code with its normal tools.

The mandate decides which IA commands the agent may run. With the starter mandate it may run all of them. Remove `Synthesis` from `pantry-mandate`'s moves, and `ia author` refuses that agent with `IA-RUNTIME-MANDATE-MOVE`. This is a guard rail, not security: anyone who can edit `.ia/src/` can change the mandate. See [Agents and authority](agents-and-authority.md).

## 9. Do the work and record evidence

The agent writes the exporter, `src/export.mjs`:

```js
// Merge the ingredients of the picked recipes into one Markdown checklist.
export function shoppingList(recipes) {
  const items = new Map();
  for (const recipe of recipes)
    for (const { name, quantity } of recipe.ingredients) items.set(name, [...(items.get(name) ?? []), quantity]);
  return [...items].map(([name, quantities]) => `- [ ] ${name} (${quantities.join(' + ')})`).join('\n') + '\n';
}
```

It also writes a test, `src/export.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shoppingList } from './export.mjs';

test('merges repeated ingredients into one item', () => {
  const list = shoppingList([
    {
      ingredients: [
        { name: 'flour', quantity: '200 g' },
        { name: 'eggs', quantity: '2' },
      ],
    },
    { ingredients: [{ name: 'eggs', quantity: '3' }] },
  ]);
  assert.equal(list, '- [ ] flour (200 g)\n- [ ] eggs (2 + 3)\n');
});
```

and runs it, keeping the output:

```sh
mkdir -p test-results
node --test src/export.test.mjs > test-results/export.txt
```

The output file ends with:

```text
# tests 1
# suites 0
# pass 1
# fail 0
…
```

Saying "the test passed" in a chat is a claim. To make it evidence, record it as an `@observation` about the task. It must name:

- the task, as `subject`;
- the exact version of the task it is about, as `subject-revision`. This is the 64-character digest `ia next` prints on the task's `definition admitted` line, also available as `records[0].digest` from `ia inspect work-system/definition/task/write-exporter --json`: `2b3f89be…` here, and the same for you only if your task record matches this page byte for byte;
- the result, as `verdict success`;
- what it covers and what it does not, as `applies` and `limits`.

Create `.ia/src/evidence.ia`. Use your own task digest, your own timestamps, and as `digest` the sha256 of your own `test-results/export.txt` (`sha256sum test-results/export.txt`, or `Get-FileHash` in PowerShell). The test output includes timings, so its digest changes on every run; the values below are from ours:

```ia
#! ia 1.0

@observation write-exporter-tests-pass
  meaning
    says "The exporter's unit test passed after the exporter was written."
    answers "Is the write-exporter task finished?"
  evidence
    origin test
    actor "node --test"
    observed-at "2026-10-26T09:12:00Z"
    captured-at "2026-10-26T09:12:00Z"
    workspace "pantry"
    locator "work-system/definition/task/write-exporter"
    revision "2b3f89bec1dd33f5d44e6b1cb56678ecd7a20bc5288e3a27dee732e4a48f59c2"
    bundle "test-results/export.txt"
    digest "cae0526cbea5cfb44d6d1fdffe7bfdec2171b75814f2670e494bab187cc88d4d"
    availability available
    subject @task write-exporter
    subject-revision "2b3f89bec1dd33f5d44e6b1cb56678ecd7a20bc5288e3a27dee732e4a48f59c2"
    evaluator "node@22.22.2"
    move Verification
    verdict success
  interpretation
    applies "src/export.mjs as tested by src/export.test.mjs."
    limits "One unit test on one machine; the export button and the README are not covered."
    reason "The test feeds two recipes that share an ingredient and compares the exact list."
    basis evaluation
  retention
    status retained
```

`digest` is the `sha256` of the test output file, so anyone can tell whether `test-results/export.txt` is the file this record describes. IA does not rerun the test or recompute that digest. What it gives you is a claim that is specific, tied to one version of the task, and visible to everyone.

Validate, then ask what is next:

```sh
ia validate
ia next
```

```text
  •  1 of 3 tasks have exit evidence; next:
     work-system/definition/task/add-export-button, with no declared blocker
…
Tasks
  ✔  work-system/definition/task/write-exporter
     exit evidence recorded
     (learning-system/definition/observation/write-exporter-tests-pass,
     evaluator node@22.22.2)
     status open (self-declared)
     …
     worked observed success:
     learning-system/definition/observation/write-exporter-tests-pass: success
     at the current digest

  •  work-system/definition/task/add-export-button
     no declared blocker
…
```

`write-exporter` is done, and the button task is next. The task's own `status` still says `open`: IA counts the evidence, not the label.

Evidence is tied to the version of the task it describes. Edit the task, even just its title or its status, and the evidence stops counting:

```text
  •  work-system/definition/task/write-exporter
     no declared blocker
     …
     worked stale:
     learning-system/definition/observation/write-exporter-tests-pass: its
     subject-revision is the digest in the previous snapshot
```

If the task changed, the old evidence may no longer prove it. Record new evidence for the new version, or put the task back. If you want the status to read `closed`, change it before you copy the digest.

> [!NOTE]
> Who records the evidence matters. Here the agent that did the work also recorded its result. If a task names its agent in `work.owner-agent` and that same agent is the observation's `evaluator`, `ia next` marks the evidence as self-attributed. For stronger assurance, have someone else (a reviewer, or CI) record the observation.

## What you have now

| You wrote | IA established | IA did not establish |
| --- | --- | --- |
| A spec, a decision, a plan and three tasks | They are well formed and every reference resolves | That the spec is the right requirement |
| A made decision | The tasks it blocked can start, and which participant `ia author` acted as, under which mandate | That Markdown was the best choice, or who really typed the command |
| A law and a convention | They reach every agent working on a task | That the code obeys them |
| A contract, two cases and a check | All Pantry records conform to their schemas, with evidence on disk | Anything about the app's behavior |
| A test result as an observation | `write-exporter` has exit evidence for its current version | That the test was run as described, or is enough |

IA keeps these apart on purpose: declared, checked, executed and authorized are different things. [What a result means](what-results-mean.md) goes through each one.

## Where to go next

- **The concepts behind each step:** [Records](records.md), [Words and systems](words-and-systems.md), [Workspaces](workspaces.md), [Planning work](planning-work.md), [Rules](rules.md), [Checks and evidence](checks-and-evidence.md) and [Agents and authority](agents-and-authority.md).
- **Your own agent:** [Connecting agents](connecting-agents.md) covers Claude Code, Codex, the MCP server, edit guards and the VS Code extension.
- **Sharing:** [Distributions and kits](distributions-and-kits.md) explains how vocabulary and methods are packaged and installed. [Your own vocabulary](your-own-vocabulary.md) shows how to define new words.
- **When something refuses:** [Troubleshooting](troubleshooting.md).
