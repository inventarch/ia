# entry tooling contract

## Purpose

Identify real executable entries and construct argv-safe package-manager invocations.

## Modules

- [is-entry.d.mts](is-entry.d.mts) — generated from the checked JavaScript implementation.
- [package-manager.d.mts](package-manager.d.mts) — generated from the checked JavaScript implementation.
- [is-entry.mjs](is-entry.mjs).
- [is-entry.test.ts](is-entry.test.ts) — behavior and refusal coverage.
- [package-manager.mjs](package-manager.mjs).

## Commands

No public pnpm entry; callers import the modules or use the manual contract below.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

An invoked path, module URL, launcher bytes and argv; filesystem identity and Node executable.

## Outputs

Returns identity/invocation data; it does not spawn, install or write files.

## Prerequisites

Node built-ins only; no installation or dist output.

## Validation

`node tools/testing/check-declarations.mjs --check` compares generated declarations with checked implementations; `--write` regenerates them. The shared contract suite runs this drift check. Package test configurations may keep JavaScript inference disabled and consume these generated declarations.

Task ownership: `tools:test-entry`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Missing entry paths return false; other resolution failures throw. Native binary and Node script launchers are accepted; shell/batch wrappers refuse. Paths with spaces remain individual arguments.

## Limits

Header recognition establishes executable format, not executable trust. Callers choose trusted launchers and own timeouts.

## Detailed behavior

`is-entry.mjs` exports `isEntry(argv1, moduleUrl)`, which every tool with a command-line entry block calls as
`isEntry(process.argv[1], import.meta.url)`. It is the same function as `isEntry` in `@inventarch/runtime/entry`, which the
package binaries use: the invoked path is compared first and real paths only when it misses, because Node loads an entry
from its real path, so a tool started through a link to the checkout or to one of its directories still runs. A path
that names no file (missing, through a file, or a name too long) is not the entry; any other failure to resolve one
throws.

It imports only Node built-ins and lives in its own directory, so a tool that imports it gains this directory's production
files as task inputs, not the runtime and its dependencies. JSDoc and `tsconfig.tools-js.json` check its implementation for TypeScript consumers;
`tools/distribution/host-payload.mjs` imports it directly.

`is-entry.test.ts` (task `tools:test-entry`) covers the function and fails while any source file under `apps/`,
`packages/`, `tools/` or `.ia/src/` still has the old check's spelling, `resolve(process.argv[1]) === .`, which never
matched through a link. Other spellings of that comparison are not caught. It also compares this directory's function
body with `packages/runtime/src/entry.ts`. Its task hashes the whole repository for that reason.

## Package-manager launcher contract

`package-manager.mjs` supplies `packageManagerCommand(launcher, args, nodePath?)` for callers that receive pnpm through `npm_execpath` or an explicit tool path. A regular file with a native PE, ELF or Mach-O header runs directly, including an extensionless binary. JavaScript entry files and Node-shebang wrappers run through the selected Node executable. Unsupported or missing launchers refuse; batch/shell strings are not interpreted. Paths and every argument remain separate argv entries, including spaces and shell metacharacters. The helper neither spawns nor changes cwd, environment, timeout, stdio, pnpm version or package-manager configuration. Callers retain those policies. This corrects the pnpm 12 native-binary boundary under the user-approved package-manager upgrade; old JavaScript pnpm and Corepack launchers remain supported.

The existing entry test task executes JavaScript and extensionless Node wrappers, invokes an actual native executable, observes nonzero child status and checks refusal of missing/nonregular/unknown launchers. Actual pnpm-version and qualification observations are retained separately from these generic launcher regressions.

Isolated pnpm consumers retain their exact archive dependency maps in `pnpm-workspace.yaml` overrides with only the consumer root selected. pnpm 12 ignores the old `package.json` location. The exact archive pins preserve the selected package identities. The physical temporary-directory initializer remains the first executable import for qualifiers that create fixtures.

The launcher regression uses Node built-in `spawnSync` with an explicit ten-second timeout for its fixed leaf Node programs. Importing the shared testing subprocess module here would create an Nx project edge even though dependency test bytes are excluded, making unrelated task-manifest edits invalidate every entry-helper consumer. The existing real Nx manifest mutation/restoration case qualifies this boundary without changing cache policy or task selection.
