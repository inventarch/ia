# @inventarch/workspace-runtime

The generic workspace runtime: workspace capture and adoption (`captureWorkspace`, `adoptWorkspace`, `verifyCapture`, `Corpus`), captured resources and native resource context, projections and prose catalogs, managed publication and candidate validation, captured template rendering, lifecycle rows, profiles and transport, the authoring index and manifest, the installed catalog digest and installed source policy, source policies, the local store adapter and installed adapter verification. [SPEC.md](SPEC.md) owns the boundary.

Consumers import the package root for capture, publication, candidate validation and the installed implementation digest, and the public subpaths (`/resources`, `/projections`, `/templates`, `/lifecycle`, `/lifecycle-profile`, `/authoring`, `/authoring-manifest`, `/sources`, `/local-store`, `/adapters`, `/corpus`, `/installed-catalog`, `/authoring-types`, `/authoring-format`, `/resource-format`, `/resource-sources`, `/task-capture-format`, `/candidate`, `/publication`) for the rest. `./internal/*` entries exist for every emitted module and are not a stable contract.

This package never imports `@inventarch/agent-composition-system`. The composition compiler lives there and depends on this package.
