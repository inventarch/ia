---
id: spec-kit-runtime
genre: spec
title: Kit runtime
status: implemented
created: "2026-11-08"
last-reviewed: "2026-11-08"
owners: [inventarch]
---

# Kit runtime

This specification is normative. It states how a method kit is laid out on disk, how a repository binds a kit's capability to an activity, what the kit's sidecar files declare, how lanes map to bindings, and what the MCP door returns for a lane. [`packages/runtime/SPEC.md`](../../../packages/runtime/SPEC.md) and [`apps/mcp-door/SPEC.md`](../../../apps/mcp-door/SPEC.md) defer to it and keep their package-specific detail. A kit is a folder of text sources. The language base it depends on is distributed separately (see the [registry](../registry/README.md)), and curated methods are supplied independently of the language (see [the hosted-service relationship](../../reference/hosted-service/README.md)).

The conformance reference is the `ia` plugin's resolver in the public marketplace repository: [`binding.mjs`](https://github.com/inventarch/marketplace/blob/main/plugins/ia/scripts/lib/binding.mjs), [`kit.mjs`](https://github.com/inventarch/marketplace/blob/main/plugins/ia/scripts/lib/kit.mjs), [`resolve.mjs`](https://github.com/inventarch/marketplace/blob/main/plugins/ia/scripts/resolve.mjs), [`check.mjs`](https://github.com/inventarch/marketplace/blob/main/plugins/ia/scripts/check.mjs) and [`on-write.mjs`](https://github.com/inventarch/marketplace/blob/main/plugins/ia/scripts/on-write.mjs). The runtime's `resolveMethod` follows `resolve.mjs` step for step, and the goldens in `apps/mcp-door/tests/fixtures/method` record the marketplace commit they were made from. Where this text and the reference disagree on an observable result, the disagreement is a defect to be settled in one of the two.

## 1 Kit layout

A kit is one folder. These parts are read:

| Path | Holds |
| --- | --- |
| `.ia/release.json` | The kit's id and version, its dependencies (a dependency other than `inventarch/language` names a kit id and a range) and its declared `assets` |
| `.ia/src` | The kit's records |
| `.ia/distributions.lock.json` | The language base the kit pins |
| `releases.json` | The recorded releases, with their archive and sources digests. Format 1 is one file; format 2 adds `releases/<version>.json` |
| `checks.json`, `delivery.json`, `bindings.json`, `onwrite.json` | The sidecars of sections 3 to 6 |

The recorded `sources` digest covers `.ia/`, the assets `.ia/release.json` declares and the sidecars. The reference also reads a fifth sidecar, `handlers.json` (session, prompt, tool and stop handlers). The runtime does not read it, and this specification does not define it.

Kits are found in an ordered list of sources:

1. a bundled folder of kit folders, named by `--kits` or `IA_KITS_DIR`;
2. the workspace's installed kits. The `package` entries of the workspace lock name kit releases that the engine installs as ordinary releases into `.ia/distributions/store/<archive>/`. The runtime verifies each against the lock (the `distribution.json` must hash to the pinned manifest digest and name the release, and each pinned file is checked against its SHA-256) and copies it to `<IA home>/installed-kits-v1/<archive>/`, with origin `installed`. A kit is never read from an npm package folder; npm is transport only;
3. `<IA home>/kits/<folder>/<version>/`, unless `IA_CORE_NO_HOME_KITS=1`.

A kit that a lock entry names is taken from no other source. When the store lacks it, resolution refuses `IA-CORE-KIT-RESTORE-REQUIRED` (run `ia restore`), though a pinned task may still read its retained bytes. A kit that no source provides refuses `IA-CORE-KIT-UNKNOWN`. A kit's records are read from a restored read root under `<IA home>/kit-roots-v1/` (or a cache the caller names), never from the shared temporary folder. A kit locked on a language base the runtime does not carry refuses `IA-CORE-CLI-UNSUPPORTED`.

## 2 Bindings

`<repository>/.ia/bindings.json` says which kit capability answers an activity in that repository. It is a repository file, distinct from a kit's own `bindings.json` (section 5).

```json
{
  "format": 1,
  "bindings": {
    "delivery.probe": { "kit": "inventarch/ia-authoring-kit", "capability": "authoring-probing-the-ia-toolchain" },
    "work.*": [{ "kit": "a", "capability": "x" }, { "kit": "b", "capability": "y" }]
  },
  "precedence": ["inventarch/ia-authoring-kit", "inventarch/ia-method-kit"],
  "defaults": { "knowledge": { "kit": "inventarch/ia-kb-kit", "capability": "kb-knowledge" } }
}
```

- The file must be JSON with `format` 1 and a `bindings` object, or reading it fails `IA-CORE-BINDINGS-MALFORMED`. A repository without the file has no bindings.
- A key is `<entry>.<activity>`, matching `^[a-z]+\.(?:[a-z][a-z0-9-]*|\*)$`. The entries (lanes) are `work`, `delivery` and `knowledge`. The retired entry `development` is refused with the name to write instead (`delivery`), never read as another entry.
- A binding is `{kit, capability}` with an optional `profile`. A key holds one binding or a list of candidates.
- Selection for `<entry>.<activity>` takes the first that applies: the exact key, then `<entry>.*`, then `defaults.<entry>`. The result records how it was chosen (`exact`, `wildcard` or `default`).
- Several candidates for the chosen key are a conflict unless `precedence`, a list of kit ids in which the first wins, orders them. Candidates that precedence does not rank, or two that tie, refuse `IA-CORE-CONFLICT`. A successful ranking is reported as `<via>+precedence`.
- With nothing bound, selection refuses `IA-CORE-NO-METHOD`. Nothing is bound on the person's behalf.

