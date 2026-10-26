# Agents and authority

**An `@agent` record names a participant: a coding agent, or any other actor that uses IA. A `@mandate` says which kinds of action, called moves, that participant may take, and where. IA's commands check the mandate before they act. Agents start every task from a position, and change records through `ia preview` and `ia author`.**

> [!IMPORTANT]
> Mandates are cooperative guard rails, not security. They limit what IA's own commands, and optionally an edit guard, will do for a participant. They do not authenticate anyone or sandbox anything, and anyone who can edit `.ia/src/` can change them. Real permissions come from your agent host, your operating system and your repository settings.

## Participants

```ia
@agent pantry
  meaning
    says "The IDE agent operating in the pantry workspace, any vendor."
    answers "Which participant acts in the pantry workspace?"
  governance
    applies []
```

`ia init` creates one participant, named after the workspace, and makes it the workspace's **steward**: the participant that acts when no other is named. You can add more, such as a reviewer.

## Mandates

```ia
@mandate pantry-mandate
  meaning
    says "The bounded authority of the pantry participant in the pantry workspace."
    answers "Which moves may the pantry participant make, and in which workspace?"
  governance
    requires "Claim no host permission or execution from this mandate."
  authority
    participant @agent pantry
    moves [Observation, Verification, Synthesis, Delegation, Execution]
    scope [@workspace pantry]
```

