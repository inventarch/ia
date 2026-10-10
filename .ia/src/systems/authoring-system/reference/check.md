# @check

Names a check implementation and scope. Declaring an implementation name does not install or execute it.

Owner: compliance-system. Identity: compliance-system/check/\<facet>/\<name>. Facets: gate. Artifact set: evidence. Primitive: Decision. Move: Verification.

Canonical schema: .ia/src/systems/compliance-system/schemas/check.schema.ia.

Default file: check.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section check: required.
Section relationships: optional.
Section governance: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- check.implementation: text; optional. — The evaluator that runs the check: a built-in or catalog evaluator id, the same value check.runs takes, and equal to it when both are stated. The \<id>@\<version> form of evidence.implementation is not accepted here.
- check.runs: id; optional.
- check.scope: text; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
