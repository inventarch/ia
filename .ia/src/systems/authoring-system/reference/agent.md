# @agent

Names a participant and the vocabulary to which its governance applies. It does not grant host permissions.

Select when: Identify a participant and the vocabulary addressed by its governance.

Avoid when: Use @agent-profile for capability composition or @mandate for bounded authority.

Before authoring: Give the participant an unambiguous identity; host permissions require separate authorization.

Owner: agent-system. Identity: agent-system/binding/\<facet>/\<name>. Facets: agent. Artifact set: operational. Primitive: Attention. Move: Delegation.

Canonical schema: .ia/src/systems/agent-system/schemas/agent.schema.ia.

Default file: agent.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section governance: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- governance.applies: list of id; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
