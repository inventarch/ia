# @execution-binding

Connects a native target to a host-installed entry or operation descriptor.

Owner: agent-composition-system. Identity: agent-composition-system/binding/<facet>/<name>. Facets: execution-binding. Artifact set: execution. Primitive: Decision. Move: Execution.

Canonical schema: .ia/src/systems/agent-composition-system/schemas/execution-binding.schema.ia.

Section meaning: required.
Section binding: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- binding.kind: id; required.
- binding.implementation: id; required.
- binding.target: ref; optional.
- binding.mapping: id; optional.
- binding.event: id; optional.
- binding.guard: id; optional.
- binding.tools: list of id; optional.
- binding.filters: list of text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
