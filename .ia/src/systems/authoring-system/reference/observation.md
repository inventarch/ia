# @observation

Represents an attributed evidence account with interpretation and retention metadata. Evidence claims are not verified by field typing.

Owner: learning-system. Identity: learning-system/definition/<facet>/<name>. Facets: observation. Artifact set: evidence. Primitive: Learning. Move: Observation.

Canonical schema: .ia/src/systems/learning-system/schemas/observation.schema.ia.

Section meaning: required.
Section evidence: required.
Section interpretation: required.
Section retention: required.
Section relationships: optional.

- meaning.says: text; required.
- meaning.answers: text; required.
- evidence.origin: id; required.
- evidence.actor: text; required.
- evidence.observed-at: text; required.
- evidence.captured-at: text; required.
- evidence.workspace: text; required.
- evidence.locator: text; required.
- evidence.revision: text; required.
- evidence.bundle: text; required.
- evidence.digest: text; required.
- evidence.availability: id; required.
- interpretation.applies: text; required.
- interpretation.limits: text; required.
- interpretation.reason: text; required.
- interpretation.basis: id; required.
- retention.status: id; required.
- retention.explanation: text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
