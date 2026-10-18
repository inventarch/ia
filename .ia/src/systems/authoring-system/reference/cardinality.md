# @cardinality

Defines relationship multiplicity constraints.

Select when: Define the multiplicity accepted for a relationship target.

Avoid when: Use a schema required marker for field presence; relationship multiplicity is a separate constraint.

Before authoring: Prefer may one for an optional single edge; preserve optional as a compatibility alias and test requiredness separately.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: cardinality. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: cardinality.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
