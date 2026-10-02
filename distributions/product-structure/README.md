# Product structure

This directory is the authored source of the independently versioned `inventarch/product-structure` 0.1.0 distribution. It defines the optional `product-system` and ships a pure structural reader. The canonical IA language does not include this word unless a consumer explicitly adopts the distribution.

Start with the [distribution contract](SPEC.md), [product authoring guide](.ia/src/systems/product-system/README.md) and [product schema](.ia/src/systems/product-system/schemas/product.SPEC.md). Install the exact language dependency before adopting this distribution. Its reader checks structural identity and references; it performs no lifecycle effects or authorization.

From a built source checkout, `node --conditions=development --import tsx tools/release/product-structure.mjs <new-output-directory>` builds the language and product archives. The output directory must not already exist. The packer selects a fixed asset list and writes `product-artifacts.json` with the archive identities. `apps/distribution/tests/product-structure.test.ts` exercises adoption, structural reading and refusal cases. Publication and independent consumer qualification are separate gates.
