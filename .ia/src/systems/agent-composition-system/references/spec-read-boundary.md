# Read a spec anchor and its explicit body

The [public spec seam](public-spec.md) and [first-party installed read](installed-read.md) use separate access boundaries. A current Engine grant for the native capture can read an admitted `@spec` anchor. Its `work.source "documents/specification.md"` is a locator; that grant does not make Markdown a native source or disclose a resource body.

The neutral `tests/spec-read-boundary-fixture.mjs` recipe copies selected public native sources into a fresh caller-selected workspace and authors one draft spec anchor and a literal Markdown body. It reuses the installed-read example's existing harness and installed contracts. A scripted provider makes one real Engine operation read of the anchor and one refused native read of the body path. This is qualification code: its model, evaluator and grants are deterministic host fixtures, not application authorization.

The caller then supplies the exact resource source revision, body path, size, SHA-256, media type, encoding and association to that admitted spec occurrence. `captureResources` retains those bytes; `resolveResources` additionally requires the native handle scope, selected owner, matching envelope digest, finite byte budget and independently allowed resource key. An empty resource allowlist refuses the required body even after the native read succeeds. Supplying the exact allowed key returns the captured Markdown bytes and citation. No model receives body prose through the native read. Semantic coherence and artifact/document membership remain governed by the existing [public spec example](public-spec.md).

Run the recipe from an installed public consumer containing the two recipe modules and its selected native extraction:

```sh
node spec-read-boundary-fixture.mjs <public-native-root> <new-empty-output>
```

Use a nonexistent output directory; the recipe refuses an existing path. The installed recipe uses the release's public package names. Ordinary Node runs it against compiled installed exports, with no development condition or TypeScript loader. The output records capture, compilation, installed-code and resource identities, provider and dispatch counts, native body-path refusal and separate body-disclosure refusal. Output files are caller-owned fixture data.

The current source callback and grants must be supplied by an authentic application host in production. The host also owns the resource root and disclosure allowlist; passing a resource key into this pure API is not authentication. A successful native read proves the retained anchor bytes were disclosed under that host's checks; it does not prove body freshness, semantic quality, a new policy or a release-wide acceptance result.
