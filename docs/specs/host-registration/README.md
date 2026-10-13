---
id: spec-host-registration
genre: spec
title: Host registration
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-12"
owners: [inventarch]
---

# Host registration

The [host handler](../../../apps/cli/src/host.ts) plans and applies through distribution services. Supported hosts come from [hosts.ts](../../../apps/distribution/src/hosts.ts). User installation is described in [host plugin distribution](../host-plugin-distribution/README.md).

## 3 Payload and ownership

The CLI's generated payload has an inventory, release identity and byte digests. Installed implementation catalogs are verified against that payload. A host joins only supported native bindings whose implementation bytes the trusted installed catalog owns. Neither registry content nor an authored binding alone authorizes arbitrary code loading.

### 3.2 Bundling

[host-payload.mjs](../../../tools/distribution/host-payload.mjs) follows the public package dependency closure, strips development export conditions, rejects omitted capability coupling and checks bounded payload size. Inputs must already be public manifests; no private staging transformation is performed.

## 4 Commands

`host <host>` previews workspace registration, `--apply` applies it and `--remove` removes owned registration. `init --host` invokes the same registration path after initialization. `project <host>` writes owned packet projections without registering a host. Install/update/remove refresh registered projections after changing the installed set and report a failed refresh separately from a committed install.

## 5 Plan safety

A planned write records owned paths, current state and expected payload. Modified owned files, unowned collisions and active journals refuse. Applying rechecks inputs. Runtime/home locations must be safe and cannot impersonate authored workspace roots.

## 6 Recovery

Registration and installation journals have explicit recovery commands. A partially applied host action is not silently called registered. Removal respects ownership and preserves foreign files.

Projection recovery also preserves unowned hook registrations and foreign generated files. A legacy or unowned guard is never adopted or deleted as part of a recovery; the refusal identifies the exact settings file and the safe removal or repair command. A projection receipt is reused only when its render inputs, owned-file digests and removal evidence still match, so an interrupted apply cannot turn an external change into owned state.

## 7 Doctor and support

[Doctor](../../../apps/cli/src/doctor.ts) only observes. A matching registration says written, not observed answering. Missing/changed packet files or a different rendered revision report drift; a malformed state reports failure. Catalog and join rows inspect pinned bytes without importing handlers.

The platform row compares observed Node and platform with the declared target in the package engine and doctor implementation. Matching a target is not qualification. A platform outside the declaration warns; checks that cannot run stay unknown. Test evidence is platform-specific.

## 8–10 Qualification boundaries

[Host tests](../../../apps/cli/tests/host-registration.test.ts), [recovery tests](../../../apps/cli/tests/host-recovery.test.ts) and [doctor tests](../../../apps/cli/tests/host-doctor.test.ts) establish local write/read/refusal behavior. A written config does not prove a fresh host session loaded it or invoked a handler.
