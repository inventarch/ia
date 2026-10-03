# Descriptor codecs and compilers

**Status (2026-09-28, LK-17): producer implemented; words unregistered.** This folder is the pure producer half of spec-0009 (OS09). The public `@inventarch/db/descriptors` export decodes and compiles `domain-model`, `storage-binding` and `app-composition` resources. Storage adapters, migration proposals and tenancy belong to the API (LK-18). Installed app consumers and the two hosts belong to ia-apps (LK-19). Nothing here is acceptance evidence for those tasks.

The module has no I/O, clock, network, DDL or code execution. Compilers read only the values they are given: an envelope, the resource text the host disclosed, and a registry built by `createDescriptorRegistry`. They return frozen results.

## Placement decision

The producer lives in `@inventarch/db`, as a subpath beside `@inventarch/db/distribution`, for three reasons:

- It reuses the strict JSON transport that the distribution codec already uses. That parser now lives in [`../json.ts`](../json.ts), with the distribution messages unchanged.
- `@inventarch/db` owns native admission, and envelopes come from admitted records.
- It is an existing public package, so the release export already publishes it.

`@inventarch/service-contracts` is not suitable, because it may import only Zod and cannot hash. `@inventarch/compliance` cannot import the parser, because `@inventarch/db` depends on it. A new package would need new release, lock and schedule machinery for a slice this small. Catalog owners S07 and S09 do not need to become native systems (spec-0005 §4).

## Registration (ALIGN-06)

The three words are **not registered** in any active source. Registration has to wait until the schema, the guide and the executable consumers land together. The LK-19 app consumer and the LK-18 storage consumer have not landed. The candidate registration lives only in [`fixtures/descriptors/native/`](../../fixtures/descriptors/native). That folder holds a `descriptor-candidate` system and steward, the three schemas, five envelope records and two fixture capabilities. [The descriptor test](../../tests/descriptors.test.ts) admits them through `ReadHandle.preview` over the real native tree. The overlay stays in memory: no source, cache or scope changes. The same test asserts that no active `.ia/src` file registers any of the three words. The candidate words reuse the existing taxonomy: `definition`/`representation` for the model and the app, and `binding`/`relation` for storage. The parser, the taxonomy and the vocabulary are unchanged, and no synonym words are introduced (ALIGN-07).

## Envelope schemas (candidate)

Each record requires `meaning.says` and `meaning.answers`, plus its owned section. Sections are closed, and `relationships` is optional.

| Word / section | Field | Native type |
| --- | --- | --- |
| domain-model / model | format, version, resource, digest | number, text, text, text |
| storage-binding / storage | format, model, model-version, port, adapter, schema-version, resource, digest | number, ref to domain-model, text, id, id, text, text, text |
| app-composition / app | format, app-id, version, resource, digest, capabilities | number, id, text, text, text, list of ref to capability |

`envelopeFromRecord(record)` reads the owned section of an admitted record into a `DescriptorEnvelope`: `{ kind, owner, source, fields }`. A ref keeps its canonical `@discriminator name` text. The compilers then check that:

- `format` is exactly `1`;
- versions are exact SemVer;
- `port`, `adapter` and `app-id` are native ids;
- `digest` is `sha256:<64 hex>`;
- `resource` is a same-envelope relative `.json` key, never a URL, an absolute or drive path, a dot segment or an import;
- `source` is a record path inside the owner's system: `.ia/src/systems/<owner system>/…`, optionally below a verified installed store `.ia/distributions/store/<digest>/`. Each segment uses only `A-Z a-z 0-9 . _ -`, so control, bidi and separator characters never reach compiled output or diagnostics.

Compiler inputs are read once. Each input field must be a data property of a plain, non-proxy object. The envelope, the disclosed resource map and the public allowlist are then copied as plain data: accessors, proxies, functions, symbols, class instances, cycles, an own `__proto__` key, and arrays that are not exactly indices `0`..`length-1` (holes or extra keys) all refuse. Excess depth or size also refuses; an array's length and an object's key count are checked before any property is read. Copies of objects have a null prototype, so no later read can reach `Object.prototype`. So a getter cannot change `source` or a resource between a check and its use. Missing permission (DESC-01) means absence: a resource the host did not put in the disclosed map refuses as `DESC-RESOURCE-UNDISCLOSED`.

