# @plan

Represents an arrangement of milestones toward an intent; it heads the work hierarchy and has no parent. Plans do not nest.

Owner: work-system. Identity: work-system/definition/\<facet>/\<name>. Facets: plan. Artifact set: product-definition. Primitive: Inference. Move: Synthesis.

Canonical schema: .ia/src/systems/work-system/schemas/plan.schema.ia.

Default file: plan.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section work: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; optional.
- work.title: text; required.
- work.status: id in [proposed, open, held, closed, dropped, superseded]; required.
- work.owner: text; optional.
- work.start: text form iso-date; optional.
- work.due: text form iso-date; optional.
- work.ended: text form iso-date; optional.
- work.source: text; optional.

Relationship supersede to plan: one; optional.

A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
