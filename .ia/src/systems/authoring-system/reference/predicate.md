# @predicate

Defines a directed relationship and its inverse spelling.

Select when: Define a directed relationship with its inverse spelling.

Avoid when: Use a schema field for scalar data; avoid a new predicate for an existing relationship spelling.

Before authoring: Specify direction, canonical spelling and inverse consistently; participating systems must consent to the edge.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: predicate. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: predicate.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.
- data.inverse: id; required.
- data.phrase: text; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
