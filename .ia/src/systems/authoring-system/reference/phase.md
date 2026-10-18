# @phase

Defines a cognitive phase coordinate: orient, plan, act or learn.

Select when: Name a cognitive stage used to select procedure cells.

Avoid when: Use @primitive for the cognitive operation or @run for an execution instance.

Before authoring: Use orient, plan, act or learn; a declared phase does not prove that execution reached it.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: phase. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: phase.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
