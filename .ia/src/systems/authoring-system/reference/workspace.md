# @workspace

Groups systems into an explicit work boundary; relationships can describe dependencies between boundaries.

Owner: workspace-system. Identity: workspace-system/definition/<facet>/<name>. Facets: workspace.

Canonical schema: .ia/src/systems/workspace-system/schemas/workspace.schema.ia.

Section meaning: required.
Section composition: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- composition.systems: list of ref; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
