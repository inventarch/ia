# Words and systems

**A word is a kind of record, such as `@task` or `@law`. Each word has a schema that says what its records contain. Words are grouped into systems, and a system owns its words.**

IA ships 44 words. You will use about a dozen of them most days. This page shows them all, says which matter when, and shows how to look any of them up.

## Looking a word up

Three commands answer most questions:

```sh
ia vocabulary                  # every word, with one line about each
ia vocabulary task --schema    # one word's fields and relationships
ia preview task                # the same, as it applies in this workspace, plus where a new record would go
```

`ia preview <word>` also knows words you define yourself; `ia vocabulary` lists only the public ones. The [vocabulary catalogue](../reference/language/vocabulary.md) has every word's schema in one page.

## The words you write

These 28 words are owned by eleven **systems**. Each system covers one area:

| System | Words | Use them for |
| --- | --- | --- |
| `work-system` | `@spec`, `@decision`, `@plan`, `@milestone`, `@task` | Requirements, choices and the work to do. See [Planning work](planning-work.md). |
| `governance-system` | `@law`, `@principle`, `@convention`, `@playbook` | Rules and procedures. See [Rules](rules.md). |
| `compliance-system` | `@contract`, `@case`, `@check` | Requirements IA can evaluate. See [Checks and evidence](checks-and-evidence.md). |
| `learning-system` | `@observation`, `@improvement` | Evidence of what happened, and proposed changes. |
| `agent-system` | `@agent`, `@mandate` | Who acts, and what they may do. See [Agents and authority](agents-and-authority.md). |
| `agent-composition-system` | `@capability`, `@agent-profile`, `@harness`, `@execution-binding`, `@voice` | Describing agents: their abilities, roles, tone and the tools they connect to. See [Connecting agents](connecting-agents.md#describing-agents-in-records). |
| `hook-authoring-system` | `@hook` | An edit guard for an agent host. |
| `session-system` | `@run` | The identity and status of one run of an agent. |
| `template-system` | `@template` | A file layout with placeholders. |
| `authoring-system` | `@operation`, `@authoring-guide` | Operations with declared inputs and effects, and guides to authoring a word. |
| `workspace-system` | `@workspace`, `@distribution` | The workspace itself, and packages of records to share. See [Workspaces](workspaces.md) and [Distributions and kits](distributions-and-kits.md). |

A record's word decides its system. You do not say which system a record belongs to, and records from every system can sit side by side in one file.

### Which words to start with

| You want to | Start with |
| --- | --- |
| Write down a requirement | `@spec` |
| Record a question, then its answer | `@decision` |
| Plan work and see what can start | `@plan`, `@milestone`, `@task` |
| State a rule agents must follow | `@law` (must hold), `@convention` (agreed practice), `@principle` (a reason behind rules) |
| Write down how to do something | `@playbook` |
| Record a test result, a review or another finding | `@observation` |
| Limit what an agent may do with IA | `@mandate` |

The rest you add when you need them.

## The language's own words

The other 16 words define the language itself. `@system` and `@schema` define systems and words; you use them when you [define your own vocabulary](your-own-vocabulary.md). The remaining 14 are closed lists that IA's tools use to sort and select records. You never write records of them, but you meet their values in commands and output:

| Word | Its values | Where you meet it |
| --- | --- | --- |
| `@move` | Observation, Verification, Synthesis, Delegation, Execution | A mandate lists the moves an agent may make |
| `@intent-shape` | context, governance, execution, sequence, learning | `ia position --shape`: what kind of context an agent asks for |
| `@phase` | orient, plan, act, learn | `ia position --phase`: which stage of a task the agent is in |
| `@primitive` | Memory, Attention, Inference, Decision, Escalation, Learning | Playbook cells, and `ia position --primitive` |
| `@placement` | authored, adopted, open, floor, runtime | The **band** shown in output: where a record came from |
| `@kind` | definition, contract, governance, check, policy, binding, template | The second part of a record's identity |
| `@predicate` | require, ground, govern and 15 more | The verbs in a `relationships` section (see [Records](records.md#relationships)) |
| `@category`, `@lane`, `@artifact-set`, `@value-type`, `@cardinality`, `@axis`, `@dimension` | Closed lists | Schemas and the language reference |

## Schemas

Every word has one **schema**. It lists:

- the sections a record must have and may have;
- each field, its type and, for identifiers, the allowed values;
- the relationships the word may have, and how many.

Every public schema is **closed**: a field or section it does not list is refused with `IA-COMP-FIELD-UNKNOWN` or `IA-COMP-SECTION-UNKNOWN`. This is what lets IA catch a misspelled field instead of silently ignoring it.

Here is part of the `@task` schema, as `ia preview task` prints it:

```text
Fields
  must meaning.says           text
  may meaning.answers         text
  must work.title             text
  must work.status            id in [proposed, open, held, closed, dropped,
  superseded]
  must work.milestone         ref to milestone
  …
Edges
  may require task one-or-more
  may require milestone one-or-more
  may require decision one-or-more
  may supersede task one
```

Each system also says which relationships its words accept from other systems, under **Consent** in the same output. A relationship that neither side consents to is refused.

## Stewards

Each system names a **steward**: an `@agent` record accountable for that system's words and schemas. Positions and packets show it beside each record (`steward agent-system/binding/agent/public-work-system-steward`).

A steward is a pointer to who owns a word, so you know whose rules apply. It is not a program that runs, and naming it invokes nothing. When a question is about another system's word, an agent can ask for that system's position with `ia position --seat floor/definition/system/<system>`.

## Bands

Output often says `band 100` or `band 90`. A **band** says where a record came from, and the higher band wins when two sources define the same identity:

| Band | Placement | Records that |
| --- | --- | --- |
| 100 | authored | You wrote, under `.ia/src/` |
| 90 | adopted | Came from an installed distribution, including the language itself |
| 50 | open | Came from a workspace you adopted as source |
| 10 | floor | Define the language's own closed lists |
| 0 | runtime | IA wrote as it ran, such as evidence under `.ia/work/` |

Runtime records never change your workspace's authored revision, and positions never include them.

## Words that mean several things

A few terms are used in more than one way. Context tells them apart:

- **requires** is a relationship between records (`requires @task write-exporter`), a section of a `@system` listing the systems it depends on, and a field in a mandate's `governance` section.
- **kind** is the identity part above, and also a field in some words, such as a case's `scenario.kind`.
- **decision**, **contract** and **governance** are words, and also values in the closed lists above.
- **floor** is a folder, a band and the set of words that define the language.
