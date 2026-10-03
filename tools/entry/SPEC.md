# Tool entry check

`is-entry.mjs` exports `isEntry(argv1, moduleUrl)`, which every tool with a command-line entry block calls as
`isEntry(process.argv[1], import.meta.url)`. It is the same function as `isEntry` in `@inventarch/runtime/entry`, which the
package binaries use: the invoked path is compared first and real paths only when it misses, because Node loads an entry
from its real path, so a tool started through a link to the checkout or to one of its directories still runs. A path
that names no file (missing, through a file, or a name too long) is not the entry; any other failure to resolve one
throws.

It imports only Node built-ins and lives in its own directory, so a tool that imports it gains this directory's three
files other than the test as task inputs, not the runtime and its dependencies. `is-entry.d.mts` types it for the
TypeScript tools; `tools/distribution/host-payload.mjs` imports it directly, and so does
`tools/release/private-lock.mjs`, which the public export leaves out. `tools/distribution/assemble-host.mjs`, also left
out of the public export, keeps its own copy instead: three qualifiers copy that file alone into a consumer, where no
checkout file can be imported.

`is-entry.test.ts` (task `tools:test-entry`) covers the function and fails while any source file under `apps/`,
`packages/`, `tools/` or `.ia/src/` still has the old check's spelling, `resolve(process.argv[1]) === …`, which never
matched through a link. Other spellings of that comparison are not caught. It also fails when this directory's copy, or `apps/folio/src/main.ts`'s where the tree carries folio, is not the same function body as `packages/runtime/src/entry.ts`'s. Its task hashes the whole repository for
that reason. `tools/distribution/assemble-host.test.ts` (task `tools:test-distribution`, in the private tree only) loads
`assemble-host.mjs` copied alone, runs that copy through a directory link, and fails if its copy of `isEntry` is not
the same text as this directory's, whose cases then cover it.
