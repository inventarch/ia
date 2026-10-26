# Glossary

**Every IA term in one sentence, with where to read more.**

| Term | Means | More |
| --- | --- | --- |
| **Actor** | The participant a command acts as: the workspace's steward, or whoever `--actor` names | [Agents and authority](agents-and-authority.md#which-participant-is-acting) |
| **Admission** | The check every record goes through on every `ia validate`: syntax, schema, references and relationships | [Checks and evidence](checks-and-evidence.md#admission) |
| **Admitted / Refused** | Whether a workspace passed admission | [What a result means](what-results-mean.md) |
| **Adoption** (of a contract) | A record adopting a contract's requirements with `requires @contract` | [Checks and evidence](checks-and-evidence.md#adopting-a-contract) |
| **Adoption** (of a workspace) | `ia adopt`: mounting another workspace's records as pinned source | [Distributions and kits](distributions-and-kits.md#adopting-a-workspace) |
| **Agent profile** | An `@agent-profile` record: one agent role with its capabilities, voice and mandate, which IA can generate into a host | [Connecting agents](connecting-agents.md#describing-agents-in-records) |
| **Attribution line** | The `# authored-by` comment `ia author` writes above a record | [Agents and authority](agents-and-authority.md#the-governed-write-path) |
| **Band** | A number saying where a record came from: 100 authored, 90 adopted, 50 open, 10 floor, 0 runtime. The higher band wins. | [Words and systems](words-and-systems.md#bands) |
| **Built-in evaluator** | One of the `COMP-*` checks IA runs itself, which a `@check` can name | [Checks and evidence](checks-and-evidence.md#built-in-evaluators) |
| **Capability** | A `@capability` record: something an agent can do, with the procedures it uses and its effects | [Connecting agents](connecting-agents.md#describing-agents-in-records) |
| **Capture** | `ia capture`: a snapshot of the admitted workspace in `.ia/work/snapshot/` | [Workspaces](workspaces.md#snapshots-and-ia-capture) |
| **Case** | A `@case` record describing a success, failure or refusal scenario for a requirement; a description, not a test run | [Checks and evidence](checks-and-evidence.md#cases) |
| **Catalog** | A local JSON list of archive files to install or restore from | [Distributions and kits](distributions-and-kits.md#from-a-local-catalog) |
| **Cell** | One step of a playbook, at one phase and primitive | [Rules](rules.md#playbooks) |
| **Check** | A `@check` record naming an evaluator and a scope for `ia validate` to evaluate | [Checks and evidence](checks-and-evidence.md#checks) |
| **Citation** | A pointer to exact text at one snapshot, returned by `ia kb`, that can be checked later | [Knowledge](knowledge.md#reading) |
| **Consent** | A system's rules about which relationships its words accept | [Words and systems](words-and-systems.md#schemas) |
| **Contract** | A `@contract` record naming requirements (`REQ-…`) | [Checks and evidence](checks-and-evidence.md#contracts) |
| **Coverage** | IA's rule that every requirement has a case, and every contract a success and a failure case | [Checks and evidence](checks-and-evidence.md#cases) |
| **Digest** | A sha256 fingerprint. A record's digest changes when the record changes; a file's when the file changes. | [Planning work](planning-work.md#when-a-task-is-done) |
| **Distribution** | A versioned, digest-named archive of records that workspaces install | [Distributions and kits](distributions-and-kits.md) |
| **Edit guard** | The hook IA registers in Claude Code to stop edits a mandate does not allow | [Connecting agents](connecting-agents.md#edit-guards) |
| **Evaluator** | Whatever produces a check's result. IA runs only its built-in ones. | [Checks and evidence](checks-and-evidence.md#built-in-evaluators) |
| **Evidence** | An `@observation` that records a result: a check, a test, a review | [Checks and evidence](checks-and-evidence.md#observations) |
| **Exit evidence** | A successful observation about a task at its current digest, which makes the task done | [Planning work](planning-work.md#when-a-task-is-done) |
| **Facet** | The third part of an identity, usually the word itself | [Records](records.md#identity) |
| **Field** | One `key value` line in a record | [Records](records.md#a-record) |
| **Floor** | The words that define the language itself, and their band | [Words and systems](words-and-systems.md#the-languages-own-words) |
| **Fragment** | The `#…` part of a reference that names one part of a record, such as `#REQ-ONE` | [Records](records.md#references) |
| **Freshness** | Whether the snapshot is at the current revision: `current` or `stale` | [Workspaces](workspaces.md#snapshots-and-ia-capture) |
| **Governed write path** | Changing records with `ia preview`, then `ia author --digest` | [Agents and authority](agents-and-authority.md#the-governed-write-path) |
| **Host** | The program running a coding agent, such as Claude Code or Codex | [Connecting agents](connecting-agents.md) |
| **Identity** | A record's full name: `system/kind/facet/name` | [Records](records.md#identity) |
| **IA home** | `~/.ia`, or `IA_HOME`: where IA keeps host programs and user settings; never a workspace | [Workspaces](workspaces.md#creating-a-workspace) |
| **Kind** | The second part of an identity: one of seven broad roles a word lowers to | [Words and systems](words-and-systems.md#the-languages-own-words) |
| **Kit** | A registry entry that installs several distributions together; also a workspace made from a plugin | [Distributions and kits](distributions-and-kits.md#kits) |
| **Law** | A `@law` record: a rule that must hold | [Rules](rules.md) |
| **Lock** | `.ia/distributions.lock.json`: the exact archives a workspace uses | [Distributions and kits](distributions-and-kits.md#what-a-workspace-pins) |
| **Mandate** | A `@mandate` record: the moves a participant may make, and where | [Agents and authority](agents-and-authority.md#mandates) |
| **MCP server** | `ia-mcp-door`: read-only access to a workspace for an agent, over MCP | [Connecting agents](connecting-agents.md#the-mcp-server) |
| **Move** | One of five kinds of action a mandate can allow: Observation, Verification, Synthesis, Delegation, Execution | [Agents and authority](agents-and-authority.md#moves) |
| **Not-evaluated** | A result meaning nothing ran that could decide. Never a pass. | [What a result means](what-results-mean.md) |
| **Observation** | An `@observation` record: evidence of a result, with what it covers and what it does not | [Checks and evidence](checks-and-evidence.md#observations) |
| **Participant** | An `@agent` that acts in a workspace | [Agents and authority](agents-and-authority.md#participants) |
| **Phase** | Where in a piece of work an agent is: orient, plan, act or learn | [Agents and authority](agents-and-authority.md#positions) |
| **Playbook** | A `@playbook` record: a procedure split into cells by phase and primitive | [Rules](rules.md#playbooks) |
| **Position** | The starting context for one piece of work, from `ia position` | [Agents and authority](agents-and-authority.md#positions) |
| **Position packet** | A generated summary of the workspace that an agent host loads at startup | [Connecting agents](connecting-agents.md#the-position-packet) |
| **Predicate** | The verb in a relationship, such as `requires` or `governs` | [Records](records.md#relationships) |
| **Primitive** | The kind of thinking a playbook cell is for: Memory, Attention, Inference, Decision, Escalation or Learning | [Rules](rules.md#playbooks) |
| **Projection** | The files `ia project` and `ia host` generate for a host | [Connecting agents](connecting-agents.md) |
| **Record** | One `@word name` block in a `.ia` file | [Records](records.md) |
| **Reference** | `@word name`: a typed pointer to another record | [Records](records.md#references) |
| **Registry** | A folder or HTTPS site that publishes distributions | [Distributions and kits](distributions-and-kits.md#from-a-registry) |
| **Relationship** | A row linking two records with a predicate, in a `relationships` section | [Records](records.md#relationships) |
| **Requirement** | A `REQ-…` clause of a contract | [Checks and evidence](checks-and-evidence.md#contracts) |
| **Revision** | A digest of all authored records, which changes whenever one changes | [Workspaces](workspaces.md#snapshots-and-ia-capture) |
| **Schema** | The rules for one word: which sections and fields its records must and may have | [Words and systems](words-and-systems.md#schemas) |
| **Scope key** | The flags that select a position: seat, shape, phase, primitive, depth, budget and word | [Agents and authority](agents-and-authority.md#positions) |
| **Seat** | The record or path a position, or `ia next`, centers on | [Agents and authority](agents-and-authority.md#positions) |
| **Section** | A named group of fields in a record, such as `meaning` | [Records](records.md#a-record) |
| **Self-declared** | A value IA shows but never relies on, such as a task's `work.status` | [Planning work](planning-work.md#what-satisfies-a-requirement) |
| **Severity** | How strongly a rule applies: blocking, advisory or informational | [Rules](rules.md) |
| **Shape** | The kind of context a position asks for: context, governance, execution, sequence or learning | [Agents and authority](agents-and-authority.md#positions) |
| **Snapshot** | `.ia/work/snapshot/current.json`: the admitted workspace at one revision | [Workspaces](workspaces.md#snapshots-and-ia-capture) |
| **Stale** | Evidence or a snapshot that describes an earlier version | [Planning work](planning-work.md#when-a-task-is-done) |
| **Steward** | The participant accountable for a system's words, or the workspace's default actor | [Words and systems](words-and-systems.md#stewards) |
| **System** | A group of related words, with their schemas and a steward | [Words and systems](words-and-systems.md) |
| **Verdict** | `ia next`'s judgement of a task: done, ready or blocked | [Planning work](planning-work.md#asking-what-is-next) |
| **Word** | A kind of record, such as `@task`. Also called a discriminator in the reference. | [Words and systems](words-and-systems.md) |
| **Workspace** | A repository IA manages, with its `.ia/` folder; also the `@workspace` record that describes it | [Workspaces](workspaces.md) |
