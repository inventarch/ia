# @decision

Represents a choice that is needed or has been made: the question, options and decider, and once made, the choice and rationale.

Owner: work-system. Identity: work-system/definition/<facet>/<name>. Facets: decision. Artifact set: decision. Primitive: Decision. Move: Synthesis.

Canonical schema: .ia/src/systems/work-system/schemas/decision.schema.ia.

Default file: decision.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section work: required.
Section decision: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; optional.
- work.title: text; required.
- work.status: id in [open, made, superseded, withdrawn]; required.
- work.owner: text; optional.
- work.start: text form iso-date; optional.
- work.due: text form iso-date; optional.
- work.ended: text form iso-date; optional.
- work.source: text; optional.
- decision.question: text; required.
- decision.options: list of text; optional.
- decision.decider: text; optional.
- decision.choice: text; optional.
- decision.rationale: text; optional.
- decision.constraints: list of text; optional.
- decision.effective-revision: text; optional. — The snapshot revision from which the decision takes effect.

Relationship supersede to decision: one; optional.

A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
