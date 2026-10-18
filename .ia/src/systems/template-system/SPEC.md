# @inventarch/template-system

Public language mechanism. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

The template schema admits both scalar and profiled declarations. The scalar renderer requires `template.parameters` and `template.lines`, exact string values for every declared parameter, and no profile or resource field. A `structured-v1` template selects its matching workspace renderer and may omit `parameters` and `lines`; historical empty lists remain accepted. Present nonempty lists are refused by that renderer. Structural admission alone does not establish renderer validity.

The [render-template cases](cases/render-template.ia) exercise the [scalar rendering contract](contracts/scalar-rendering.ia) through `tools/systems/execute.test.ts` using the admitted `authored-note` fixture under `tools/systems/fixtures/native`. They cover one draft result and refusal when a required parameter is missing; the fixture is test input, not a template shipped in this system's native sources.
