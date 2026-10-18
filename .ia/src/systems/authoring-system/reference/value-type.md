# @value-type

Defines the field types that schemas may require.

Select when: Define a field value type available to canonical schemas.

Avoid when: Use @schema for a particular word contract or @cardinality for relationship multiplicity.

Before authoring: Keep parsing, schema validation and author-facing type rendering aligned before adding a type.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: value-type. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: value-type.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
