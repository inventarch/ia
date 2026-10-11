# @intent-shape

Defines a request framing and its retrieval defaults.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: intent-shape. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: intent-shape.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.
Section routing: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.
- routing.category: id; required.
- routing.primitive: id; required.
- routing.tie-precedence: number; required.
- routing.kind-focus: list of id; required.
- routing.lane-focus: list of id; required.
- routing.predicate-focus: list of id; required.
- routing.priming-order: list of id; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
