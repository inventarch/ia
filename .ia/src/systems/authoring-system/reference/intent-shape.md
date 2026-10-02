# @intent-shape

Defines a request framing and its retrieval defaults.

Owner: taxonomy. Identity: taxonomy/definition/<facet>/<name>. Facets: intent-shape.

Canonical schema: .ia/src/floor/kernel.schema.ia.

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
