# @case

Declares scenario inputs, expected behavior and evaluator attribution. A declaration is not an observed test result.

Select when: Describe reproducible scenario inputs, a request and its expected success or refusal.

Avoid when: Use @check to name an evaluator or @observation to record an observed result.

Before authoring: Bind the case to an executable assertion and expected code where relevant; declaring a case does not run it.

Owner: compliance-system. Identity: compliance-system/definition/\<facet>/\<name>. Facets: scenario. Artifact set: evidence. Primitive: Learning. Move: Verification.

Canonical schema: .ia/src/systems/compliance-system/schemas/case.schema.ia.

Default file: case.ia, relative to the workspace's authored root (the sources row at placement authored).

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
