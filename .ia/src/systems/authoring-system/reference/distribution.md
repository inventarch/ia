# @distribution

Declares root records from which a distributable closure is selected.

Select when: Select root records whose dependency closure is to be packaged.

Avoid when: Use @workspace for a working source boundary or @template for rendering structure.

Before authoring: Choose roots that exclude repository-only maintenance records; qualification must inspect the resulting archive bytes.

Owner: workspace-system. Identity: workspace-system/definition/\<facet>/\<name>. Facets: distribution. Artifact set: projection. Primitive: Attention. Move: Observation.

Canonical schema: .ia/src/systems/workspace-system/schemas/distribution.schema.ia.

Default file: distribution.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section distribution: required.
Section product: optional.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- distribution.records: list of ref; required.
- product.name: id; optional.
- product.display-name: text; optional.
- product.version: text; optional.
- product.description: text; optional.
- product.author: text; optional.
- product.license: text; optional.
- product.keywords: list of text; optional.
- product.hosts: list of id in [claude, codex, grok]; optional.
- product.short-description: text; optional.
- product.category: text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
