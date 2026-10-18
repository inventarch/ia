# @capability

Groups operations, procedures, templates, checks and included capabilities with declared execution bounds.

Select when: Group related operations, procedures, templates and checks under declared execution bounds.

Avoid when: Use @operation for one executable contract or @agent-profile to select capabilities for a participant.

Before authoring: Resolve included capabilities and their limits; test effect and authority bounds at the execution boundary.

Owner: agent-composition-system. Identity: agent-composition-system/definition/\<facet>/\<name>. Facets: capability. Artifact set: product-definition. Primitive: Inference. Move: Synthesis.

Canonical schema: .ia/src/systems/agent-composition-system/schemas/capability.schema.ia.

Default file: capability.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section composition: optional.
Section execution: required.
Section invocation: optional.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- composition.operations: list of ref; optional.
- composition.playbooks: list of ref; optional.
- composition.templates: list of ref; optional.
- composition.checks: list of ref; optional.
- composition.includes: list of ref; optional.
- execution.input: id; optional.
- execution.outcomes: id; optional.
- execution.context-profile: id; optional.
- execution.procedure-profile: id; optional.
- execution.mapping-profile: id; optional.
- execution.effects: list of id; required.
- execution.limit-steps: number; optional.
- execution.limit-model-calls: number; optional.
- execution.limit-operations: number; optional.
- execution.limit-tokens: number; optional.
- execution.limit-children: number; optional.
- execution.limit-depth: number; optional.
- execution.limit-bytes: number; optional.
- execution.limit-duration-ms: number; optional.
- invocation.mode: id in [model, user, delegated, none]; optional.
- invocation.use-when: text; optional. — When a host should offer this capability, in the user's words.
- invocation.triggers: list of text; optional. — Phrases that should select this capability.
- invocation.avoid-when: text; optional. — Nearby requests this capability must not take.
- invocation.argument-hint: text; optional. — The argument shape a user-invoked entry point shows.
- invocation.paths: list of text; optional. — Path selections that make this capability relevant.
- invocation.agent: ref; optional. — The agent a delegated invocation runs as.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
