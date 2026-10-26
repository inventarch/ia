# Pantry walkthrough example

These files are the finished state of the user guide's walkthrough and of the concept pages that extend it. They are teaching material: original, synthetic and method-neutral. They are not part of any shipped distribution and no tool loads them implicitly.

`apps/cli/tests/walkthrough.test.ts` pins what the guide says about them. In a fresh `local/pantry` workspace with `records/` copied into `.ia/src/`, the workspace admits with no error and the `records-conform` check binds the built-in `COMP-SCHEMA` evaluator and passes. `ia next` reads `write-exporter-tests-pass` as exit evidence for `write-exporter` at its current digest, `add-export-button` is unblocked and `document-export` blocked. The task's position reserves the blocking law and lists the convention by word. Editing the task makes the evidence stop counting, and removing the decision's choice blocks the plan. In a fresh `local/kitchen --system` workspace, the kitchen system admits a record of its `@allergen` word.

The observation's `subject-revision` is the digest of `write-exporter` as authored here. A change to that task, to its file's record, or to how IA computes record digests requires updating the observation and the quoted digests in the guide in the same change. Its `digest` field describes a test output that is not kept; IA does not recompute it. The attribution comment on the decision records the authored revision of the walkthrough run that wrote it and is trivia: it changes no digest.

Outputs quoted in the guide come from running the walkthrough with the CLI at the version the guide names. Regenerate them when command output changes.