A resource-contained ID is data, not a native graph edge. `CompiledDomainModel.references` lists cross-model references as explicit `{model, entity, version}` mappings. The model ID is the owner qualifier: a domain resource's `model` must equal its owning record's name, so `{model, version}` names exactly one owner record per workspace. Adding a system-qualified owner to cross-model references is a future format change.

## Resource codec

- **Transport.** UTF-8 JSON, at most 1 MiB and 200,000 values. The depth limit counts containers: 16 nested objects/arrays with scalar leaves are admitted, and a 17th refuses. Non-string input, duplicate keys, trailing content, non-finite numbers and malformed text all refuse before any schema decoding. The strict parser is shared with the distribution codec, which keeps its own per-value depth rule.
- **Numbers.** Every number is a safe integer. Exact decimals are strings, as the `decimal` scalar requires.
- **Canonical digest.** `sha256:` followed by the hex SHA-256 of the canonical JSON. Keys are sorted by UTF-16 code unit, with no whitespace. For this value domain the result equals RFC 8785, so insertion order and formatting never change the digest. `decodeDescriptorResource(text)` returns `{ value, canonical, digest }`. The envelope digest must equal the canonical digest of the disclosed resource. No Unicode normalisation is applied, consistent with RFC 8785: two differently normalised spellings are two different resources. The canonical helpers are internal; hosts digest resource text only through `decodeDescriptorResource`.
- **Executable content.** Three rules, each linear in its input:
  - Keys. `import`, `module`, `component`, `script`, `code`, `expression`, `eval`, `function`, `handler`, `css`, `style`, `class-name`, `sql`, `ddl`, `url`, `href` and `src` refuse wherever they appear, with `DESC-EXECUTABLE-REFUSED`. The secret keys `password`, `secret-value`, `credential`, `token`, `api-key` and `private-key` refuse with `DESC-SECRET-REFUSED`. This scan runs after the format check.
  - Identifier and reference positions (ids, `id@major` contract references, storage ids). The closed readers already refuse anything else there. An invalid value of at most 4,096 characters is reported as `DESC-EXECUTABLE-REFUSED` when it looks like a URL scheme, a relative or absolute path, a `javascript:`/`data:` URI, a `require`/`import`/`eval` call, an arrow function, a `${` template, a script tag or a `.js`/`.ts`/`.css`/`.wasm` file. Otherwise, or when longer, it is `DESC-FIELD-INVALID`.
  - Display text (screen `title`, string configuration `default`) is length-bounded first. It refuses only a leading `javascript:`/`data:`/`vbscript:` scheme directly followed by a non-space character (`javascript:alert(1)`, `data:text/html,…`), a script tag or a `${` template. "Data: overview" is allowed. Titles such as "Install Node.js", "Orders => Archive" or "import (legacy)" are allowed: hosts render display text as text, never as code.

  These lists are heuristics, not a sandbox. The guarantee comes from the closed shapes and the trusted registry, not from the patterns. A pattern may be changed when a reviewed false positive or false negative justifies it.
- **Collections.** Every list and layout object holds at most 1,000 entries. Names are unique within their collection.
- **Format and features.** Each resource checks `format` before its closed shape, so a newer major version refuses as `DESC-FORMAT-UNSUPPORTED`. `features` must be empty in v1. Any listed feature refuses rather than being ignored.

### domain-model v1

`{ format, model, version, features, values, entities, commands, queries, invariants }`

