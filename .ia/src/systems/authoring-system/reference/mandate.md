# @mandate

States bounded authority and conditions for a participant. Host authorization remains independent. An authority section names the participant it binds, the closed moves it allows, the workspaces it scopes, the words it excludes and the paths it covers.

Owner: agent-system. Identity: agent-system/policy/<facet>/<name>. Facets: mandate. Artifact set: principle. Primitive: Escalation. Move: Delegation.

Canonical schema: .ia/src/systems/agent-system/schemas/mandate.schema.ia.

Default file: mandate.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section governance: required.
Section execution: optional.
Section authority: optional.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- execution.contract: id; optional.
- execution.limit-steps: number; optional.
- execution.limit-model-calls: number; optional.
- execution.limit-operations: number; optional.
- execution.limit-tokens: number; optional.
- execution.limit-children: number; optional.
- execution.limit-depth: number; optional.
- execution.limit-bytes: number; optional.
- execution.limit-duration-ms: number; optional.
- authority.participant: ref to agent; optional. — The agent this mandate binds.
- authority.moves: list of id in [Observation, Execution, Delegation, Synthesis, Verification]; optional.
- authority.scope: list of ref to workspace; optional. — The workspaces the mandate applies in.
- authority.excluded-words: list of id; optional. — Words the participant may not author under this mandate.
- authority.covers: list of text; optional. — Path selections the mandate claims, matched by the location resolver.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
