# @playbook

Represents a procedure as phase/primitive cells. Cell delivery is generic; the authored method belongs to its author.

Owner: governance-system. Identity: governance-system/definition/\<facet>/\<name>. Facets: procedure. Artifact set: principle. Primitive: Inference. Move: Synthesis.

Canonical schema: .ia/src/systems/governance-system/schemas/playbook.schema.ia.

Default file: playbook.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section cognition: required.
Section relationships: optional.
Section activation: optional.
Section subject: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- subject.subject-word: id; optional.
- subject.subject-kind: id in [governance, contract, definition, template, check, policy, binding]; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