- `model` must equal the record name, and `version` must equal the envelope version.
- A value type is `{ name, type: <scalar> }`.
- A scalar is one of: `string` with `max-length`; `boolean`; `number` with integer `minimum`/`maximum`; `decimal` with `precision` and `scale`; `timestamp`; or `enum` with unique `values`.
- An entity is `{ key, id: { field, codec: uuid|text|integer }, fields }`. The ID field is required, and its scalar must match its codec.
- A field is `{ name, required, type }`. Its `type` is a scalar, `{ value }` or `{ reference: { model, entity, version }, cardinality: one|many }`. A same-model reference must name an entity of this exact version.
- Commands and queries are `{ name, contract, input, output, error }`. Each resolves as `id@major` to a trusted `command`/`query` contract, and all three schema references must equal the contract's own.
- Invariants are `{ name, validator, entity, required }`. An unknown required validator refuses. An unknown optional validator compiles as `status: "unavailable"`.
- The result reports `evaluation: { structural: "compiled", invariants: "not-evaluated" }`. Compilation never evaluates business rules. Ownership, tenancy and authorization are never inferred from model text (DOM-01).

`classifyModelChange(previous, next)` records both versions and digests, and classifies each change (DOM-02 producer half). Field types are compared after resolving named value types, so changing `money` from precision 12 to 2 is a `type-changed` break. Each change names its subject (`entity`, `command`, `query` or `invariant`).

| Change | Classification |
| --- | --- |
| Optional field or entity added; requiredness relaxed; enum widened; command or query added; optional invariant added. Nothing else is compatible | compatible |
| Required field added; field or entity removed; requiredness tightened; enum narrowed; identifier changed; any resolved type change, including widening (for example decimal precision 12→14 or a larger `max-length`); command or query removed or changed (contract or schemas); invariant removed or changed; required invariant added | breaking |

The classifier proves no migration and rewrites no values.

### storage-binding v1

`{ format, model, model-version, model-digest, port, adapter, schema-version, transaction, isolation: { column }, entities, projections, migration-policy }`

`compileStorageBinding` needs the exact `CompiledDomainModel`. A different model, version or resource digest refuses with `DESC-SKEW`. The envelope must agree with the resource on `port`, `adapter` and `schema-version`. The following must resolve in the registry:

- `port` and `adapter`, as `id@major`. The adapter must implement that port version, support `transaction` (`entity`|`model`) and enforce isolation.
- `migration-policy`, as a `migration-policy` contract.

Mappings follow these rules:

- An entity mapping is `{ entity, store, fields: [{ field, column, codec }] }`.
- Every model entity with required fields must be mapped (`DESC-MAPPING` at `entities`). Identifiers are always required, so a binding maps the whole model, and required same-model references always target stored entities.
- Every required field of a mapped entity must be mapped.
- Codecs must match the field type: `text` for string and enum, `integer` for number, `numeric` for decimal, `boolean`, `timestamp`, `reference`, and the identifier's own codec for the ID field.
- The isolation column is supplied by the host at each operation and may not map a model field.
- Adapters are allowlisted registry IDs, never driver URLs.

The compiler emits no DDL, opens no connection and proposes no migration. Those are STORE-01/02 host duties (LK-18).

### app-composition v1

`{ format, app, version, features, targets, screens, navigation, actions, configuration, requirements }`

- **Envelope agreement.** `app` must equal both the record name and `app-id`.
- **Screens.** `{ name, title?, view, layout, queries, actions }`. `view` is a trusted `view` contract and `queries` are trusted `query` contracts. A layout key or value fault is attributed to `layout.<key>`. `layout` values are bounded integers, booleans or ids.
- **Actions.** `{ name, capability, operation, input, output, effect }`. Each capability must be one of the envelope's `@capability` refs. Input, output and effect must equal the trusted operation's.
- **Configuration.** `{ key, visibility: public|server, secret, default? }`. A secret entry is a reference only: a `default` value or `public` visibility refuses. `publicConfiguration` holds only the keys the host passes in `AppInput.publicConfiguration`, and allowlisting a server or secret key refuses.
- **Targets.** Each declared target profile compiles to `supported` only when every screen view, screen query and action operation is installed for it,, or to `unsupported` with typed diagnostics, and inspection continues either way. `activateTarget(app, profile)` refuses an unsupported or undeclared profile, and refuses any definition that `compileAppComposition` did not return (APPD-03).
- **Digests.** The result carries `digests.input` (the canonical envelope), `resource`, `registry` and `definition`, together with the required capabilities (APPD-02).

