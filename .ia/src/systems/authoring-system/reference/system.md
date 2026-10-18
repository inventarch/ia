# @system

Registers vocabulary, direct system dependencies, a local steward and consent for relationships.

Select when: Introduce a vocabulary owner with registered words, direct dependencies and relationship consent.

Avoid when: Use @workspace to select existing systems; use @schema to describe one word within its owner.

Before authoring: Name a local steward, declare only direct dependencies and check consent at both ends of every cross-system edge.

Owner: floor. Identity: floor/definition/\<facet>/\<name>. Facets: system. Artifact set: product-definition. Primitive: Attention. Move: Observation.

Canonical schema: .ia/src/floor/floor.schema.ia.

Default file: system.ia, relative to the workspace's authored root (the sources row at placement authored).

Section discriminators: optional.
Section requires: optional.
Section edges: optional.
Section relationships: optional.

- head.provider: text; required.
- head.version: text; required.
- head.steward: ref; optional.
- head.describes: text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
