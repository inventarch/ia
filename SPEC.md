# IA 1.0.0 repository contract

Owns the public workspace and its normative [language reference](docs/reference/language/SPEC.md). The native kernel and system schemas define the language; package contracts define compiler, graph, persistence, composition and host behavior. Vocabulary does not include curated expert methods or hosted marketplace policy.

The CLI and runtime packages use release version 1.0.0. Native source syntax remains `#! ia 1.0`; independently selected distributions retain their own versions. The optional [product-structure distribution](distributions/product-structure/SPEC.md) is separate from the canonical language.

`pnpm platform:qualify` is the repository qualification entry point. Build, type, conformance, documentation and emitted-resource checks qualify their exercised scope. Package publication, repository hosting, registry ownership and platform coverage require their own evidence; a local passing build does not establish those external facts.

Public npm packages use the `@inventarch` scope. The [publishing guide](tools/distribution/NPM-PUBLISHING.md) describes the npm 12 release toolchain, first-package setup and the GitHub OIDC workflow. `npm:prepare`, `npm:consumer` and `npm:plan` qualify and inspect release artifacts; registry publication is an explicit workflow dispatch.
