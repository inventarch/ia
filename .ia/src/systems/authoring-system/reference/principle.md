# @principle

Declares a governing rationale in the shared governance shape.

Owner: governance-system. Identity: governance-system/governance/<facet>/<name>. Facets: principle. Artifact set: principle. Primitive: Inference. Move: Synthesis.

Canonical schema: .ia/src/systems/governance-system/schemas/principle.schema.ia.

Default file: principle.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section governance: required.
Section relationships: optional.
Section subject: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- governance.severity: id; required.
- subject.subject-word: id; optional.
- subject.subject-kind: id in [governance, contract, definition, template, check, policy, binding]; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
