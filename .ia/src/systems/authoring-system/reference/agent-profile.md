# @agent-profile

Composes an agent, capabilities, optional mandate/voice/delegates and installed execution contracts.

Owner: agent-composition-system. Identity: agent-composition-system/binding/<facet>/<name>. Facets: agent-profile.

Canonical schema: .ia/src/systems/agent-composition-system/schemas/agent-profile.schema.ia.

Section meaning: required.
Section composition: required.
Section execution: required.
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


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
