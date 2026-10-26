# What a result means

**IA keeps four things apart: what was declared, what was checked, what was executed and what was authorized. A result answers one of these questions and never stands in for another.**

Read each result for exactly what it establishes.

| Question | What answers it | What does not |
| --- | --- | --- |
| Are the records well formed, and do their references resolve? | `ia validate` reports **Admitted** with **0 errors**, and no check names an evaluator that is not built in | A workspace with such a check, which `ia validate` admits with a warning but `ia capture`, `ia host` and `ia project` count as an error |
| Are the records true, complete and wise? | Nothing in IA. People and reviews decide that. | Admission. A well-formed spec can still be the wrong spec. |
| Did a requirement pass? | A `@check` with a built-in evaluator reporting **pass**, and the evidence written under `.ia/work/evidence/` | A `@case`, which describes a scenario but runs nothing. A check that reports **not-evaluated**. |
| Was a task done? | `ia next` reporting **exit evidence recorded**: a successful `@observation` about that version of the task | The task's `work.status`, which IA prints as self-declared and never relies on |
| Did a test or review really happen as described? | The raw evidence the observation points to (`evidence.bundle` and its `digest`), checked by someone | The observation alone. IA checks its shape, not its truth. |
| Is an implementation installed? | `ia validate` reporting an `@execution-binding` as bound, against the installed catalog | Naming an implementation in a record, which installs nothing |
| Is an edit guard active? | `ia doctor` reporting the host registration | A `@hook` record, which is a declaration until `ia host` registers it |
| May this agent run this IA command? | Its `@mandate` allowing the command's move | |
| May this agent do this at all? | Your host's permissions, your operating system and your repository settings | A mandate. It narrows what IA's own commands and edit guard allow, and anyone who can edit `.ia/src/` can change it. |
| Is the design good? | Your own methods, reviews and evaluators | IA. Conformance is not a design review. |

## The words IA uses

**Admitted / Refused.** Whether the workspace passed admission. Refused means at least one error; IA names each one.

**pass / fail / not-evaluated.** The outcome of a check. **Not-evaluated** means nothing was run that could decide, because no evaluator was supplied or the scope selected nothing. It is never a pass and never a fail, and IA never rounds it up.

**bound / unavailable / revoked.** Whether a check's evaluator, or an execution binding's implementation, is available. Bound means available to use, not that anything ran.

**self-declared.** A value that someone wrote and IA displays but does not rely on, such as a task's status.

**stale.** Evidence or a snapshot that describes an earlier version than the current one.

## Reporting what ran

When you, or an agent, report on work done in an IA workspace, name each check that ran and the environment it ran in. Say "`ia validate` admitted the workspace with 0 errors; `node --test` passed 1 test on Node 22.22.2", not "everything passes". A declared case is not an executed test, and a not-evaluated check is not a pass.
