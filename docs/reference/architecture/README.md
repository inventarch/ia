# IA architecture and ownership

IA separates vocabulary declarations, the toolchain that reads them, and host implementations that execute work. A native record's owning system comes from its word registration. Its source folder determines capture and release membership. An npm package can carry native declarations, executable code, or both.

## Which package to use

| Package | Use it for | Public entrypoints |
| --- | --- | --- |
| `@inventarch/language` | Parse, scan, register, compile and format IA text; inspect identities and the language floor. | Root; `./editor` |
| `@inventarch/graph` | Resolve admitted identities and references; traverse relationships; inspect claims, conditions and record digests. | Root |
| `@inventarch/compliance` | Run structural checks; evaluate adopted contracts with supplied evaluators; qualify obligation and evidence receipts. | Root |
| `@inventarch/db` | Discover source trees; open scoped read handles; inspect admission, membership and retained snapshots. | Root; `./editor`, `./distribution`, `./descriptors` |
| `@inventarch/runtime` | Read records/documents, deliver position and work views, assemble host packets and expose the Door protocol. | Root; `./editor`, `./authoring`, `./authoring-execution`, `./entry` |
| `@inventarch/workspace-runtime` | Capture/adopt workspaces; resolve teaching resources, lifecycle context, templates and publication; bind operations and generate host artifacts. | Root; `./bind`, resource, authoring, lifecycle, source, template, projection and publication subpaths; generation is a toolchain implementation subpath |
| `@inventarch/service-contracts` | Validate service request/response shapes, including sources, tenancy, sessions, proposals, marketplace and installation. | Root; `./sources`, `./tenancy`, `./session-lifecycle`, `./source-apply`, `./marketplace`, `./installation` |

The main source dependency direction is `language → graph → compliance → db → runtime → workspace-runtime`: each package to the right consumes earlier mechanisms. Some packages also import earlier layers directly. `service-contracts` has a separate Zod-based, browser-safe boundary. Its schemas validate message shape; an application host supplies authentication, authorization, disclosure and native execution.

CLI, MCP and VS Code consume the same runtime/database mechanisms. The CLI plans and applies filesystem effects; the MCP door exposes scoped runtime calls; the editor uses the runtime editor surface. Distribution tooling qualifies archives and installed closures using database distribution contracts.

Use package entrypoints rather than `./internal/*` implementation subpaths. The latter are published for specific toolchain consumers and expose details that ordinary integrations do not need.

### Read a workspace

These imports are the public APIs that the CLI and runtime use:

```ts
import { open } from '@inventarch/db';
import { deliveryView, position } from '@inventarch/runtime';

const workspace = open(projectRoot, { cache: false, checks: 'structural' });
try {
  const scope = workspace.resolveScope();
  const context = position(workspace, scope.token, {
    seat: taskIdentity,
    shape: 'sequence',
  });
  const delivery = deliveryView(workspace, scope.token, planIdentity);
  // Inspect context.body and delivery; these reads do not execute the task.
} finally {
  workspace.close();
}
```

For syntax-only work, use `parse`, `scan` or `format` from `@inventarch/language`. For semantic admission, open a database handle or explicitly build the registry and compile the complete selected corpus. Parsing one file cannot establish cross-file reference resolution.

## Native systems and executable owners

| Native system | Owned words | Executable package behavior |
| --- | --- | --- |
| agent-system | agent, mandate | `Engine`, action validation and execution manifest handling |
| session-system | run | Journal store, replay/reducer, memory and SQLite backends |
| authoring-system | authoring-guide, operation | Validate and format drafts inside a disclosed workspace scope |
| agent-composition-system | voice, capability, agent-profile, harness, execution-binding | Compile a harness and execution manifest; bind installed captured-source reads |
| template-system | template | Validate and render scalar/structured templates |
| compliance-system | contract, check, case | Native declarations consumed by `@inventarch/compliance` |
| governance-system | law, principle, convention, playbook | Native declarations delivered and evaluated by selected consumers |
| hook-authoring-system | hook | Native event/tool/path declarations for a host adapter |
| learning-system | observation, improvement | Native evidence and proposed-learning declarations |
| work-system | plan, milestone, task, decision, spec | Native work declarations consumed by runtime delivery views |
| workspace-system | workspace, distribution | Native composition and release-root declarations |

The six packages described as native declarations export `./native.ia.tgz` and `./system-package.json`. The five executable owners export JavaScript APIs as well as qualified native payloads. Native dependency declarations and npm implementation dependencies are distinct graphs. Whole-system packing can add npm dependencies from native references, so source package manifests alone do not determine the final archive graph.

In generation-binding, `workspace-runtime` also owns generic generation and operation-binding joins. The CLI uses those joins for preview, author and generated host projection. Check implementations are joined from built-ins and the installed implementation catalogue; a binding receipt establishes compatibility, not that an operation or custom evaluator ran. The generic execution runner has a separate application boundary; these package APIs do not establish that a runner service has been deployed.

Importing `Engine` from `@inventarch/agent-system` or `compileHarness` from `@inventarch/agent-composition-system` exposes implementations. Execution still requires a host-supplied manifest, model/operation adapters, principal, authority and session store. A record naming an implementation never installs it or grants its effects.

