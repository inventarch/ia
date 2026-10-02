# @run

Represents a governed run identity, declared phase, status and owner. Declaration does not start execution.

Owner: session-system. Identity: session-system/definition/<facet>/<name>. Facets: run.

Canonical schema: .ia/src/systems/session-system/schemas/run.schema.ia.

Section meaning: required.
Section execution: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- execution.status: id; required.
- execution.phase: id; required.
- execution.owner: ref; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
