# Troubleshooting

**Every IA refusal has a code and names one command to run next. Run that command first. This page explains the codes you are most likely to meet.**

`ia doctor` is the best first step when something seems wrong: it checks Node, the workspace, the installation and any registered hosts in one report.

Codes start with where the problem was found:

| Prefix | Found by |
| --- | --- |
| `IA-LANG-` | Reading the `.ia` text: syntax and word registration |
| `IA-GRAPH-` | Connecting records: identities and relationships |
| `IA-COMP-` | Checking records: schemas, systems, coverage and checks |
| `IA-RUNTIME-` | Positions, plans and mandates |
| `IA-CLI-` | The command line itself |
| `IA-DB-`, `IA-DIST-` | Reading the workspace, and installing distributions |
| `IA-HOOK-` | The edit guard |
| `IA-KB-` | Knowledge commands |

## Setting up

| Code | Because | Do |
| --- | --- | --- |
| `IA-DB-ROOT-INVALID` | No folder above this one has `.ia/src`, or `--root` names no folder | Run from inside a workspace, pass `--root`, or `ia init` one |
| `IA-CLI-CONFLICT` from `ia init` | The folder is already a workspace | Nothing to do; `ia position` shows it |
| `IA-DIST-PATH-UNSAFE` from `ia init` | The folder is, contains or is inside `~/.ia`. Your home folder counts, because it contains `~/.ia`. | Use a project folder, or set `IA_HOME` elsewhere |
| `IA-DB-SOURCE-UNAVAILABLE`, `restore-required` | A fresh clone has no installed distributions | `ia restore --apply --yes` |
| `IA-DB-SOURCE-UNAVAILABLE`, `lock-drift` | The lock changed, after a pull or because git converted its line endings | `ia restore --apply --yes`, and add `.ia/distributions.lock.json -text` to `.gitattributes` |
| `IA-DB-SOURCE-UNAVAILABLE`, `engine-incompatible` | A newer IA wrote the lock | Upgrade the CLI |
| `IA-CLI-USAGE` | A bad option, a missing argument, or `--apply` without `--yes` and no terminal | The message names the option; see `ia <command> --help` |

## Writing records

| Code | Because | Do |
| --- | --- | --- |
| `IA-LANG-PRAGMA-MISSING` | The file does not start with `#! ia 1.0` | Add it as the first line |
| `IA-LANG-INDENT-TAB`, `IA-LANG-INDENT-STEP` | A tab, or indentation that is not two spaces per level | Indent with two spaces; `ia format --write` fixes layout |
| `IA-LANG-DISCRIMINATOR-UNREGISTERED` | A word no system defines | Check the spelling; `ia vocabulary` lists the words |
| `IA-COMP-SECTION-MISSING`, `IA-COMP-FIELD-MISSING` | A required section or field is missing | `ia preview <word>` lists what is required |
| `IA-COMP-SECTION-UNKNOWN`, `IA-COMP-FIELD-UNKNOWN` | A section or field the word does not have, often a typo | Check against `ia preview <word>` |
| `IA-COMP-FIELD-VALUE` | A value outside the allowed set, such as `status done` | The message lists the allowed values |
| `IA-COMP-FIELD-TYPE` | The wrong kind of value, such as text where a reference belongs | Check the field's type with `ia preview <word>` |
| `IA-COMP-FIELD-REF-MISSING` (warning) | A reference field names a record that does not exist | Create the record or fix the name |
| `IA-GRAPH-TARGET-MISSING` (warning) | A relationship points at a record that does not exist | Create the record or fix the name |
| `IA-COMP-EDGE-UNRESOLVED` (warning) | A relationship the schema depends on points nowhere, so the record is held back | Create the target record |
| `IA-LANG-EDGE-UNCONSENTED`, `IA-GRAPH-EDGE-UNCONSENTED` | No system allows this relationship between these words | `ia preview <word>` lists the allowed links under Edges and Consent |
| `IA-COMP-EDGE-CARDINALITY` | Too many or too few relationships of one kind | The schema's Edges say how many |
| `IA-LANG-IDENTITY-COLLISION`, `IA-GRAPH-IDENTITY-TIE` | Two records with the same word and name | Rename one |
| `IA-GRAPH-DIMENSION-UNKNOWN` | A rule's `severity` is not `blocking`, `advisory` or `informational` | Use one of those |
| `IA-COMP-DISCRIMINATOR-FOREIGN` | A record in a system folder uses a word that system does not require | Move the record out of the folder, or add the system to `requires` |

## Checks

