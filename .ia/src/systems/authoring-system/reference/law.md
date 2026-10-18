# @law

Declares a rule with severity. Structural admission cannot establish the truth or suitability of its prose.

Select when: State a rule whose violations have a declared severity.

Avoid when: Use @principle for governing rationale or @convention for an agreed practice.

Before authoring: Connect the rule to intended subjects with operative relationships or path scope and verify delivery from their seats.

Owner: governance-system. Identity: governance-system/governance/\<facet>/\<name>. Facets: law. Artifact set: principle. Primitive: Inference. Move: Verification.

Canonical schema: .ia/src/systems/governance-system/schemas/law.schema.ia.

Default file: law.ia, relative to the workspace's authored root (the sources row at placement authored).

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
