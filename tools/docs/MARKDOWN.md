# Markdown link parsing reference

This is the maintained parsing and reader-policy reference for [documentation tooling](SPEC.md). [markdown.mjs](markdown.mjs) owns syntax extraction and URI decomposition. [check.ts](check.ts), [catalog.mjs](catalog.mjs) and [teaching-links.ts](../systems/teaching-links.ts) apply their own target and access policies to that result. Downstream consumers may vendor the fixtures and implement the same contract without a sibling checkout.

## Grammar and extraction

The grammar is CommonMark with GitHub Flavored Markdown extensions. The exact `mdast-util-from-markdown`, `micromark-extension-gfm`, `mdast-util-gfm`, `parse5` and `github-slugger` versions are pinned in the package manifest and lockfile. The [GFM specification](https://github.github.com/gfm/) supplies the language rules; the parser owns block/container precedence, tabs, line endings, code spans, fences, tables and link syntax.

`parseMarkdown(text)` returns `links` and an `ids` set. Each link has a decoded Markdown destination, a kind (`link`, `image`, `definition` or `html`) and its source node's starting position. HTML links also retain the exact attribute offset and attribute name. Positions refer to the original source, before URI percent decoding. Code, HTML comments and raw-HTML text do not create Markdown links. HTML attributes are parsed as HTML; their case, whitespace, quotes and entities follow that grammar. Parsing never fetches a URL, executes code or reads a target.

Inline links, images, autolinks and authored reference definitions are collected. Reference uses do not duplicate their definitions. A valid unused definition remains a checkable authored target. Text resembling a definition inside an existing paragraph is not a definition:

```markdown
[label][ref]
[ref]: missing.md
```

That example renders as literal text. A blank line before the definition makes it a link. Escaped brackets, nested labels, multiline destinations and the supported title delimiters are interpreted by the grammar rather than a second regular expression.

## Reader policies

| Policy | File checker | Catalog checker | Teaching checker |
| --- | --- | --- | --- |
| Markdown links, images, definitions and autolinks | Yes | Yes | Yes |
| HTML `href` and `src` attributes | Excluded | Yes | Excluded |
| External URLs | Skip target lookup | Skip target lookup | Validate private-source citation policy; other URLs skip lookup |
| Website-root targets beginning with `/` | Skip; never read as filesystem root | Same | Same |
| Query string | Excluded from filesystem pathname | Same | Same |
| Fragment-only links | Skip | Check current document | Skip |
| Markdown/HTML target fragments | Excluded | Check parsed heading/explicit IDs | Excluded |
| Local target boundary | Repository containment | Repository containment | Installed `.ia/src/` teaching closure |

The table describes target policy, not directory inventory. The owning inventory/audit layer retains its alias and regular-file refusals. This parser does not grant access, broaden an inventory or replace those checks. Template placeholders beginning with `{` or containing `${` remain outside concrete target lookup.

`localTarget(href)` returns `null` for a nonlocal/template target, or `{pathname, fragment}`. It splits literal `?` and `#` separators **before** percent decoding each component. Thus `has%23name.md` names a file containing `#`; it does not name a fragment of `has`. Invalid percent escapes throw and become reader findings. Decoded traversal still reaches the owning reader's repository/closure checks. A query selects a rendered view and is not part of the local filename.

## Fragment identity

For Markdown, only parsed ATX/setext heading nodes and explicit IDs/names in actual HTML nodes contribute anchors. Code and comments cannot manufacture an HTML ID. Heading text retains inline-code contents and image alt text, decodes Markdown entities, and omits HTML syntax. The pinned GitHub slugger handles punctuation, Unicode and collisions, including collisions with earlier suffixed headings. Raw `.html` targets use parsed HTML IDs/names, without interpreting Markdown. Extension comparison is case-insensitive.

These are this profile's deterministic heading rules. A different host renderer must qualify its own fragment mapping. GitHub's Markdown API was used to verify representative link/heading rendering; that endpoint does not emit automatic heading IDs and is not evidence of exhaustive host-anchor compatibility.

## Conformance and updates

[link-parity.json](fixtures/link-parity.json) contains file/fragment success and refusal cases with explicit reader surfaces. It includes query handling, URL decoding, code exclusion, valid definitions, inline/HTML syntax, heading collisions and the formerly failing review examples. [link-conformance.json](fixtures/link-conformance.json) retains 1,692 unique authored combinations of syntax, containers, indentation, separators and delimiter lengths. Its `missing.md` expectations were frozen during the independent pre-implementation audit; tests do not regenerate them from the implementation under test. Representative cases were checked with GitHub's renderer. The broader audit also used official CommonMark/GFM examples; those upstream examples are not vendored in this authored matrix.

Run the portable suite from the repository root:

```sh
pnpm exec vitest run --config vitest.tools.config.mts tools/docs/link-parity.test.ts --maxWorkers=1
```

The suite exercises both documentation readers and the teaching reader against the same syntax expectations. [audit.test.ts](audit.test.ts) retains repository-boundary and linked-entry checks. [authoring-manifest.test.ts](../systems/authoring-manifest.test.ts) retains installed-closure and private-citation controls. The public export includes the parser, this reference, both fixture files and their tests; its dependency closure must pass a frozen install.

For a parser or policy update:

1. Preserve a failing input and a matching clean control. Name whether the difference concerns grammar, URI resolution, inventory, fragment identity or access policy.
2. Verify grammar expectations against the specification and, when applicable, the intended renderer. Explain any intentional reader difference in the fixture's `surfaces` and this reference.
3. Update the shared extraction/resolution owner. Do not add another code-span masker or downstream link regex.
4. Run the frozen fixture corpus, repository docs checks, teaching checks and public-resource qualification. Keep downstream vendored fixtures byte-identical and run their own readers against them when updating those repositories.
5. Retain exact dependency/fixture revisions and limits of the evidence. Passing a finite corpus is not proof that every possible Markdown input or host is correct.

This reference and the repository's results establish the local reader contract. Downstream implementations must run their own acceptance checks against the same fixture revision.
