# @workspace

Groups systems into an explicit work boundary; relationships can describe dependencies between boundaries. Its sources name the roots and placement bands its records are captured from, and its steward the agent that directs it by default.

Owner: workspace-system. Identity: workspace-system/definition/\<facet>/\<name>. Facets: workspace. Artifact set: product-definition. Primitive: Attention. Move: Observation.

Canonical schema: .ia/src/systems/workspace-system/schemas/workspace.schema.ia.

Default file: workspace.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section composition: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- composition.systems: list of ref; required.
- composition.sources: list of text; optional. — A root and the placement it is captured at, spelled \<root> @\<placement> with the placement one of authored, adopted, open, floor or runtime; for example .ia/src @authored. Admission does not check this form; an entry spelled any other way declares no root.
- composition.steward: ref to agent; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
