# @contract

Names versioned requirements that may be adopted by other records. Requirements need explicit evaluation evidence.

Owner: compliance-system. Identity: compliance-system/contract/<facet>/<name>. Facets: signature. Artifact set: contract. Primitive: Memory. Move: Verification.

Canonical schema: .ia/src/systems/compliance-system/schemas/contract.schema.ia.

Default file: contract.ia, relative to the workspace's authored root (the sources row at placement authored).

Section meaning: required.
Section relationships: required.
Section inputs: optional.
Section outputs: optional.
Section preconditions: optional.
Section invariants: optional.
Section failures: optional.
Section authority: optional.
Section context: optional.
Section evolution: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- head.version: text; required.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
