# @kind

Defines a closed semantic role for records; lowering determines the role of each registered word.

Owner: taxonomy. Identity: taxonomy/definition/<facet>/<name>. Facets: kind. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: kind.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.
- data.lane: id; required.
- data.authority-lane: id; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
