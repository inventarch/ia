# Public language reference

This directory owns the public normative vocabulary index and shared authoring guide. `vocabulary.json` and `vocabulary.md` are generated from the explicit public corpus, canonical schemas and per-word descriptions by `tools/native/public-vocabulary.ts`. `pnpm vocabulary:check` refuses drift. The source digest covers the ordered input paths, text and authority metadata, rather than Git history.

The reference describes language admission and generic consumers. It does not distribute expert design methods, establish that prose is correct, or attest evidence. The independently authored conformance examples live in [public-language](../../../examples/public-language/SPEC.md). The [repository contract](../../../SPEC.md) defines the release and qualification scope.
