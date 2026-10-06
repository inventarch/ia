# Workspace runtime specification

## Boundary

`@inventarch/workspace-runtime` is the generic workspace runtime. It owns workspace capture and adoption, captured resources, projections, publication and candidates, templates, lifecycle, authoring index and manifest, installed catalog and source policy, sources, the local store and adapters. The composition compiler (catalog, compile, compiled, execution, fields, inputs, installed read, task capture, task context declaration, task teaching closure, draft tools) stays in `@inventarch/agent-composition-system`, which depends on this package. There is no reverse edge: no module here imports `@inventarch/agent-composition-system`, and `tests/boundary.test.ts` fails if one appears.

`installedImplementationDigest` pins the installed bytes of this package and its fixed first-party dependencies. An upper package pins its own installed entrypoint by passing it as an additional entry; the entries are never record- or model-supplied paths.

## Dependency policy

| Package | May import |
| --- | --- |
| `@inventarch/workspace-runtime` | `@inventarch/language`, `@inventarch/graph`, `@inventarch/db`, `@inventarch/runtime`, `@inventarch/compliance`, `@inventarch/agent-system`, `@inventarch/session-system`, `@inventarch/template-system`, `@inventarch/authoring-system` |

The installed manifest declares only the dependencies the emitted modules import; `tools/dependencies/check.ts` enforces the row.

## Provenance

Moved from @inventarch/agent-composition-system on 2026-10-06 (plan words-functional, task split-composition-runtime, inventarch/ia#16). The moved modules keep their names and behaviour; `@inventarch/agent-composition-system` re-exports the moved root symbols and subpaths, deprecated for one major.
