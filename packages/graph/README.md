# @ia/graph

The pure graph layer consumes compiled IA records and an explicit registry. [SPEC.md](SPEC.md) owns behavior and implementation status. The package provides immutable graph construction, reach/phase authority resolution, occurrence and relationship indexes, a derived typed field-reference index kept apart from the edges, revision hashing, and coordinate/dimension validation. Conditions, selectors, variant and cell selection, and scoped breadth-first traversal consume those products. search(graph, text, scope) ranks decoded content using BM25 with scope-local statistics.

The package depends on @ia/language and uses node:crypto only for deterministic SHA-256. It performs no filesystem I/O, clock reads, source parsing, cache publication or model/tool execution. Decoded prose search is implemented here; IA lexical analysis stays in language.
