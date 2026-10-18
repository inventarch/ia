# @agent-profile

Composes an agent, capabilities, optional mandate/voice/delegates and installed execution contracts.

Select when: Compose a participant with capabilities and optional voice, mandate or delegates.

Avoid when: Use @agent for identity or @harness for workspace-level execution composition.

Before authoring: Resolve every selected capability and binding; composition does not establish that the host installed them.

Owner: agent-composition-system. Identity: agent-composition-system/binding/\<facet>/\<name>. Facets: agent-profile. Artifact set: execution. Primitive: Decision. Move: Execution.

Canonical schema: .ia/src/systems/agent-composition-system/schemas/agent-profile.schema.ia.

Default file: agent-profile.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section composition: required.
Section execution: required.
Section invocation: optional.
Section presentation: optional.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- composition.agent: ref; required.
- composition.capabilities: list of ref; required.
- composition.voice: ref; optional.
- composition.mandate: ref; optional.
- composition.delegates: list of ref; optional.
- execution.role: id; required.
- execution.outcomes: id; required.
- execution.mandate-contract: id; required.
- execution.model-profile: id; optional.
- execution.limit-steps: number; optional.
- execution.limit-model-calls: number; optional.
- execution.limit-operations: number; optional.
- execution.limit-tokens: number; optional.
- execution.limit-children: number; optional.
- execution.limit-depth: number; optional.
- execution.limit-bytes: number; optional.
- execution.limit-duration-ms: number; optional.
- invocation.mode: id in [model, user, delegated, none]; optional.
- invocation.use-when: text; optional. — When a host should hand work to this profile.
- invocation.avoid-when: text; optional. — Work this profile must not take.
- presentation.color: id; optional.
- execution.effort: id; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