| Code | Because | Do |
| --- | --- | --- |
| `IA-COMP-NOT-EVALUATED` (warning) on `COMP-KERNEL` and `COMP-FIXTURES` | The language's self-tests did not run; every new workspace shows this | `ia validate --verify-conformance` |
| `IA-COMP-NOT-EVALUATED` on an adopted contract | `ia validate` supplies no evaluator for adopted requirements | Expected; see [Checks and evidence](checks-and-evidence.md#adopting-a-contract) |
| `IA-COMP-COVERAGE-MISSING` | A contract requirement has no case | Add a `@case` that `implements` it |
| `IA-COMP-COVERAGE-KIND` | A contract lacks a success case or a failure or refusal case | Add the missing kind |
| `IA-LANG-CONTRACT-UNBOUND` | A contract has no `governs` relationship | Add one |
| `IA-COMP-FRAGMENT-MISSING` | `#REQ-…` names a requirement the contract does not have | Fix the name |
| `IA-COMP-CHECK-UNKNOWN` | A check names an evaluator IA cannot run, or none. `ia host` and `ia project` refuse the workspace. | Use a [built-in evaluator](checks-and-evidence.md#built-in-evaluators), or record the result as an observation |
| `IA-COMP-CHECK-CONFLICT` | `check.runs` and `check.implementation` differ | Keep one |
| A check reports `not-evaluated` | Its `scope` selects nothing | Use `"*"`, or a scope the evaluator reports |

## Plans and evidence

| Code or symptom | Because | Do |
| --- | --- | --- |
| `IA-RUNTIME-NEXT-NO-PLAN` | No `@plan` in the workspace | Add one |
| `IA-RUNTIME-NEXT-AMBIGUOUS` | Several plans | `ia next --seat <plan identity>` |
| `IA-RUNTIME-NEXT-CYCLE` | Tasks require each other in a loop | Remove one `requires` |
| A task stays blocked by a made decision | The decision has no `decision.choice` | Fill in `choice`; `status made` alone does not unblock |
| A task is not done despite its observation | The observation's `subject-revision` is not the task's current digest, or its verdict is not `success` | Copy the digest from `ia next` again; editing the task changes it |
| `worked stale` | The task changed after its evidence was recorded | Record new evidence, or undo the change |

## Agents and authority

| Code | Because | Do |
| --- | --- | --- |
| `IA-RUNTIME-MANDATE-MOVE` | The acting participant's mandate does not grant this command's move | Run the `ia position` command it names to see the mandates |
| `IA-RUNTIME-MANDATE-WORD` | The mandate excludes this word | Have another participant write it |
| `IA-RUNTIME-MANDATE-ACTOR` | `--actor` names no participant, there are several and no steward, or no governing mandate binds the acting participant | Name an authored `@agent`, set a steward, or add a mandate for the participant |
| `IA-RUNTIME-REQUEST-INVALID` on every mandate-checked command | A mandate is broken, so everything governed by mandates is closed | `ia report` shows why; fix the mandate by hand |
| `IA-RUNTIME-REQUEST-INVALID` from `ia position` | A scope-key value is out of range, such as `--depth 5` | Run the corrected command it names |
| `IA-CLI-EDIT-STALE` | The file changed after `ia preview` | Preview again; use the new digest |
| `IA-CLI-EDIT-INVALID` | `ia preview` or `ia author` was given a field or value the word's schema does not allow | `ia preview <word>` lists the fields and values |
| `IA-CLI-EDIT-UNCLEAN` | The change would add an admission error | The preview shows it |
| `IA-CLI-EDIT-AUTHORITY` | `ia author` does not write this word | Edit by hand |
| `IA-CLI-EDIT-MANDATE` | A participant tried to change its own mandate | A person edits it by hand |
| `IA-HOOK-NOT-MANDATED` | The edit guard stopped an edit: no mandate grants Synthesis on that path | Act as a participant whose mandate allows it, or change the mandate |
| `IA-HOOK-IDENTITY-UNAVAILABLE` | The edit guard stopped a subagent that matches no `@agent-profile`, such as a built-in Claude Code subagent | Edit from the main session, or describe that subagent with an `@agent-profile` |
| `IA-HOOK-PROJECTION-MANAGED` | The edit guard protects a file IA generates | Change the records and rerun `ia project` |

## Hosts

| Code or symptom | Because | Do |
| --- | --- | --- |
| `IA-DIST-HOST-UNSUPPORTED` | That host is not supported yet, such as `cursor` | Use `claude` or `codex`, or run `ia-mcp-door` yourself |
| `IA-DIST-LOCAL-MODIFICATION` | A file IA would write already exists and IA did not write it, or you edited a generated file | Move your file aside, or undo the edit |
| `ia doctor` shows a projection `outdated` | Records changed since the files were generated | Rerun `ia project` or `ia host` with `--apply --yes` |
| `ia doctor` shows a registration stale | The Node binary it was registered with is gone | Rerun `ia host <host> --apply --yes` |
| The agent does not see IA | The packet was not generated, or the host was not restarted | `ia doctor`, then restart the agent |

## Knowledge

| Code | Because | Do |
| --- | --- | --- |
| `IA-KB-INVALID` | Malformed input, such as a bad selection file, or a pack selection that names only part of an `.ia` file | The message names the problem; select whole files when packing |
| `IA-KB-UNAVAILABLE` | The identity is not in the selected knowledge | `ia kb search` to find one that is |
| `IA-KB-RESPONSE-LIMIT` | The answer would exceed 48 KiB | Narrow the request, such as a lower `--limit` or `--steps` |
| `IA-KB-SNAPSHOT-UNAVAILABLE` | A citation's snapshot is no longer available | Read the identity again for a current citation |
| `IA-KB-SCOPE-STALE`, `IA-KB-SNAPSHOT-CHANGED` | Files changed while the command was reading them | Retry once the workspace stops changing |
| `IA-KB-SOURCE-UNAVAILABLE` | The repository or commit `ia kb pack` reads could not be read | `ia doctor`; check the commit exists |

## Distributions

| Code | Because | Do |
| --- | --- | --- |
| `IA-DIST-REGISTRY-UNMAPPED` | No registry or catalog for a provider | Map it in `.ia/registries.json`, or pass `--registry` or `--catalog` |
| `IA-DIST-INPUT-INVALID` | A `registries.json`, catalog or other input is malformed, such as a folder registry outside the workspace | The message names the file and entry |
| `IA-DIST-ARTIFACT-UNAVAILABLE` | A registry or archive could not be reached (exit 4) | Check the network or path |
| `IA-DIST-CONFLICT` | No set of versions satisfies every request, or a catalog lacks an archive | Widen a range, or add the archive |
| `IA-DIST-RELEASE-WITHDRAWN` | The locked version was withdrawn | `ia update` to another version, or `--allow-withdrawn` |
| `IA-DIST-LICENSE-REQUIRED` | A registry release needs a license | Install it from a local catalog |
| A command names `ia recover` | An install or host change was interrupted | Run it |
