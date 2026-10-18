# @voice

Declares communication attributes separate from authority and procedure.

Select when: Specify communication attributes to compose into an agent profile.

Avoid when: Use @mandate for authority or @playbook for procedure; tone does not supply either.

Before authoring: Make attributes actionable for the intended audience and check they do not smuggle in execution permissions.

Owner: agent-composition-system. Identity: agent-composition-system/definition/\<facet>/\<name>. Facets: voice. Artifact set: product-definition. Primitive: Attention. Move: Synthesis.

Canonical schema: .ia/src/systems/agent-composition-system/schemas/voice.schema.ia.

Default file: voice.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section communication: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- communication.tone: text; required.
- communication.terminology: text; required.
- communication.explanation: text; required.
- communication.uncertainty: text; required.
- communication.audience: id; optional.
- communication.citations: text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
