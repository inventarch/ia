# @operation

Binds a declared operation to an implementation/input/output/effect contract; the host installs implementations.

Select when: Declare an implementation contract with inputs, outputs and effects for host execution.

Avoid when: Use @playbook for procedure text or @template for bounded rendering inputs.

Before authoring: Define success and refusal behavior and test the installed adapter; naming an implementation does not install it.

Owner: authoring-system. Identity: authoring-system/binding/\<facet>/\<name>. Facets: operation. Artifact set: execution. Primitive: Decision. Move: Execution.

Canonical schema: .ia/src/systems/authoring-system/schemas/operation.schema.ia.

Default file: operation.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section execution: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- execution.handler: id; required.
- execution.effects: id; required.
- execution.input: id; required.
- execution.output: id; required.
- execution.profile: id; optional.
- execution.recovery: id; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
