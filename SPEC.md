# IA repository contract

Owns the public workspace and its normative [language reference](docs/reference/language/SPEC.md). The native kernel and system schemas define the language; package contracts define compiler, graph, persistence, composition and host behavior. Vocabulary does not include curated expert methods or hosted marketplace policy.

The CLI, runtime and every other public npm package share the coordinated release version selected in [releases/current.json](releases/current.json). The public native systems and bundled language archive align to that version at each breaking npm major and otherwise change version only with their own content. Native source syntax remains `#! ia 1.0`; syntax, schema, format, engine and protocol numbers retain their own compatibility meaning. The optional [product-structure distribution](distributions/product-structure/SPEC.md) is separate from the canonical language.

`pnpm platform:qualify` is the repository qualification entry point. Build, type, conformance, documentation and emitted-resource checks qualify their exercised scope. Package publication, repository hosting, registry ownership and platform coverage require their own evidence; a local passing build does not establish those external facts.

Public npm packages use the `@inventarch` scope. The [publishing guide](tools/distribution/NPM-PUBLISHING.md) describes the npm 12 release toolchain, first-package setup and the GitHub OIDC workflow. Pending release notes become a reviewed release pull request; `npm:prepare`, `npm:consumer` and `npm:plan` qualify and inspect release artifacts. Registry publication follows a merged release only after Public quality passes and the `npm` environment is approved.

The successor selects one npm version; public native-system and language-archive artifacts align to it at each breaking major and otherwise keep their own versions. Artifacts 3.x continue to use syntax 1.0; they introduce no language syntax migration. Public mechanism references cover installed captured reads and explicit spec body capture. No local check establishes production host activation.
