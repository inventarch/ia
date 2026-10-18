# @template

Represents bounded rendering inputs and output structure. Rendering does not publish or install output.

Select when: Describe bounded inputs and output structure for rendering.

Avoid when: Use @operation for a broader executable effect or @spec for maintained requirements.

Before authoring: Scalar templates require parameters and lines; structured-v1 templates use their resource and may omit those legacy fields or keep empty lists.

Owner: template-system. Identity: template-system/template/\<facet>/\<name>. Facets: template. Artifact set: projection. Primitive: Decision. Move: Execution.

Canonical schema: .ia/src/systems/template-system/schemas/template.schema.ia.

Default file: template.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section template: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- template.filename: text; required.
- template.parameters: list of id; optional. — The scalar renderer requires declared parameters; structured-v1 may omit this field or retain an empty list.
- template.lines: list of text; optional. — The scalar renderer requires content lines; structured-v1 may omit this field or retain an empty list.
- template.profile: id; optional.
- template.resource: text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
