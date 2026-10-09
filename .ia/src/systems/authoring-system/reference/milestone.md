# @milestone

Represents an outcome with an exit criterion inside exactly one plan; it names a condition, not the work toward it.

Owner: work-system. Identity: work-system/definition/<facet>/<name>. Facets: milestone. Artifact set: product-definition. Primitive: Inference. Move: Verification.

Canonical schema: .ia/src/systems/work-system/schemas/milestone.schema.ia.

Default file: milestone.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section work: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; optional.
- work.title: text; required.
- work.status: id in [proposed, open, held, closed, dropped, superseded]; required.
- work.plan: ref to plan; required.
- work.exit: text; required.
- work.owner: text; optional.
- work.start: text form iso-date; optional.
- work.due: text form iso-date; optional.
- work.ended: text form iso-date; optional.
- work.source: text; optional.

Relationship require to milestone: one-or-more; optional.
Relationship require to task: one-or-more; optional.
Relationship require to decision: one-or-more; optional.
Relationship supersede to milestone: one; optional.

A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
