# @primitive

Defines a cognitive primitive coordinate; a cell is selected using its phase and primitive.

Select when: Name the cognitive operation paired with a phase to select a procedure cell.

Avoid when: Use @move for an action classification or @intent-shape for request framing.

Before authoring: Check cell coverage for explicit primitive selection and preserve intent-shape defaults when no override is given.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: primitive. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: primitive.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.
- data.anchor: id; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