## 3 Checks sidecar

`checks.json` is `{format: 1, checks: {<name>: {argv, cwd?, record?, timeout?, arguments?}}}`. `argv` is a non-empty list of strings and is run without a shell. `cwd` is `workspace` (default), `kit` or `plugin`. `timeout` is a positive integer of seconds (default 600). A name that is not also a `@check` record of the kit is dropped and reported as undeclared. The tokens `${IA}`, `${NODE}`, `${WORKSPACE}`, `${KIT}` and `${PLUGIN}` are substituted, and an argument slot declared in `arguments` is filled by name.

The reference checker runs one declared check by name and nothing else. It picks the kit from `--kit`, else the task's pin, else every kit the repository's bindings name, else the installed kits, and an undeclared name refuses `IA-CORE-CHECK-UNKNOWN`. Only a trusted kit runs a check: another kit's check is refused with `IA-CORE-KIT-UNTRUSTED` and runs nothing. A check runs with an allowlisted environment, its process tree is killed at its deadline, and its output is bounded and kept as evidence.

## 4 Delivery sidecar

`delivery.json` is `{format: 1, whole: [<capability name>, ...]}`. A capability listed in `whole` is a procedure: the resolver delivers every cell of its playbooks, whatever the position returns at the seat. Otherwise the resolver delivers the playbook cells the position delivers. A listed name that is not a `@capability` record of the kit is dropped and reported as undeclared. Without the file no capability is whole.

## 5 Kit bindings sidecar

A kit's own `bindings.json` is `{format: 1, recommend: {"<entry>.<activity>": {capability, profile?}}, unbound?: [<capability name>, ...]}`. `recommend` is what the kit suggests a repository bind. The core applies nothing by itself, and a recommendation is written to the repository's bindings only on an explicit apply. `unbound` lists the capabilities that may be resolved outside a workspace; when it is absent every capability may be. A key or name whose capability (or profile) is not a record of the kit is dropped and reported as undeclared.

## 6 On-write sidecar

`onwrite.json` is `{format: 1, onWrite: [{name, extensions, marker?, maxDepth?, argv, timeout?}]}`. An entry matches a written file when the file name ends in one of its extensions (compared without case) and, if a `marker` file name is given, that file exists in the written file's folder or in one of the `maxDepth` folders above it (default 12, at most 64). A match runs `argv` (`${NODE}`, `${KIT}` and `${PLUGIN}` only) with the hook payload on stdin. `timeout` is a whole number of seconds from 1 to 25 (default 20). The `additionalContext` the command answers with is handed to the session, at most 8,000 characters in all. The reference hook only reads and never blocks: an error, a timeout, or output that is not a hook answer is dropped. Only a trusted kit's commands run.

## 7 Lanes and scope

A lane is one of `work`, `delivery` or `knowledge`. An activity states a shape and a phase to the position. An activity the table does not name takes its lane's default, and an explicit shape or phase overrides either.

| Lane | Default | Named activities |
| --- | --- | --- |
| `work` | governance, plan | task, decision (governance, plan); dependencies (sequence, plan); delegation (execution, act); progress (context, orient); completion (learning, learn) |
| `delivery` | execution, act | understand, diagnose (context, orient); design (governance, plan); change (execution, act); review, deliver (learning, learn) |
| `knowledge` | context, orient | find, explain, packet (context, orient); place (governance, plan); reconcile (learning, learn); maintain (execution, act) |

Lanes, keys, words and phases are closed tokens. A subject is carried as the caller gives it and never reaches a position; the packet and the pin keep only `sha256:<hex>` of it.

The lane catalogue lists, for one lane, the keys that available kits recommend (section 5) and the capabilities they declare whole (section 4), each with its kit, version, capability, description and state.

## 8 The packet and the pin

Resolution reads the repository's binding, then the task's pin, then the kit's read root, then the position for the lane's scope, then the capability's playbooks, checks and effects, and assembles a packet. The packet's `digest` is the SHA-256 of its sorted-key canonical form, with the envelope and the binding excluded, so the same inputs give the same digest on every host.

Task pins live under `<IA home>/work-v1/<project>/<task>/`. Pins are format 3; format 1 is read as format 3. The exact method bytes are retained under the closure store, so a pinned task reads them even when the kit is no longer installed.

## 9 The door contract

The MCP door exposes the method lanes through three tools: `ia_session`, `ia_catalogue` and `ia_method`. They take structured input only. These rules bind them:

- Each takes an optional absolute `root`. It must be the launch root or a row of `<IA home>/workspace-locations.json`, or the call refuses `IA-CORE-ROOT-UNREGISTERED`. A root holding `.ia/src` must open, and its governing mandates must admit the read mode for the default actor.
- `ia_method` returns the packet the reference resolver prints, field for field and with the same digest, for the same consumer, bindings, kit bytes, carrier and task. Only the envelope differs: `host` is `mcp-door` and `cliSource` is `in-process`.
- A `task` pins under `<IA home>/work-v1/<project>/<task>/`, where the project is the workspace folder's name as a slug. The reference takes its project from the caller; the door derives it.
- When the bundled folder is a plugin's `config/kits`, that plugin's `scripts/` and support files are the carrier whose digest and retained bytes the pin covers, so a pin written by either reader verifies in the other.
- `ia_session` at a workspace whose installation needs restoring (a fresh clone of a committed lock) opens with no workspace instead of refusing, and adds a `restore` field and a briefing line that says to run `ia restore`.

## 10 Not specified here

This specification does not define `handlers.json`, the hosted services that supply curated methods, or the contents of the language base. Nothing in it grants authority: a binding or a check selects what runs, and the governing mandates still decide whether a move is allowed.
