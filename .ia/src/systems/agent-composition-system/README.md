# @inventarch/agent-composition-system

See [the package contract](SPEC.md) and the exported TypeScript declarations.

The generic workspace runtime now lives in [@inventarch/workspace-runtime](../../../../packages/workspace-runtime/README.md); this package keeps the composition compiler and depends on it. Its re-exports of the moved root symbols and subpaths are deprecated for one major; import them from `@inventarch/workspace-runtime` instead.
