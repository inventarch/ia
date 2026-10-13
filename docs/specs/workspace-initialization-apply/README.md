---
id: spec-workspace-initialization-apply
genre: spec
title: Workspace initialization apply
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-12"
owners: [inventarch]
---

# Workspace initialization apply

The [init handler](../../../apps/cli/src/init.ts) owns ordering and reports each completed effect. This contract accompanies [the starter definition](../workspace-initialization/README.md).

## 1 Plan and apply

Planning lists installs, authored records, admission, descriptor, capture and optional projection. Applying uses that same plan after validating inputs. Existing unrelated content is preserved; conflicting owned destinations refuse.

## 2 Base artifact

The base builder validates engine compatibility and positive language selection before writing its digest-named archive and pin. Fixed inputs on one zlib build produce deterministic ustar bytes with epoch zero. Build output is regenerated from public repository sources.

## 3 Installation

The bundled base is installed offline through the distribution installer, with exact digest/manifest checks. It does not acquire arbitrary remote credentials or executable authority.

## 4 Authoring and admission

Create-only starter writes skip an existing file only when bytes agree. Admission must have zero errors and contain each expected starter record at its planned path before initialization completes.

## 5 Descriptor completion

Writing the descriptor marks the workspace initialized. Before that point an interruption names the init rerun. The rerun skips completed steps where they still match.

## 6 Effects after completion

Capture and host projection report independently. A failed capture keeps initialization and reports `capture` as repair. A selected projection can still run because it reads the live revision. Projection failure reports completed initialization and its own repair. Earlier effects are not silently rolled back.

## 7 Migration recovery

Migration preflights every move, delete, write, identity and registered projection. A failed file step lists completed changes and names validation or a safe migration rerun. A failed post-migration effect names that effect's command. Repository history or a caller-owned backup supplies rollback; the CLI does not claim transactionality across all effects.

Projection recovery is conservative: unowned hooks, foreign files and external validation evidence are not adopted or removed while resuming initialization. Receipts and journals are reused only when their recorded inputs and current bytes still match; otherwise the apply refuses with the exact repair target.

## 8 Acceptance evidence

[Init tests](../../../apps/cli/tests/init.test.ts), [language-base tests](../../../tools/native/language-base.test.ts) and [installed view checks](../../../tools/distribution/installed-views.mjs) exercise the authored shape, descriptor, capture, omission of implicit hosts, interrupted effects and offline base. Publication and host activation require additional evidence.
