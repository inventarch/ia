# Installed SDK qualification

Verifies receipt-selected public archive bytes, dependency closure and independently installed ordinary Node consumers. Executes deterministic onboarding, first-party captured read and explicit specification-body fixtures. No private checkout, paid provider or publication is part of this gate.

The explicit pnpm launcher argument accepts either a JavaScript entry or a native executable through `tools/entry/package-manager.mjs`; a pnpm 12 binary is never parsed by Node. The caller supplies the qualified package-manager version and populated store. An offline install remains a separate observation from any earlier store population.

The candidate is verified against its committed v2 public input seal and the retained `npm-release.json` with its exact archive integrities and compatibility companion. SDK membership combines the core runtime packages with systems from the public language manifest. No extraction receipt in Git metadata is read. Run this only against a fully prepared local release candidate; it does not query or publish to a registry.

Each selected archive is opened without following a link, judged a regular file by its open descriptor and read once through it; the digest check, the packed `package.json` that `tar` reads from stdin and the recorded pin all come from that one read. pnpm still installs each archive from its path.
