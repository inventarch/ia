# @template

Represents bounded rendering inputs and output structure. Rendering does not publish or install output.

Owner: template-system. Identity: template-system/template/<facet>/<name>. Facets: template.

Canonical schema: .ia/src/systems/template-system/schemas/template.schema.ia.

Section meaning: required.
Section template: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- template.filename: text; required.
- template.parameters: list of id; required.
- template.lines: list of text; required.
- template.profile: id; optional.
- template.resource: text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
