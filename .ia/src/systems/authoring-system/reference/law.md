# @law

Declares a rule with severity. Structural admission cannot establish the truth or suitability of its prose.

Owner: governance-system. Identity: governance-system/governance/<facet>/<name>. Facets: law. Artifact set: principle. Primitive: Inference. Move: Verification.

Canonical schema: .ia/src/systems/governance-system/schemas/law.schema.ia.

Section meaning: required.
Section governance: required.
Section relationships: optional.
Section subject: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- governance.severity: id; required.
- subject.subject-word: id; optional.
- subject.subject-kind: id in [governance, contract, definition, template, check, policy, binding]; optional.
- subject.covers: list of text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
