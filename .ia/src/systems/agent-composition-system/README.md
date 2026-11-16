# @inventarch/agent-composition-system

The composition compiler: it compiles admitted `@agent-profile`, `@capability`, `@harness` and `@execution-binding` records against an installed catalog into a compiled harness and an execution manifest, and owns the captured-read adapters and the task-capture contract. See [the package contract](SPEC.md) and the exported TypeScript declarations.

The generic workspace runtime lives in `@inventarch/workspace-runtime` (packages/workspace-runtime in the repository); this package depends on it. Import capture, resources, projections, publication, candidates, templates, lifecycle, authoring, sources, the local store and the adapters from `@inventarch/workspace-runtime`; this package no longer re-exports them.
