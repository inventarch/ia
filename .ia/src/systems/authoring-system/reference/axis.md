# @axis

Defines a closed coordinate axis for selection.

Select when: Define a closed coordinate axis used to select context.

Avoid when: Use @dimension for a supported record attribute or @intent-shape for retrieval defaults.

Before authoring: Keep axis values and the actor or runtime that supplies them consistent with the position protocol.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: axis. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: axis.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.
- data.values: list of id; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
