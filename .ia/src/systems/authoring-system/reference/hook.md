# @hook

Represents a host event, tool/path selection and guard message. Registration and executing a guard require a host adapter.

Select when: Describe a host event and selection guard with its response message.

Avoid when: Use @operation for an executable contract or @law for a rule independent of host events.

Before authoring: Verify registration and event matching in the host adapter; declaration alone neither registers nor executes a guard.

Owner: hook-authoring-system. Identity: hook-authoring-system/binding/\<facet>/\<name>. Facets: hook. Artifact set: operational. Primitive: Escalation. Move: Execution.

Canonical schema: .ia/src/systems/hook-authoring-system/schemas/hook.schema.ia.

Default file: hook.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section hook: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- hook.event: id; required.
- hook.tools: list of id; required.
- hook.paths: list of text; required.
- hook.message: text; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
