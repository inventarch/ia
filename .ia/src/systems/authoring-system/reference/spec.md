# @spec

Represents a maintained specification with explicit status and at most one same-word supersession. Contents and document membership belong to its author; a source locator does not load a body or prove semantic quality.

Owner: work-system. Identity: work-system/contract/<facet>/<name>. Facets: spec.

Canonical schema: .ia/src/systems/work-system/schemas/spec.schema.ia.

Section meaning: required.
Section work: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; optional.
- work.title: text; required.
- work.status: id in [draft, accepted, superseded, withdrawn]; required.
- work.owner: text; optional.
- work.start: text form iso-date; optional.
- work.due: text form iso-date; optional.
- work.ended: text form iso-date; optional.
- work.source: text; optional.

Relationship supersede to spec: one; optional.

A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
