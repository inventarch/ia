# Native loop acceptance tree

Input data for the cross-package acceptance in systems section12 and graph section12. [SPEC.md](SPEC.md) states the deliberate additions and expected failures. The `.ia/src` files were copied from this repository's native corpus at c41d9ff, then given the fixture changes listed there. Runtime tests copy the tree to a bounded temporary directory before mutating it. The single foreign playbook is intentionally invalid at its location.
