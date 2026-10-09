# @authoring-guide

Associates a vocabulary owner and schema with an authoring reference and usage guidance.

Owner: authoring-system. Identity: authoring-system/definition/\<facet>/\<name>. Facets: authoring-guide. Artifact set: product-definition. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/systems/authoring-system/schemas/authoring-guide.schema.ia.

Default file: authoring-guide.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section reference: required.
Section guidance: required.
Section relationships: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- reference.owner: id; required.
- reference.word: id; required.
- reference.schema: ref; required.
- reference.document: text; required.
- reference.default-file: text; optional. — The file a new record of this word is authored in, relative to the workspace's authored root.
- guidance.select-when: text; required.
- guidance.avoid-when: text; required.
- guidance.consider: text; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
