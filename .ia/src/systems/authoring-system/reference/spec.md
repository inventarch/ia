# @spec

Represents a maintained specification with explicit status and at most one same-word supersession. Contents and document membership belong to its author; a source locator does not load a body or prove semantic quality.

Owner: work-system. Identity: work-system/contract/\<facet>/\<name>. Facets: spec. Artifact set: contract. Primitive: Memory. Move: Observation.

Canonical schema: .ia/src/systems/work-system/schemas/spec.schema.ia.

Default file: spec.ia, relative to the workspace's authored root (the sources row at placement authored).

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
- work.covers: list of text; optional. — Path selections the spec claims, matched by the location resolver.
- work.replaced-scope: text; optional. — What a superseding spec replaces when it does not replace the whole predecessor.

Relationship supersede to spec: one; optional.
Relationship grounded-by from decision (inbound ground): one; optional.

A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
