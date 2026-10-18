# @lane

Defines a retrieval lane associated with record kinds.

Select when: Define the retrieval channel associated with a record kind.

Avoid when: Use @placement for source authority; a lane does not assign source precedence.

Before authoring: Keep lane mappings consistent with lowering and delivery; the authority lane contains governance records and authority-facet contracts.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: lane. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: lane.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
