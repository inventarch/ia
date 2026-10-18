# Knowledge foundation

This library owns bounded selection, immutable knowledge packaging, document views and citations. Native parsing, admission, reference resolution and resource associations remain owned by IA language, db, runtime and workspace-runtime.

Repositories retain records under `.ia/src` and canonical document bodies at explicitly selected Markdown or text paths. An optional `.ia/knowledge.json` selector uses the closed `ia.kb.selection.v1` contract. Local reads work without it; export requires a committed selection. No `.kb` folder or persistent index is created.

Legacy `iakb.portable.v1` envelopes, captures and resource hashes retain their original semantics and limits. New packages use `ia.kb.package.v1`. A trusted in-process host selects an exact verified foundation. Imported records remain inert; this library grants no audience, publication or lifecycle permission.

Limits: 100 selected files, 1 MiB per file, 8 MiB selected bytes, 200 query characters, 100 results, 64 traversal steps and 48 KiB transport responses. Graph closure, byte integrity and executed compliance are reported separately. Not-evaluated checks are never passes.

## Trusted foundations and portable closure

`createFoundation` consumes a verified retained source installation; `foundationFromWorkspace` consumes the active verified installation. Caller-supplied version labels do not establish a foundation. Pins include native artifacts and captured sources independently from the executing library version. One validated package uses exactly one foundation. Unresolved identity, typed field and fragment targets, foundation shadowing, duplicate identities, custom systems/schema, unselected body resources and hidden records in a selected native file refuse export/import.

The legacy entrypoint reproduces historical wire bytes, capture/resource hashes and foundation inputs. Its historically accepted same-content foundation shadow remains specific to that decoder. The new format also compares identity placement and source location. Hosts explicitly choose a retained legacy profile; installing a new library never recomputes a historical pin from its dependency tree.

## Views and coordinates

Local capture reads admitted authored records and their bound bodies once into an immutable view, rechecks native revision and body hashes before returning, and creates no files. Supplied native membership is intersected with any selector before body reads. Scope diagnostics identify selected records only. External sources are unavailable without fetching. Closure errors cannot become successful integrity checks or silently complete search results.

Reference closure resolves against selected identities and the verified installed foundation only. Adopted or open repository placement does not exempt an excluded record. Scoped admission describes the selected admitted records; workspace compliance checks are explicitly not evaluated. Use native validation to obtain whole-workspace findings.

Read/search/traverse/resolve share source identity, snapshot or commit package digest, native identity, optional fragment, and body digest. Local coordinates refuse after source/body changes; committed coordinates retain the exact committed bytes. Traversal preserves declared direction, inverse spelling, fragments and unevaluated conditions. Closing a view releases its reader and retained bodies. No operation creates a global cross-package graph or grants execution authority.

## Adapter effects

CLI read operations require Observation; check and export preview require Verification; export apply requires Execution. Export takes an exact full commit and committed selector. It writes only an explicit new output outside authored/native/selected-body paths, rejects unsafe ancestors and different existing bytes, and returns unchanged for an identical existing package. Apply rechecks current authority after interactive confirmation. MCP exposes the five read operations using its original Door membership and matching native graph revision, with no root or export-path arguments.
