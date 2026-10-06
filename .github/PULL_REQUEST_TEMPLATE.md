## What changes

<!-- The behaviour that changes and why. Link the issue if there is one. -->

## Contracts and generated files

- [ ] The nearest `SPEC.md` describes the new behaviour, or no contract changes.
- [ ] Native records were edited under `.ia/src/` and the generated outputs were regenerated (`pnpm vocabulary:generate`, `pnpm authoring:generate`, `pnpm projections:generate`), or no records changed.
- [ ] New or moved test files are assigned in `tools/testing/tasks.json`.
- [ ] A public package changed and `pnpm release:note` added a note under `releases/pending/`, or no package changed.

## Checks run

<!-- List the commands you ran and the platform. Say what was not run. -->

```
pnpm platform:qualify   # on <platform>
```

## Notes for the reviewer

<!-- Decisions you made, things you are unsure about, follow-ups you left out. -->
