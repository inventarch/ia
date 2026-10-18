# @dimension

Defines a supported record dimension used by conditions and lookup.

Select when: Define a record coordinate supported by conditions and lookup.

Avoid when: Use @axis for a closed selection axis or an ordinary field for data with no selector semantics.

Before authoring: Confirm that a consumer actually interprets the dimension; naming it alone does not implement a condition.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: dimension. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: dimension.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.
- data.values: list of id; required.
- data.path: text; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
