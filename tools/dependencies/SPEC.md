# dependencies tooling contract

## Purpose

Discover component imports and enforce the explicit package/host dependency policy.

## Modules

- [check.test.ts](check.test.ts) — behavior and refusal coverage.
- [check.ts](check.ts).

## Commands

- `pnpm dependencies:check`: `node --import tsx tools/dependencies/check.ts`.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Package/app/native-system manifests and every scanned source file, including new files; TypeScript syntax trees resolve literal imports and require forms.

## Outputs

Read-only findings and nonzero status; never rewrites package manifests.

## Prerequisites

Pinned TypeScript installation, source tree only.

## Validation

Task ownership: `tools:test-dependencies`, `dependencies:check`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

Unlisted component policy and prohibited imports refuse. Adding a file or changing a dependency manifest invalidates the gate through dependency-policy inputs.

## Limits

This repository architecture policy is not a generic language restriction; dynamic loading requires the explicit supported patterns.

## Detailed behavior

PT5 adds `@inventarch/authoring-system` with public db/language/runtime dependencies. Composition imports that owner for scoped engine draft tools. Distribution has an explicit additional host dependency on authoring-system for identical contextual formatting; no foundation package imports this upper owner. Source-relative Stage E wrappers remain repository tooling and delegate to the public package.

Distribution PT2b exception: `@inventarch/distribution` may import public language, graph, db and workspace-runtime APIs, alongside its authoring dependency. Graph supplies the shared canonical digest codec (`canonical`, `digest`, `copy`, `CodecError`) used by release assessment; the session package re-exports `CodecError` and wraps the functions so they refuse with its `SessionError` subclass, and no longer needs to be imported for the codec. Distribution owns host publication and explicit-root consumer commands; foundation packages cannot import the distribution app. Its package manifest declares every such installed dependency. This exception does not broaden other hosts.

PT4 adds the pure `@inventarch/template-system` owner with public language/runtime dependencies. Composition may import template-system for scoped captured rendering; template-system cannot import composition or the distribution app. The installed composition manifest declares that dependency, so both development and emitted consumers load the same owner implementation.

Owns enforcement of the package dependency directions below. Runtime source under packages/*/src, apps/*/src and .ia/src/systems/*/src is parsed as TypeScript to inspect import/export declarations, inline import types, import-equals, require calls, dynamic imports and module resolutions (`import.meta.resolve`, `require.resolve`, and `createRequire(import.meta.url)` calls and their `.resolve`). A resolution names an installed dependency exactly as a load does, and a nonliteral one fails closed like a nonliteral load; a `createRequire` anchored at another location resolves through that location's own declared dependencies, so it is not an edge of the calling package. Internal dependencies in package manifests and source must follow the explicit allowed package map. An allowed cross-package `@inventarch/*` source import must also be declared in dependencies, optionalDependencies or peerDependencies; a hoisted development dependency cannot qualify an installed package. Relative imports may not cross a package boundary, even to a permitted dependency; use its public package name. Unknown @inventarch packages and nonliteral runtime module loads fail closed. Test/build tools outside runtime src are composition roots and are not constrained by this runtime map.

The foundation map admits language → none, graph → language, compliance → language + graph, db → language + graph + compliance, and runtime → language + graph + db. The generic workspace-runtime owner admits language, graph, db, runtime, compliance, agent-system, session-system, template-system and authoring-system. The composition system may import those owners and workspace-runtime, with no reverse import from workspace-runtime. Session imports graph for the canonical codec; agent may import session, runtime, language, graph and db. The other native system rows declare no cross-package runtime imports. Service contracts may import only their own modules and Zod.

Host rows are explicit. Runner admits agent-system, session-system, agent-composition-system, workspace-runtime, runtime and db. Distribution admits language, graph, db, authoring-system, workspace-runtime and steward-hook. Steward-hook admits runtime, db and workspace-runtime. CLI admits runtime, workspace-runtime, db, distribution and compliance. MCP door admits runtime and service-contracts. Other apps use the runtime-only default. No foundation owner gains a reverse host dependency.

The exact allowlist is in [check.ts](check.ts). Add a new system package only with its owning spec's dependency decision. The checker reads files and reports errors without changing them. It does not prove arbitrary program behavior or police dynamic code evaluation. Tests exercise every supported import form, manifests and cross-package escapes. Root test/build run the repository check; typecheck includes its implementation and tests. TypeScript/build and isolated package consumers separately verify actual public export resolution.

Nonliteral module loads are refused in every runtime source, including development producer paths. A literal import of `@inventarch/monorepo-kit-host` or its `/development` capability is permitted only for a CLI host with that package declared as an installed dependency. Other owners and private subpaths remain refused. Synthetic fixtures exercise these restrictions without depending on a private producer implementation.