| Field | Says |
| --- | --- |
| `authority.participant` | The `@agent` this mandate binds |
| `authority.moves` | The moves it may make (see below) |
| `authority.scope` | The workspaces where it applies |
| `authority.covers` | File paths where it applies, such as `[".ia/src/**"]` |
| `authority.excluded-words` | Words the participant may not write records of, such as `[law, mandate]` |
| `execution.limit-*` | Limits on steps, model calls, tokens, time and so on, applied by the [runner](connecting-agents.md#the-runner) only |

### Moves

There are five moves. Each IA command that a mandate governs needs one:

| Move | Means | Needed by |
| --- | --- | --- |
| **Observation** | Read without changing anything | `ia read`, `ia next`, `ia kb search`, `ia kb read`, `ia kb resolve`, `ia kb traverse` |
| **Verification** | Decide whether something holds | `ia validate`, `ia preview`, `ia kb check`, an `ia kb pack` preview |
| **Synthesis** | Produce something new from parts: write records | `ia author` |
| **Execution** | Change state outside the records | `ia capture`, `ia project`, `ia host … --apply`, `ia kb pack --apply` |
| **Delegation** | Hand work to another participant | No IA command needs it yet |

Some commands are never checked against mandates, so they always run:

- `ia position`. When a command refuses, it names a position to look at, and that position must always be reachable.
- `ia inspect`, `ia vocabulary`, `ia format`, `ia doctor` and `ia init`.
- The distribution commands: `ia pack`, `ia install`, `ia update`, `ia remove`, `ia restore`, `ia recover` and `ia adopt`.
- An `ia host` plan, `ia host --remove` and `ia host claude --user`.

### When a mandate applies

A mandate governs a command when its `scope` names the workspace, or its `covers` includes the path being changed. A mandate with neither governs wherever its participant acts. A participant with no mandate at all is not restricted, because mandates only take things away.

### Which participant is acting

Commands act as the workspace's steward unless you say otherwise. With one participant and no steward, they act as that one. Name another with `--actor`:

```sh
ia validate --actor reviewer
```

`--actor` takes `@agent reviewer`, `reviewer` or the full identity. An unknown participant, or several participants and no steward, refuses with `IA-RUNTIME-MANDATE-ACTOR`. `--actor` does not lift a restriction; it changes whose mandates are checked.

### An example: a read-only reviewer

Add a second participant that may read and check but never write:

```ia
@agent reviewer
  meaning
    says "A review agent that reads and checks, and never writes."
    answers "Which participant reviews Pantry's work?"
  governance
    applies []

@mandate reviewer-mandate
  meaning
    says "The reviewer may read and verify, nothing else."
    answers "What may the reviewer do?"
  governance
    requires "Claim no host permission or execution from this mandate."
  authority
    participant @agent reviewer
    moves [Observation, Verification]
    scope [@workspace pantry]
```

As the reviewer, `ia validate` and `ia next` work. `ia author` does not:

```text
✖  (whole workspace)
   agent-system/policy/mandate/reviewer-mandate
   IA-RUNTIME-MANDATE-MOVE  agent-system/policy/mandate/reviewer-mandate allows
   Observation, Verification; author needs Synthesis
   →  Run
      "ia position --seat agent-system/policy/mandate/reviewer-mandate --shape governance"
      for the mandates that govern here and what they allow.
```

Every refusal names one command to run next. Here it points at the mandates, so the agent can see why it was refused.

### When a mandate is broken

If a mandate fails admission, for example because `moves` is empty or a required field is missing, IA cannot tell what is allowed. It then **fails closed**: every command governed by mandates refuses with `IA-RUNTIME-REQUEST-INVALID`, for every participant, until the record is fixed. The refusal names `ia report`, which shows the admission findings, and `ia position` still works. Fix the mandate by hand.

### What an agent cannot do to its own authority

- `ia author` refuses to write `@workspace`, `@agent`, `@mandate`, `@system`, `@schema`, `@agent-profile` and `@hook` records, for anyone, with `IA-CLI-EDIT-AUTHORITY`. A person edits these by hand.
- A participant cannot even preview a change to a mandate that binds it: `IA-CLI-EDIT-MANDATE`.
- `excluded-words` stops a participant writing records of those words with `ia preview` and `ia author`: `IA-RUNTIME-MANDATE-WORD`.

These rules keep an agent from widening its own authority through IA. They do not stop it editing files directly. For that, see [the edit guard](#covered-paths-and-the-edit-guard).

### Covered paths and the edit guard

`authority.covers` limits a mandate to certain files. `ia preview` and `ia author` check a new record's target file against it.

To stop an agent editing those files with its ordinary tools, declare a `@hook` and register it with `ia host claude`. The hook runs before each matching edit in Claude Code, and refuses it unless the mandate governing the acting agent there grants Synthesis. It sees file-tool edits only, not shell commands, and only Claude Code supports it. See [Connecting agents](connecting-agents.md#edit-guards). `ia doctor` warns when a mandate restricts something but no hook protects `.ia/src/`.

## Positions

A **position** is the starting context for one piece of work: a short, ordered list of the records that bear on it, with the rules that apply and the mandates in force. It is computed from the records alone, so the same request always gives the same answer, with a digest that identifies it.

```sh
ia position                       # the workspace overview: pointers only
ia position --seat work-system/definition/task/write-exporter --shape sequence
```

You ask for a position with a **scope key**. There is no free-text question; every part of the key is a flag:

| Part | Flag | Values | Default |
| --- | --- | --- | --- |
| Seat | `--seat` | A record identity, or a path such as `./src/export.mjs` | The workspace |
| Shape | `--shape` | `context`, `governance`, `execution`, `sequence`, `learning` | `context` |
| Phase | `--phase` | `orient`, `plan`, `act`, `learn` | Set by the shape |
| Primitive | `--primitive` | `Memory`, `Attention`, `Inference`, `Decision`, `Escalation`, `Learning` | Set by the shape |
| Depth | `--depth` | `0` to `2`: how many links to follow | `1` |
| Budget | `--budget` | `0` to `64`: how many records to load in full | `16` |
| Word | `--word` | A word, to focus on records of that word | none |

With no flags at all, `ia position` returns the workspace at depth 0 and budget 0: pointers only.

The **shape** says what kind of context the agent needs:

| Shape | Asks for |
| --- | --- |
| `context` | Source records, evidence and prerequisites. The safe default. |
| `governance` | Rules, boundaries, prohibitions and checks |
| `execution` | Bindings, tools and inputs: how to carry the work out |
| `sequence` | Order, blockers and versions: what comes before and after |
| `learning` | Outputs, evidence and where things came from |

The **phase** says where in the work the agent is: `orient` (understand), `plan` (decide an approach), `act` (do it) or `learn` (compare the result with the intent). It selects which [playbook](rules.md#playbooks) step is delivered.

A position lists:

- **Loaded**: the seat and nearby records, up to the budget;
- **Pointers**: more records, by identity, to read if needed;
- **Applies by word**: rules and playbooks that apply to the seat's word;
- **Cells**: the playbook steps for this phase;
- **Rules**: blocking rules, always included, outside the budget;
- **Mandates**: the mandates that govern the actor here;
- **Frontier** and **Unknowns**: what lies beyond this view, and what IA could not decide;
- two commands to widen the view: one hop deeper, or re-seat at a pointer.

A position contains identities and summaries, not whole records. An agent reads more with `ia inspect <identity>` or the record's file.

`--word` focuses a position but never hides a blocking rule or a mandate. A value outside the allowed range refuses with exit `2` and names the corrected command. `--json` returns the body, its digest and a separate host note with the snapshot's freshness.

## The governed write path

Agents, and people who want a safety net, change records in two steps.

**1. Preview.** `ia preview` shows a change and writes nothing:

```sh
ia preview task                                        # the word's schema and where a new record goes
ia preview task review-export "meaning.says=Review the export." "work.title=Review the export" "work.status=open" "work.milestone=@milestone export-ready"
ia preview --set "@task add-export-button" "work.owner=Priya"
ia preview --set "@decision list-format" "decision.options+=JSON"
ia preview --relate "@task document-export" grounded-by "@decision list-format"
```

It prints the record before and after, any findings the change would add, and the target file's current `sha256`.

**2. Author.** `ia author` takes the same arguments plus `--digest <sha256>` from the preview:

```sh
ia author --set "@task add-export-button" "work.owner=Priya" --digest <sha256-from-the-preview>
```

It writes only if:

- the file still has that digest. If someone changed it in between, it refuses with `IA-CLI-EDIT-STALE` and writes nothing;
- the result has no new errors, or it refuses with `IA-CLI-EDIT-UNCLEAN`;
- the actor's mandates allow Synthesis there.

It adds one comment above the record, replacing any earlier one:

```ia
# authored-by @agent pantry under @mandate pantry-mandate at 9887869d6626…
@decision list-format
```

The comment records who wrote the record, under which mandate and from which revision. It does not change the record's digest.

You can always edit records by hand instead, then run `ia validate`. The governed path matters most for agents. It makes their edits visible before they happen, refuses edits based on a stale read, and leaves a trail.

## Common refusals

| Code | Because | Do |
| --- | --- | --- |
| `IA-RUNTIME-MANDATE-MOVE` | The actor's mandate does not grant the move this command needs | Run the position the refusal names, or act as another participant |
| `IA-RUNTIME-MANDATE-WORD` | The mandate excludes this word | Have a participant without that exclusion write it |
| `IA-RUNTIME-MANDATE-ACTOR` | `--actor` names an unknown participant, or several exist and none is the steward | Name an authored `@agent`, or set the workspace's `steward` |
| `IA-CLI-EDIT-STALE` | The file changed after the preview | Preview again and use the new digest |
| `IA-CLI-EDIT-UNCLEAN` | The change would add an error | Fix the arguments; the preview shows the error |
| `IA-CLI-EDIT-AUTHORITY` | `ia author` does not write this word | Edit the file by hand |
| `IA-CLI-EDIT-MANDATE` | A participant tried to change its own mandate | A person edits mandates by hand |
