# @principle

Declares a governing rationale in the shared governance shape.

Select when: Explain a governing rationale used to judge choices across cases.

Avoid when: Use @law for a severity-bearing rule or @convention for a customary practice.

Before authoring: State the tradeoff the rationale resolves and its scope so it can guide a decision without duplicating a rule.

Owner: governance-system. Identity: governance-system/governance/\<facet>/\<name>. Facets: principle. Artifact set: principle. Primitive: Inference. Move: Synthesis.

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