## When to consult a steward

Every declared system names a local steward accountable for its vocabulary, canonical schemas, relationship consent and direct system dependencies. Reach the relevant system with:

```sh
ia position --seat floor/definition/system/work-system
```

Consult that steward when changing what a word means, its fields, registration, allowed relationships or vocabulary dependencies. A participant can author ordinary instances of adopted words—such as a release task or a decision—under the repository's work boundary. This does not require creating a new vocabulary owner or a new agent for every file. An example may assign a task to a steward, but that is an explicit task-owner choice; vocabulary stewardship does not make the steward the writer of every instance.

The returned steward identity is readable ownership metadata. It does not spawn an agent, authenticate the current writer or grant host permissions. Structural checks require a matching local steward and coverage of minted words. A host that enforces writer identity must bind and authenticate that identity separately.

## Hooks, laws and actual enforcement

A `@hook` declares an event, tools, paths and a message. Registration and execution require a host adapter. The generation-binding implementation derives agents, skills and hook definitions from admitted profiles and bindings. Claude receives supported agent profiles, skills and authored PreToolUse hook groups selecting Write, Edit or MultiEdit, with the mandate guard. Codex receives skills and the position packet; generated agents and hooks are reported unsupported. The legacy per-system steward guard is compatibility code and is retired when the current generated registration replaces it. Inspect the generated receipt and host registration before claiming a hook is active.

`@law`, `@principle`, `@convention` and `@playbook` records carry guidance. Position delivery can reserve blocking guidance and select procedure cells. Structural admission checks shapes and relationships; it does not establish that a rule's prose is true or that a filesystem action obeyed it. Machine enforcement requires a selected evaluator or host boundary with observable evidence. A contract requirement with no available evaluator remains `not-evaluated`.

This repository does not adopt an `.ia/governance.json` ledger. Its root records declare a release-selection law and an architecture contract, check and positive/refusal cases. `pnpm native:check` runs concrete repository lints that enforce their source-placement and release-selection requirements. `ia validate` binds built-in and installed-catalog evaluators, aggregates available built-in admission verdicts and records pass/fail evidence at the authored revision. Custom catalog entries remain not-evaluated without a host execution implementation. A successful coverage verdict establishes declared requirement coverage, not execution of these repository lints. For read-only inspection, use the structural read session rather than invoking validation. These repository checks do not register a host hook.

The CLI's mandate profile checks read/next, validate/preview, author, capture/compile/project and workspace host application against the acting participant's declared moves and path restrictions; position remains available to inspect a refusal. The generated mandate guard uses the same refusal model. Naming an actor is a local declaration; the host still owns authentication and filesystem permissions. Native restrictions never grant those permissions. The repository participant retains all five declared moves selected for generation-binding.

Release qualification uses the selected release configuration and qualification receipts. The repository release-work lint also refuses copied version/count literals in active release intent, including literals that happen to match today's selection. A fixed version in an old decision is historical evidence, not a standing choice for future releases. Keep historical decisions scoped to immutable release evidence and use current release inputs for prospective work.

## Source and release boundaries

The live `.ia/src/systems/<system>/` trees hold canonical vocabulary, schemas, teaching guidance and their implemented operation/binding contracts. Repository-specific maintenance work belongs under the workspace's authored root, outside those vocabulary trees. Its native identity is preserved when the file moves because registration owns the word.

Neutral examples live under `examples/public-language`, outside the live discovery tree. `publicLanguageInputs` selects them explicitly and maps them to stable native paths for conformance and teaching. Test fixtures materialize that selected corpus through `tools/native/public-fixture.ts`; tests do not need production example copies. Fixture-only release selectors stay under `examples/public-language/fixtures` and are separate from the public language-base selection.

`composition.sources` describes capture membership, while `composition.systems` names vocabulary owners. Only one repository workspace should declare the source roots used to select the default repository seat. Multiple source-declaring workspaces leave that default ambiguous. Composing systems does not automatically capture every record that uses their words.

A distribution selects native release roots. Packing expands selected system folders and resolves their dependencies; its selector is a release control, not a claim that every workspace instance should ship. Installed archive bytes and manifests carry the exact qualified closure. Keep repository work, examples and release controls outside vocabulary payloads so adopters receive language definitions rather than the repository's current tasks.

Package-set archives retain exactly one pinned root release-control source alongside their selected vocabulary payload. The source profile requires the corresponding distribution-engine capability; it does not change the npm cohort, native system or language syntax versions. Older native-folder archives remain supported. Installed metadata still needs workspace vocabulary, and shared teaching guides retain real cross-system dependencies; the package graph is not universally acyclic.

Released engine locks carrying the exact producer marker `0.1.0` are retained within the `0.1` compatibility line. Each archive is still checked against the actual reader capability; accepting a historical lock does not waive a newer archive's minimum engine requirement.

See the [language reference](../language/README.md), [public examples](../../../examples/public-language/README.md), [runtime contract](../../../packages/runtime/SPEC.md), [database contract](../../../packages/db/SPEC.md) and [npm release process](../../../tools/distribution/NPM-PUBLISHING.md) for their detailed contracts.
