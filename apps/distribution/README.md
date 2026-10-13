# @inventarch/distribution

See [the package contract](SPEC.md) and the exported TypeScript declarations.

## Distribution engine compatibility

The distribution engine is independent of the npm and native archive versions. Published IA 2.0.0 uses engine 0.1.0. The successor uses 0.1.1 so it can verify pinned release-control sources outside reusable system folders. Archives with those sources require at least that capability; their engine ranges must not be lowered to make an older consumer accept them.

The new reader accepts the exact 0.1.0 lock marker written by the released solver, without rewriting its pins, when the selected archives themselves support the new engine. That is forward compatibility only. Locks produced by the newer solver and native archives requiring 0.1.1 cannot be opened by the published 2.0.0 consumer. An incompatible lock is not evidence of corruption. A current consumer reports the required engine and its own engine; an older consumer can report a generic engine-compatibility refusal.

Before upgrading a workspace, retain a complete backup of its authored source and distribution/host state, including the lock and exact cached archives, and record the CLI version that can open it. Use a compatible IA installation to validate the upgraded workspace. If its activation is missing, use that compatible CLI's explicit restore with the exact pinned archives; restore reinstates an installation and cannot upgrade the running CLI. Do not delete locks or edit lock/archive engine ranges to silence a refusal.

To return to published 2.0.0, first use the newer CLI to finish any pending host recovery and remove generated host registrations if they were applied; its generated agents, skills and hook state may also be unreadable by 2.0.0. Restore the complete pre-upgrade backup with the matching old CLI and exact archive pins. Keep the upgraded workspace separately for any later source reconciliation. There is no in-place downgrade conversion.
