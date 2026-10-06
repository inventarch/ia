# @agent

Names a participant and the vocabulary to which its governance applies. It does not grant host permissions.

Owner: agent-system. Identity: agent-system/binding/<facet>/<name>. Facets: agent. Artifact set: operational. Primitive: Attention. Move: Delegation.

Canonical schema: .ia/src/systems/agent-system/schemas/agent.schema.ia.

Section meaning: required.
Section governance: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- governance.applies: list of id; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
