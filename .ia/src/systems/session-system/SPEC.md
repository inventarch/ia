# @inventarch/session-system

Public language mechanism. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

`@run` records declared execution metadata. `execution.phase` is an optional id: omit it when the phase is unknown. Historical values, including `recorded`, remain admitted; declaring a phase does not prove the engine's current state. `execution.status` remains a required id without a closed vocabulary, and `execution.owner` remains a required reference.

A projection of a runner journal omits an unknown phase when the selected run schema allows omission. When an older selected schema requires the field, the projection retains its historical `recorded` sentinel for compatibility. Neither representation establishes a live engine phase.

Runtime sessions, runs, attempts, receipts and question answers expose `label: string[]`. Labels are opaque sets, deduplicated without interpreting their names; legacy omitted labels mean `[]`. Each id is 1–1024 UTF-8 bytes, without C0/C1 controls, U+2028/U+2029 or unpaired surrogates. Quotes, backslashes, spaces and other Unicode are preserved exactly. Observation, reconciliation, replies and reaction results join their labels into the run and session monotonically. Attempts inherit their run's label, model outputs and outcomes inherit all observed run content, and a child inherits its parent's label on creation and joins back on return. Transcript entries preserve the corresponding labels.

`release.accept` journals a trusted release (`id`, `runId`, `output`, `label`, `policy`, `policyRevision`, `sources` with engine-derived id/digest/label), retained in `Session.releases` and charged to its run's journal byte budget. Release output can have a lower label, but never lowers run/session labels. A refused candidate is not a release record and must not be persisted by the engine.

`Admission.labels` contains the labels of content a commit adds, not merely the difference from the previous session set: another observation or reply of an already-held label still exposes it to the gate. Inherited model/action/outcome/child and release labels are included. `Admission.state.label` is the complete next-state label. Checkpoints add no content and offer `labels: []`. The existing synchronous fail-closed gate and its in-process atomicity limit are unchanged.

Explicit observation/reconciliation/reply/reaction labels and `release.accept` use event version 3, so older reducers refuse rather than silently dropping disclosure metadata. Legacy unlabelled version 1 journals and version 2 renewal events retain their replay semantics, and a legacy starting state replays as unlabelled. The version/mutation pairing is checked, including explicit empty label arrays.

`execution.label` is an optional list of opaque host-defined text ids. Runner evidence carries the session's accumulated content label here, without lowering it when an outcome is released. This is disclosure metadata, not authority: readers must enforce current clearance, and a projection must not silently drop a nonempty label when a selected legacy schema cannot represent it.
