# Shared-root CLI qualification

Tracks [issue #263](https://github.com/inventarch/ia/issues/263), the isolated CLI ownership portion of [#194](https://github.com/inventarch/ia/issues/194). Its plan, spec and task are kept with InventArch's work records outside this repository. Authored by InventArch.

## Red checkpoint

Commit `1759dd51` contains the specification, native tracking and six behavioral cases before implementation. Node 22.22.0 on Windows, `pnpm exec vitest run --config vitest.config.mts tests/preview.test.ts -t "shared authored-root ownership" --maxWorkers=1`, run from `apps/cli`: two expected `IA-CLI-EDIT-UNOWNED` failures, four passing controls, 34 unrelated tests skipped. Both failures occur when the co-declarer sorts before the repository workspace. The alpha loop and author roundtrip stop at their first preview failure; subsequent default, edit and author assertions are not yet observed there.

## Independent specification and test review

The independent reviewer identified two fixture defects before the checkpoint: the second workspace lacked required `meaning.answers`, and placing it in the repository entrypoint made the repository seat ambiguous. Both were corrected. Fixture assertions now establish clean admission, the intended repository seat and both shared-root declarations before exercising authoring.

Final pre-implementation verdict: no blocking findings. Preserve the identical deepest-root boundary, own authored placement, repository-only restrictive mandate and existing actor/digest/administrative checks. Do not take the broader shared-seat governance changes from PR #196: requiring every declarer in a mandate scope could discard a repository-only restriction. This review examined source and retained red evidence; it was not an independent test execution or implementation approval.

## Qualification standing

The corrected implementation passes all eight focused shared-root cases on Windows, Node 22.22.0: `pnpm exec vitest run --config vitest.config.mts tests/preview.test.ts -t "shared authored-root ownership" --maxWorkers=1` from `apps/cli`. The 34 unrelated cases were skipped by the filter. The run took 1029.39 seconds under host contention (154.76 seconds import; 854.41 seconds tests). This observes default and existing-record previews, foreign/adopted and exact-spelling refusals, retained repository-mandate selection, and an authorized author/validate roundtrip.

CLI typechecking, changed-file lint/format, native structural checks, release coverage, documentation coverage/links, authoring-resource checks and regenerated projection checks pass. Full platform qualification remains pending CI; the task and milestone remain open. No merge, release or downstream installed-CLI qualification is established by these focused results.

## Internal implementation review: canonical root spelling

A subsequent Claude review identified a blocking case-variant declaration issue: filesystem-folded comparison can treat differently spelled roots as co-declarations, while native membership and seating use exact canonical spellings. The first implementation expanded that pre-existing mismatch to both identity orders. The independent reviewer confirmed the finding after inspecting DB membership and seat resolution; the earlier static approval missed it.

The added regression establishes the real directory spelling with two renames, asserts clean admission and the foreign native seat, and tests both `alpha` and `zeta` co-declarers for new targets and existing-record edits. The proposed correction uses exact containment when selecting the winning root and exact equality among its declarers. Fixing equality alone is insufficient when the repository workspace sorts first. Filesystem alias checks and the floor exclusion retain their existing protection. No shared-seat or mandate semantics are changed.

The initial broad verification attempts were interrupted before completion after this finding. They are not pass evidence. On Windows with Node 22.22.0, the focused `differently cased root` run observed both identity orders accepting the foreign exact root: two failures, forty unrelated tests skipped, 410.14 seconds including 186.60 seconds import and 220.44 seconds tests under host contention. Each red assertion stopped at creation; both subsequent edit refusals are now observed in the corrected green run. The independent spec/test review found no blocking gap and confirmed that both holder selection and co-declarer equality must use exact spelling.

Internal re-review confirms the blocker resolved with no new blocking finding. The stale volume-spelling comment was corrected. Remaining coverage suggestions are nonblocking: the mandate test deliberately preserves selection before ownership; existing path-cover tests cover that separate mechanism. Shared-target author coverage exercises creation, while preview covers default and existing targets and the unchanged author pipeline has its own broader suite. The refusal-code assertions establish the intended boundary with independently admitted fixtures. Shared path seating itself still follows current DB semantics; this repair does not adopt PR #196's separate governance proposal.

## Update after #196 merged to main

PR #196 (db D02b, runtime R21) reached main before this branch. At a shared root it seats the path as shared and lets a mandate govern there only when its scope names every declarer. The owner kept that rule, so the earlier "retains the repository-only mandate restriction" case no longer holds. It is now `does not apply a repository-only mandate restriction on a shared target`, which pins #196's behavior. This branch's own change still applies over main's case-folded comparison: `unowned` uses the exact canonical spelling for root containment and co-declaration.
