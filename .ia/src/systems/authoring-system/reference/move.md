# @move

Defines the closed classification of an agent action or activity.

Select when: Classify the action or activity that a participant may undertake.

Avoid when: Use @operation for an executable implementation contract or @primitive for cell selection.

Before authoring: Use the closed move vocabulary in authority bounds; a declared allowed move does not grant host permission.

Owner: taxonomy. Identity: taxonomy/definition/\<facet>/\<name>. Facets: move. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/floor/kernel.schema.ia.

Default file: move.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section data: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- data.order: number; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
