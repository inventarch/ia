# Reusable knowledge foundation

Use `@inventarch/kb` to read admitted IA records and their bound Markdown/text documents, search them, follow native relationships, and export a selected committed slice. The existing `ia kb` CLI and five `ia_kb_*` MCP tools expose the same read contract.

Repositories author native records under `.ia/src`. Canonical documents stay at their ordinary paths. Local reads need no extra directory or manifest. An optional `.ia/knowledge.json` limits the local selection:

```json
{"format":"ia.kb.selection.v1","sourceId":"example","records":["work-system/contract/spec/architecture"],"resources":["docs/architecture.md"]}
```

Export requires an explicit selection file in the requested commit:

```sh
ia kb search "design decision" --root . --json
ia kb read work-system/contract/spec/architecture --root . --json
ia kb pack --root . --commit FULL_COMMIT_SHA --selection .ia/knowledge.json --out knowledge.json --json
ia kb pack --root . --commit FULL_COMMIT_SHA --selection .ia/knowledge.json --out knowledge.json --apply --yes --json
```

The first pack command previews. The second exclusively creates the output. Both read the selector and selected bytes from Git. Outputs are bounded JSON packages, not database files. No `.kb` directory or persistent index is created.

```js
import { captureKnowledge, openKnowledgeView } from '@inventarch/kb';
const view = openKnowledgeView(captureKnowledge(repository));
try {
  const results = view.search('design decision');
  const body = view.read('work-system/contract/spec/architecture');
} finally {
  view.close();
}
```

Local citations identify the captured working-tree bytes. A later read refuses an old citation if those bytes are unavailable. Package citations retain commit and package coordinates. Neither citation proves publisher identity, approval, or certification.

Hosts construct a foundation from verified retained installation evidence with `createFoundation({ installation })`, or from an existing verified native installation with `foundationFromWorkspace(root)`. Imported packages cannot select the trusted foundation. The native parser, admission, graph and resource owners validate the package independently.

The `./legacy` entrypoint retains the `iakb.portable.v1` format, bounded decoder/writer and validation hashes. `createLegacyFoundation` is a trusted historical-profile adapter: hosts verify the retained installation and select the retained profile separately. Do not calculate historical pins from an expanded current npm dependency inventory. Historical same-content shadow behavior remains isolated to the legacy reader; new packages reject foundation identity shadowing.

A central service stores immutable packages alongside its own audience, lifecycle, revision and recovery state. It authorizes before constructing a library view. Keep stores for different foundation pins separately configured. The library supplies no tenancy policy, publication, approval, synchronization, automatic foreign graph resolution or external URL fetch.
