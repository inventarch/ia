# @distribution

Declares root records from which a distributable closure is selected.

Owner: workspace-system. Identity: workspace-system/definition/<facet>/<name>. Facets: distribution. Artifact set: projection. Primitive: Attention. Move: Observation.

Canonical schema: .ia/src/systems/workspace-system/schemas/distribution.schema.ia.

Section meaning: required.
Section distribution: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- distribution.records: list of ref; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
