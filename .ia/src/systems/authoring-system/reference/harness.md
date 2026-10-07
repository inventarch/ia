# @harness

Composes profiles and execution bindings in a workspace under a host contract.

Owner: agent-composition-system. Identity: agent-composition-system/definition/<facet>/<name>. Facets: harness. Artifact set: execution. Primitive: Decision. Move: Execution.

Canonical schema: .ia/src/systems/agent-composition-system/schemas/harness.schema.ia.

Default file: harness.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section composition: required.
Section execution: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- composition.workspace: ref; required.
- composition.profiles: list of ref; required.
- composition.bindings: list of ref; required.
- execution.host-profile: id; required.
- execution.limit-steps: number; optional.
- execution.limit-model-calls: number; optional.
- execution.limit-operations: number; optional.
- execution.limit-tokens: number; optional.
- execution.limit-children: number; optional.
- execution.limit-depth: number; optional.
- execution.limit-bytes: number; optional.
- execution.limit-duration-ms: number; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
