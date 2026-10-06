# @case

Declares scenario inputs, expected behavior and evaluator attribution. A declaration is not an observed test result.

Owner: compliance-system. Identity: compliance-system/definition/<facet>/<name>. Facets: scenario. Artifact set: evidence. Primitive: Learning. Move: Verification.

Canonical schema: .ia/src/systems/compliance-system/schemas/case.schema.ia.

Section meaning: required.
Section scenario: required.
Section relationships: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- scenario.kind: id; required.
- scenario.given: text; required.
- scenario.request: text; required.
- scenario.expected: text; required.
- scenario.evaluator: text; required.
- scenario.operation: ref; optional.
- scenario.input: text; optional.
- scenario.code: id; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
