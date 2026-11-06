# Shared-root CLI qualification

Tracks [issue #263](https://github.com/inventarch/ia/issues/263), the isolated CLI ownership portion of [#194](https://github.com/inventarch/ia/issues/194). Native plan: `shared-root-authoring`; task/spec: `shared-root-cli-ownership`. Authored by InventArch.

## Red checkpoint

Commit `1759dd51` contains the specification, native tracking and six behavioral cases before implementation. Node 22.22.0 on Windows, `pnpm exec vitest run --config vitest.config.mts tests/preview.test.ts -t "shared authored-root ownership" --maxWorkers=1`, run from `apps/cli`: two expected `IA-CLI-EDIT-UNOWNED` failures, four passing controls, 34 unrelated tests skipped. Both failures occur when the co-declarer sorts before the repository workspace. The alpha loop and author roundtrip stop at their first preview failure; subsequent default, edit and author assertions are not yet observed there.

## Independent specification and test review

The independent reviewer identified two fixture defects before the checkpoint: the second workspace lacked required `meaning.answers`, and placing it in the repository entrypoint made the repository seat ambiguous. Both were corrected. Fixture assertions now establish clean admission, the intended repository seat and both shared-root declarations before exercising authoring.

Final pre-implementation verdict: no blocking findings. Preserve the identical deepest-root boundary, own authored placement, repository-only restrictive mandate and existing actor/digest/administrative checks. Do not take the broader shared-seat governance changes from PR #196: requiring every declarer in a mandate scope could discard a repository-only restriction. This review examined source and retained red evidence; it was not an independent test execution or implementation approval.

## Pending qualification

Implementation, affected-suite results, internal implementation review and platform qualification remain pending. No merge, release or downstream installed-CLI qualification is established by the red checkpoint.
