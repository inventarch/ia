# @check

Names a check implementation and scope. Declaring an implementation name does not install or execute it.

Owner: compliance-system. Identity: compliance-system/check/<facet>/<name>. Facets: gate. Artifact set: evidence. Primitive: Decision. Move: Verification.

Canonical schema: .ia/src/systems/compliance-system/schemas/check.schema.ia.

Section meaning: required.
Section check: required.
Section relationships: optional.
Section governance: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- check.runs: id; required.
- check.scope: text; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
