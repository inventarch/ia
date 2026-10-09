# @capability

Groups operations, procedures, templates, checks and included capabilities with declared execution bounds.

Owner: agent-composition-system. Identity: agent-composition-system/definition/<facet>/<name>. Facets: capability. Artifact set: product-definition. Primitive: Inference. Move: Synthesis.

Canonical schema: .ia/src/systems/agent-composition-system/schemas/capability.schema.ia.

Default file: capability.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section composition: optional.
Section execution: required.
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


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
