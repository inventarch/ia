# IA repository contract

Owns the public workspace and its normative [language reference](docs/reference/language/SPEC.md). The native kernel and system schemas define the language; package contracts define compiler, graph, persistence, composition and host behavior. Vocabulary does not include curated expert methods or hosted marketplace policy.

The CLI, runtime and every other public npm package share the coordinated release version selected in [releases/current.json](releases/current.json). Native source syntax remains `#! ia 1.0`; independently selected distributions retain their own versions. The optional [product-structure distribution](distributions/product-structure/SPEC.md) is separate from the canonical language.

`pnpm platform:qualify` is the repository qualification entry point. Build, type, conformance, documentation and emitted-resource checks qualify their exercised scope. Package publication, repository hosting, registry ownership and platform coverage require their own evidence; a local passing build does not establish those external facts.

Public npm packages use the `@inventarch` scope. The [publishing guide](tools/distribution/NPM-PUBLISHING.md) describes the npm 12 release toolchain, first-package setup and the GitHub OIDC workflow. Pending release notes become a reviewed release pull request; `npm:prepare`, `npm:consumer` and `npm:plan` qualify and inspect release artifacts. Registry publication follows a merged release only after Public quality passes and the `npm` environment is approved.

The successor selects npm package, native-system and language-archive versions independently. The syntax version remains 1.0. Public mechanism references cover installed captured reads and explicit spec body capture. No local check establishes production host activation.
