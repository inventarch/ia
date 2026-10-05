# Tool entry check

`is-entry.mjs` exports `isEntry(argv1, moduleUrl)`, which every tool with a command-line entry block calls as
`isEntry(process.argv[1], import.meta.url)`. It is the same function as `isEntry` in `@inventarch/runtime/entry`, which the
package binaries use: the invoked path is compared first and real paths only when it misses, because Node loads an entry
from its real path, so a tool started through a link to the checkout or to one of its directories still runs. A path
that names no file (missing, through a file, or a name too long) is not the entry; any other failure to resolve one
throws.

It imports only Node built-ins and lives in its own directory, so a tool that imports it gains this directory's production
files as task inputs, not the runtime and its dependencies. `is-entry.d.mts` types it for the
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

## Package-manager launcher contract

`package-manager.mjs` supplies `packageManagerCommand(launcher, args, nodePath?)` for callers that receive pnpm through `npm_execpath` or an explicit tool path. A regular file with a native PE, ELF or Mach-O header runs directly, including an extensionless binary. JavaScript entry files and Node-shebang wrappers run through the selected Node executable. Unsupported or missing launchers refuse; batch/shell strings are not interpreted. Paths and every argument remain separate argv entries, including spaces and shell metacharacters. The helper neither spawns nor changes cwd, environment, timeout, stdio, pnpm version or package-manager configuration. Callers retain those policies. This corrects the pnpm 12 native-binary boundary under the user-approved package-manager upgrade; old JavaScript pnpm and Corepack launchers remain supported.

The existing entry test task executes JavaScript and extensionless Node wrappers, invokes an actual native executable, observes nonzero child status and checks refusal of missing/nonregular/unknown launchers. Actual pnpm-version and qualification observations are retained separately from these generic launcher regressions.

Isolated pnpm consumers retain their exact archive dependency maps in `pnpm-workspace.yaml` overrides with only the consumer root selected. pnpm 12 ignores the old `package.json` location. Private staging moves the fully merged source security constraints, public archive pins and producer-scoped aliases into the workspace settings after constructing that map, before freezing the lock. Neither migration changes the selected archive identities. The physical temporary-directory initializer remains the first executable import for qualifiers that create fixtures.

The launcher regression uses Node built-in `spawnSync` with an explicit ten-second timeout for its fixed leaf Node programs. Its exact test path is a justified exception in the private direct-spawn ratchet. Importing the shared testing subprocess module here would create an Nx project edge even though dependency test bytes are excluded, making unrelated task-manifest edits invalidate every entry-helper consumer. The existing real Nx manifest mutation/restoration case qualifies this boundary without changing cache policy or task selection.
