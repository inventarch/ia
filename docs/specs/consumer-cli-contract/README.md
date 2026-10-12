---
id: spec-consumer-cli-contract
genre: spec
title: Consumer CLI contract
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-12"
owners: [inventarch]
---

# Consumer CLI contract

This contract describes the implemented consumer shell. The package [contract](../../../apps/cli/SPEC.md) records each command's detailed behavior; the [command table](../../../apps/cli/src/commands.ts), [parser](../../../apps/cli/src/args.ts) and [shell](../../../apps/cli/src/consumer.ts) are its executable owners.

## 1.2 Dispatch and discovery

The command table owns command names, arguments, options, help and handlers. Parsing precedes workspace, cache and registry reads. Unknown commands and invalid flags return usage with a concrete next action. Operation help comes from the runtime's [machine protocol](../../../packages/runtime/src/machine-protocol.ts), so supported operations and input shapes have one owner.

## 2 Commands and arguments

### 2.0 Grammar

Long options accept `--flag value` and `--flag=value`. Boolean options, explicit `--`, repeatable options and repeated positionals follow the command's grammar. One-letter aliases are exact tokens; bundled short options are refused. Closed values, integer bounds, conflicts and required arguments are checked before dispatch.

### 2.1 Initialization

`init [directory]` previews. `--apply` creates the declared starter and installs the bundled language. Its target is positional; `--root` is refused. See [initialization](../workspace-initialization/README.md) and [apply](../workspace-initialization-apply/README.md).

### 2.2 Vocabulary and 2.3 formatting

`vocabulary` reads the bundled word catalogue. Word-specific schema/example options require a word. `format` plans textual formatting; write and check modes remain explicit.

### 2.4 Capture and 2.5 validation

`capture` persists a captured snapshot through the database service. The deprecated `compile` path retains its compatibility artifact and deprecation remedy. `validate` reports language/contract findings and check execution evidence separately; an unbound check is not reported as passed. The command does not write authored records.

### 2.6 Inspection and 2.7 packing

`inspect`, `read`, `position` and `next` are observations. Bodies are obtained by `read`; a packet is a navigable context surface. `pack` requires an explicit distribution root and release descriptor, so an ordinary three-record consumer workspace is not automatically publishable.

### 2.8–2.11 Distribution changes

`install`, `update`, `remove` and `restore` plan by default. An apply rechecks the plan's inputs. Interactive applies show the change summary and accept only `y` or `yes` (case-insensitive, trimmed); declining is exit 0 with no apply. An apply without an answerable terminal, including JSON mode, requires `--yes`. Registered projections are refreshed after installation; a later refresh failure reports that installation already committed. See [registry](../registry/README.md).

### 2.12 Doctor

Doctor reads state and returns `ok`, `info`, `warn`, `fail` or `unknown` rows, exactly one bucket per row. An unperformed check is unknown. It does not repair or start servers. See [host observations](../host-registration/README.md#7-doctor-and-support).

## 3 Exit classes and protocol boundaries

The consumer shell returns 0 for success, 1 for failed validation or semantic refusal, 2 for usage, 3 for state/I/O/conflict failures, and 130 for interruption. Machine query operation dispatch preserves its own structured protocol; consumer formatting and flags must not leak into that protocol. Compatibility commands retain their documented entrypoint behavior. [Protocol tests](../../../apps/cli/tests/protocols.test.ts) exercise built entrypoints.

## 4 Refusals

A refusal retains the service code, location and reason and adds a runnable repair where one exists. It does not convert unknown or interrupted work into success. Already completed effects remain explicitly reported.

## 5 JSON

JSON mode prints one parseable envelope to stdout. Prompts and incidental process output do not share stdout. A parse-time refusal reads no workspace or installation state.

## 6 Terminal rendering

Human rendering uses structured tokens, terminal capabilities and width handling. Every command supplies a terminal state line; progress output is optional. Diagnostic severity and rendering limits do not change admission.

## 7 Qualification

[CLI tests](../../../apps/cli/tests) cover parsing, JSON envelopes, exit classes and command outcomes. Installed consumers additionally exercise packed binaries; neither establishes production host activation.
