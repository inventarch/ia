# @mandate

States bounded authority and conditions for a participant. Host authorization remains independent.

Owner: agent-system. Identity: agent-system/policy/<facet>/<name>. Facets: mandate.

Canonical schema: .ia/src/systems/agent-system/schemas/mandate.schema.ia.

Section meaning: required.
Section governance: required.
Section execution: optional.
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


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
