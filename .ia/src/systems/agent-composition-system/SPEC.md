# @inventarch/agent-composition-system

Public language mechanism: the composition compiler for the `@agent-profile`, `@capability`, `@harness` and `@execution-binding` words. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

This package owns `compileHarness`, `executionManifest`, the installed catalog types, the captured-read adapters and the task-capture contract. The generic workspace runtime (capture and adoption, resources, projections, publication, candidates, templates, lifecycle, authoring index and manifest, installed catalog, sources, local store and adapters) lives in `@inventarch/workspace-runtime` (packages/workspace-runtime in the repository), which this package depends on and never the reverse. The root re-exports of the moved symbols and the `./resources`, `./projections`, `./templates`, `./sources`, `./authoring`, `./authoring-manifest`, `./lifecycle`, `./lifecycle-profile`, `./adapters` and `./local-store` subpaths are deprecated compatibility re-exports kept for one major; import them from `@inventarch/workspace-runtime`. `installedImplementationDigest` from this package pins the composition entrypoint on top of the generic runtime pin.

The [first-party installed captured read](references/installed-read.md) is available through fixed root exports. Current host authority and capture/code verification remain required; installation grants nothing.

The [public spec and explicit body seam](references/public-spec.md) separates native anchor admission from resource capture, disclosure and semantic review.

The [joined native spec read and explicit body example](references/spec-read-boundary.md) exercises separate native execution and resource disclosure boundaries through existing APIs.

The [complete task capture contract](references/task-capture.md) defines version-2 scope, trusted full-view verification, required teaching and explicit overflow refusal at the existing bound.
