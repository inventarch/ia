# @inventarch/agent-composition-system

The composition compiler: it compiles admitted `@agent-profile`, `@capability`, `@harness` and `@execution-binding` records against an installed catalog into a compiled harness and an execution manifest, and owns the captured-read adapters and the task-capture contract. See [the package contract](SPEC.md) and the exported TypeScript declarations.

The generic workspace runtime lives in `@inventarch/workspace-runtime` (packages/workspace-runtime in the repository); this package depends on it. The moved root symbols are re-exported from the package root, and every moved subpath, the `./internal/*` ones included, remains a plain alias that forwards to the corresponding module of `@inventarch/workspace-runtime`. Neither carries a per-symbol deprecation hint, because TypeScript does not apply a `@deprecated` tag to a re-export statement. Both are removed at the next major; import from `@inventarch/workspace-runtime` instead.
