# @observation

Represents an attributed evidence account with interpretation and retention metadata. Evidence claims are not verified by field typing.

Owner: learning-system. Identity: learning-system/definition/\<facet>/\<name>. Facets: observation. Artifact set: evidence. Primitive: Learning. Move: Observation.

Canonical schema: .ia/src/systems/learning-system/schemas/observation.schema.ia.

Default file: observation.ia, relative to the workspace's authored root (the sources row at placement authored).

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
- evidence.subject: ref; optional. — The record the evidence is about, as a typed reference; evidence.locator spells the same subject as text.
- evidence.subject-revision: text; optional. — The subject's per-record digest when the evidence was taken; readiness compares it with the subject's current digest. evidence.revision is its free-text form.
- evidence.snapshot-revision: text; optional. — The revision of the snapshot the subject was read from.
- evidence.evaluator: text; optional. — Who produced the evidence, as a ref identity or \<tool>@\<version>; evidence.actor is its free-text form.
- evidence.move: id in [Observation, Execution, Delegation, Synthesis, Verification]; optional.
- evidence.verdict: id in [success, refusal, inconclusive]; optional.
- evidence.implementation: text; optional. — The \<id>@\<version> of the check implementation that produced the evidence; evidence.origin names only its kind.
- evidence.target: text; optional. — The host id the evidence was produced on; with evidence.implementation it types what evidence.origin names.
- interpretation.applies: text; required.
- interpretation.limits: text; required.
- interpretation.reason: text; required.
- interpretation.basis: id; required.
- retention.status: id; required.
- retention.explanation: text; optional.


A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.
