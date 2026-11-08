# The hosted service and the public language

IA has a public part and a hosted part. This page says which is which, how a hosted result reaches a repository, and what to use when the hosted part is not available. The public SPEC files link their phrase "supplied independently" here.

## What is public

The language is public: the words, the rules for writing a sentence with them, and the checks that evaluate whether a sentence is correct. A rule that a check can evaluate belongs to the language, and breaking one is a stopping error that `ia validate` reports. The CLI, the runtime, the MCP door, the kit format ([kit runtime](../../specs/kit-runtime/README.md)) and the public method kits in the [marketplace](https://github.com/inventarch/marketplace) are public too, as is the base method kit `ia-method`.

## What is hosted

Curated agent methods and judgement that is not a rule a check can evaluate are meant to run on the InventArch service, not in the language packages. The project's direction includes an orient-to-plan gate, in which an agent submits its orient understanding and the service answers with a verdict and next moves, and methods that their publishers keep hosted. These are supplied independently of the language: installing the language does not install them, and the language does not depend on them.

## How results return

A hosted result comes back as public-language records and structured next moves. It never comes back as instructions for the host to execute. The host may process a result a little, such as validating records or presenting next moves, and that processing never includes running instructions the service supplied. The returned records are ordinary IA records, so the public checks can evaluate them like any other.

## Offline, or without an account

Nothing in the public toolchain requires the service. With no account, or when the service is not reachable, an agent uses the public base `ia-method` kit, and the language checks run as always. Binding a kit to a lane does not change this: a repository's `.ia/bindings.json` names which kit answers each activity, and the public kits are valid answers.

## Status

This page describes the relationship the project has decided. It does not say that any particular hosted service is available. A feature that needs the service says so where it is described.
