# @run

Represents a governed run identity, status, owner and declared phase when known. Declaration does not start execution.

Select when: Identify a governed execution and record its status and any known phase.

Avoid when: Use @task for intended work or @observation for execution evidence.

Before authoring: Keep journal-only runs phase-free when no live phase is known; status and ownership declarations do not start execution.

Owner: session-system. Identity: session-system/definition/\<facet>/\<name>. Facets: run. Artifact set: operational. Primitive: Decision. Move: Execution.

Canonical schema: .ia/src/systems/session-system/schemas/run.schema.ia.

Default file: run.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section execution: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- execution.status: id; required.
- execution.phase: id; optional. — The declared phase, when known; omit it when unknown. Historical id values remain valid. A declaration does not prove engine state.
- execution.owner: ref; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
