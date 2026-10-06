# @improvement

Represents a proposed change, review metadata and publication metadata. It does not authorize or apply the proposal.

Owner: learning-system. Identity: learning-system/definition/<facet>/<name>. Facets: improvement. Artifact set: inquiry. Primitive: Learning. Move: Synthesis.

Canonical schema: .ia/src/systems/learning-system/schemas/improvement.schema.ia.

Section meaning: required.
Section proposal: required.
Section review: required.
Section publication: required.
Section relationships: required.

- meaning.says: text; required.
- meaning.answers: text; required.
- proposal.target: qname; required.
- proposal.system: id; required.
- proposal.path: text; required.
- proposal.before: text; required.
- proposal.candidate: text; required.
- proposal.digest: text; required.
- proposal.applies: text; required.
- proposal.verification: text; required.
- proposal.reversal: text; required.
- review.status: id; required.
- review.digest: text; optional.
- review.reviewer: text; optional.
- review.authority: text; optional.
- review.at: text; optional.
- review.rationale: text; optional.
- review.revisit: text; optional.
- publication.status: id; required.
- publication.receipt: text; optional.
- publication.digest: text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
