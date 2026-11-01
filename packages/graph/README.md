# @inventarch/graph

[![npm](https://img.shields.io/npm/v/@inventarch/graph?label=npm)](https://www.npmjs.com/package/@inventarch/graph) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.22.0%20%3C23-brightgreen)](package.json)

> The typed graph over compiled IA records. It chooses the winning occurrence of each identity, resolves references, rechecks relationship consent, and lets you traverse relationships, inspect claims, conditions and record digests, and search record text.
>
> It sits between [`@inventarch/language`](../language/README.md), which compiles the records, and [`@inventarch/compliance`](../compliance/README.md), which checks the graph.

## ⚡ Quick start

```sh
npm install @inventarch/language @inventarch/graph
```

```js
import { buildRegistry, compile, KERNEL_DIGEST, KERNEL_SOURCES, LANGUAGE_VERSION, parse } from '@inventarch/language';
import { directedView, load } from '@inventarch/graph';

// The caller supplies every input; this example loads the language floor that the language package embeds.
const location = { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' };
const sources = KERNEL_SOURCES.map((source) => ({ ...source, location }));
const parsed = sources.map((source) => ({ ...parse(source.text, source.path), location }));
const { registry } = buildRegistry(parsed);
const records = parsed.flatMap((source) => compile(source.ast, registry, location, []).records);

const graph = load(records, registry, {
  sources,
  languageVersion: LANGUAGE_VERSION,
  kernelDigest: KERNEL_DIGEST,
  location: '',
});
console.log(graph.diagnostics.length); // 0

for (const row of directedView(graph, 'floor/contract/head/kernel-phase'))
  console.log(row.kind, row.spelling, row.counterpart);
// inverse grounded-by floor/definition/system/taxonomy
```

`load` reads nothing itself: it takes compiled records, the registry that compiled them and the revision inputs. `options` holds the revision inputs (`sources`, `languageVersion`, `kernelDigest`), the view `location` and an optional `phase`. Every record's source must be in `sources` at the same placement and provenance; otherwise `load` throws a `TypeError`. To read a workspace on disk, use [`@inventarch/db`](../db/README.md), which discovers the sources and builds the graph.

## 🧭 What it does

| Area | Exports |
| --- | --- |
| Load | `load(records, registry, options)` returns an immutable `Graph`: one winner per identity (the highest band; a tie at that band refuses every tied occurrence), shadows, resolved and dangling edges, indexes and diagnostics. `serialize(graph, limit?)` writes it in a stable order that input order does not affect, and past a limit writes nothing. `load` remembers what it makes only of what `frozen(value)` made, which nothing can change: pass frozen records and a frozen registry to share nodes across graphs. |
| Resolve | `resolve(reference, pool, registry)` returns `{ ok: true, identity, fragment? }`, or `{ ok: false, code }` with `IA-GRAPH-TARGET-MISSING` or `IA-GRAPH-TARGET-AMBIGUOUS`; candidate order never breaks a tie. |
| Relationships | `directedView(graph, identity)` lists every relationship from that record's side, declared or derived inverse, plus typed field references. `traverse(graph, options)` walks breadth-first from `start` identities. It follows the verbs in `follow` (any kernel spelling), or every edge in `direction` (`out`, `in` or `both`, the default), to a `depth` of 0 to 8 (default 1), with optional `scope`, `filter` and `coordinate`, and `maxNodes`/`maxEdges` bounds that mark a result `truncated`. |
| Claims | `claimants(graph, path, scope?)` names the records whose path selections in `CLAIM_FIELDS` (`authority.covers`, `subject.covers`, `work.covers`, `hook.paths`, `check.covers`) select a path. `selects(selection, path)` and `isSelection(selection)` implement the one path-selection dialect. |
| Conditions | `validateCoordinate`, `conditionHolds`, `selectors`, `variants`, `cell`, `effectiveSeverity` and `laneOf` evaluate conditions, selector groups and variant and cell selection for a coordinate. |
| Search | `search(graph, text, scope?)` ranks decoded record text with BM25, computing its statistics over the allowed scope only. The index holds at most 1,048,576 postings, and a search finds nothing of what it did not take ([SPEC G11a](SPEC.md)). |
| Revisions and digests | `revisionOf` hashes the sources, registry, language version and kernel digest. `authoredRevisionOf` leaves out sources at runtime placement, so runtime-band evidence does not move it. Each node carries `digest` from `recordDigest(record)`, which covers what a record says, not where it was read. |
| Canonical JSON | `canonical`, `digest` and `copy` give byte-stable canonical JSON and its SHA-256. Each refusal is a `CodecError` with a stable `code`. |
| Paths | `canonicalRoot(root)` normalizes a corpus-relative reach or view root, and `reaches(reach, location)` says whether a reach covers a location. |

Load diagnostics use the `GRAPH_CODES` (`IA-GRAPH-*`). Invalid query input, such as an unknown coordinate value or a traversal depth outside 0 to 8, throws `GraphUsageError`. The `./internal/*` subpaths are published for IA's own toolchain; use the root entry point.

## ⚖️ What it does not do

- **No I/O or execution.** It reads no files, clock or default registry, parses no source text, keeps no cache and calls no model or tool. It depends only on `@inventarch/language` and uses `node:crypto` for SHA-256.
- **A dangling reference is not a pass.** It stays a warning edge (`IA-GRAPH-TARGET-MISSING`). A fragment is kept but not checked; [`@inventarch/compliance`](../compliance/README.md) decides whether the cell or requirement it names exists.
- **Derived rows are views.** An inverse row from `directedView` is never written back to source or merged into `edges`.
- **A claim is not an edge.** It carries no predicate and grants nothing. A `@check`'s `check.scope` never claims a path.
- **A truncated traversal is not the whole graph.** Report a `truncated` result as partial.
- **No scopes or packets.** Scope tokens and caches belong to [`@inventarch/db`](../db/README.md), and position views and host packets to [`@inventarch/runtime`](../runtime/README.md).

## 📚 Learn more

- [SPEC.md](SPEC.md): the package contract (G01 to G13), including the directed view, claimant index and canonical codec
- [LANGUAGE.md](LANGUAGE.md): the packaged summary of the words this release ships
- [Architecture reference](../../docs/reference/architecture/README.md#which-package-to-use)
- Neighbours in the dependency direction: [`@inventarch/language`](../language/README.md) before it; [`@inventarch/compliance`](../compliance/README.md) and [`@inventarch/db`](../db/README.md) after it
- [Root README](../../README.md)
