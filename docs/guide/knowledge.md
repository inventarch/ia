# Knowledge

**`ia kb` reads a workspace as a body of knowledge: records, plus the Markdown or text documents they point to. It can check that body, search it, read any part with a citation, follow its relationships, and package a chosen slice for reuse elsewhere.**

Agents get the same reads through the MCP server's `ia_kb_*` tools.

## Records with documents

A record can point at a longer document with `work.source`:

```ia
@spec shopping-list-export
  meaning
    says "A cook can export the ingredients of the recipes they picked as one shopping list."
    answers "What must the shopping-list export do?"
  work
    title "Shopping-list export"
    status accepted
    owner "Priya"
    source "docs/shopping-list.md"
```

The record stays short, with an identity, a status and relationships, and the document holds the detail. `ia kb read` returns the document as the record's body.

## Reading

All `ia kb` commands print JSON.

| Command | Does |
| --- | --- |
| `ia kb check` | Checks that every selected record is admitted and every bound document can be read |
| `ia kb search "<words>"` | Finds records and documents containing the words, with an excerpt and a citation each. `--limit` takes 1 to 100. |
| `ia kb read <identity>` | Returns a record's body, which is its bound document if it has one, with the file's digest and a citation |
| `ia kb traverse <identity>` | Follows relationships outward from a record. `--steps` takes 1 to 64. |
| `ia kb resolve --citation <file>` | Checks that a saved citation still points at the same content |

```sh
ia kb read work-system/contract/spec/shopping-list-export
```

```text
{
  "version": 1,
  "ok": true,
  "value": {
    "identity": "work-system/contract/spec/shopping-list-export",
    "body": "# Shopping-list export\n\nA cook picks recipes and exports one list. …",
    "bodySha256": "49605450f9954c08e20348dfd038acc12ac916a5e58ae6d6e9eb56651f57af22",
    "sourcePath": ".ia/src/shopping-list.ia",
    "bodyPath": "docs/shopping-list.md",
    "certified": false,
    "authority": "inert",
    "citation": { … }
  }
}
```

Every result carries a **citation**: the snapshot it came from and the digest of the exact text returned. An agent that quotes a document can cite it, and anyone can later check with `ia kb resolve` that the text has not changed. `"authority": "inert"` means reading knowledge grants nothing: a document that says "the agent may deploy" does not let it.

Reads need the Observation move; `ia kb check` needs Verification.

## Choosing what counts

By default `ia kb` reads every authored record and its bound documents, up to 100 files, 1 MiB per file and 8 MiB in all. For a larger workspace, or to read only part of it, add a **selection** at `.ia/knowledge.json`:

```json
{
  "format": "ia.kb.selection.v1",
  "sourceId": "pantry",
  "records": ["work-system/contract/spec/shopping-list-export"],
  "resources": ["docs/shopping-list.md"]
}
```

`records` lists full identities. `resources` lists documents, which may not be under `.ia/`.

## Packaging knowledge

`ia kb pack` writes a chosen slice of a workspace, the records and their documents, to one JSON file that another tool or workspace can read. It reads from a **commit**, not your working files, so commit the selection and documents first:

```sh
ia kb pack --commit <full-commit-sha> --selection selection.json --out knowledge.json
ia kb pack --commit <full-commit-sha> --selection selection.json --out knowledge.json --apply --yes
```

The first command checks and previews; the second writes. The output must be outside `.ia/` and `.git/`. If the file already exists with different contents, it refuses. Packing with `--apply` needs the Execution move.

The [knowledge example](../../examples/knowledge/README.md) is a one-record workspace to try this on, and the [knowledge package guide](../../packages/kb/README.md) covers the formats and the library.

## What it does not do

- It indexes nothing in advance and keeps no database: each command reads the files.
- It does not judge content. A document being present, recent or cited does not make it correct.
- It never publishes anything. `ia kb pack` writes a local file; sharing it is up to you.
