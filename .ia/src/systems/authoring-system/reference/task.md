# @task

Represents one owner's action toward exactly one milestone. Whether it is ready to start is computed by a work evaluator, never stored on the record.

Owner: work-system. Identity: work-system/definition/<facet>/<name>. Facets: task. Artifact set: execution. Primitive: Decision. Move: Execution.

Canonical schema: .ia/src/systems/work-system/schemas/task.schema.ia.

Default file: task.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section work: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; optional.
- work.title: text; required.
- work.status: id in [proposed, open, held, closed, dropped, superseded]; required.
- work.milestone: ref to milestone; required.
- work.owner: text; optional.
- work.start: text form iso-date; optional.
- work.due: text form iso-date; optional.
- work.ended: text form iso-date; optional.
- work.source: text; optional.
- work.action: text; optional. — What the task's owner does to complete it.
- work.expected-artifact: text; optional. — The artifact the task produces, as a path or name.
- work.exit-evidence: ref to observation; optional. — The observation whose success verdict closes the task.
- work.owner-agent: ref to agent; optional. — The agent that owns the task; work.owner stays the free-text owner.

Relationship require to task: one-or-more; optional.
Relationship require to milestone: one-or-more; optional.
Relationship require to decision: one-or-more; optional.
Relationship supersede to task: one; optional.

A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