## Trusted registry

`createDescriptorRegistry({ format: 1, targets, contracts })` is the only source of trusted IDs. Every entry names:

- `kind`: command, query, validator, view, operation, port, adapter or migration-policy;
- `id` and `version`, where the version is the integer major;
- `implementation`, the `sha256:` digest of the installed code the host joined.

The kind decides the rest:

| Kind | Additional fields |
| --- | --- |
| command | input, output, error |
| query | input, output, error, targets |
| operation | input, output, effect, targets |
| view | targets |
| adapter | port, transactions, isolation |

The registry enforces three rules:

- Only plain, acyclic, bounded data is accepted (at most 32 levels and 200,000 values). Proxies, accessors, functions, symbols and cycles refuse as `DESC-REGISTRY-INVALID` without being invoked.
- An `id@version` is unique per kind.
- Every contract target must be a declared registry target.

The result is frozen and has a digest, and only the returned object is accepted. A copy of it refuses as `DESC-REGISTRY-INVALID`. When a reference does not resolve, the refusal code says why:

| Code | When |
| --- | --- |
| `DESC-CONTRACT-UNKNOWN` | No contract has the ID |
| `DESC-CONTRACT-VERSION` | The kind is installed, but not that major version |
| `DESC-CONTRACT-KIND` | A contract with that ID and version exists, but as another kind |

A registry never holds or loads code. It names what the host has already installed.

## Diagnostics and results

Every function returns either `{ ok: true, value }` or `{ ok: false, diagnostics: [one] }`. A refusal never includes a partial descriptor. Each diagnostic carries:

- `code` (`DESC-*`);
- `owner`, the native identity;
- `source`, the record path;
- `resource`, the key, when the fault is in resource data;
- `field`, a JSON-style path such as `entities[1].fields[3].codec` or an envelope `section.field`;
- a message bounded to 256 characters that never echoes values. `owner`, `source`, `field` and `message` are truncated to 256 UTF-16 units without splitting a surrogate pair.

Decoding order is fixed, so equal input gives an equal refusal (DESC-Q08).

## Fixtures and the installed consumer

[`fixtures/descriptors/`](../../fixtures/descriptors) holds:

- two domain models: commerce `orders` and library `lending`, which have different identifier codecs and a cross-model reference;
- the `orders-store` binding;
- two apps, `orders-desk` and `lending-kiosk`, which share the `list-view` contract;
- a trusted registry (`registry.json`);
- the envelopes extracted from the admitted candidate records (`envelopes.json`), and `expected.json`, the emitted compiled digests;
- [`consumer.mjs`](../../fixtures/descriptors/consumer.mjs), which imports only `@inventarch/db/descriptors`.

The test checks three things. The source compilation must equal `expected.json`. `envelopes.json` must equal what `envelopeFromRecord` extracts from the admitted overlay. And the consumer, run against the built export without the development condition, must reproduce the same digests and refusal codes. To run the consumer from packed archives outside the workspace, pack `@inventarch/language`, `@inventarch/graph`, `@inventarch/compliance` and `@inventarch/db`, install them into an empty directory, and run `node consumer.mjs <fixture dir>`.

## Extension rules

- A new resource field, scalar, contract kind or target semantics is a new format or a named feature. Older compilers refuse it and never drop it.
- A change to an executable key or value pattern needs a reviewed false-positive or false-negative case and a test; the patterns stay linear and length-bounded.
- Registering the words needs the schema, this guide, a steward, and an executable consumer landing together, with the public-native gate run in the same change (ALIGN-06).

## Not included

- Migration proposals and DDL (STORE-02 and DESC-Q05, LK-18).
- Tenant context and service denial (DESC-Q04).
- Browser or public projection publication (DESC-Q07).
- Installed-base immutability and local extension (DESC-Q06).
- Two real app hosts (DESC-Q01 and APPD-03, LK-19).
- Native registration and the steward.
