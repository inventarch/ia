---
id: spec-host-plugin-distribution
genre: spec
title: Host plugin distribution
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-12"
owners: [inventarch]
---

# Host plugin distribution

This contract records the implementation in [user-host](../../../apps/cli/src/user-host.ts), [doctor-user](../../../apps/cli/src/doctor-user.ts), [briefing](../../../apps/cli/src/briefing.ts), [decline](../../../apps/cli/src/decline.ts) and the pure [plugin renderer](../../../packages/compliance/src/host-plugin.ts).

## 3 IA home

The distribution home owns cached payloads, plugin materialization and initialization decisions. A relative or unsafe home refuses. Doctor reports a registration that pins a payload outside the current home rather than rewriting it.

## 6 Plugin packaging

### 6.1 Rendering

The renderer is pure and produces bounded files for the declared host protocol. Runtime and CLI paths are explicit renderer inputs.

### 6.2 Identity

The materialized plugin's version binds rendered file content with a placeholder version, including the Node path used by hooks. It changes when that rendered content changes.

### 6.3 Apply

`host claude --user` needs no workspace and plans by default. Applying materializes the marketplace under IA home and invokes Claude's own plugin commands. If the Claude executable is unavailable, it writes the materialized plugin and reports commands to run. It does not directly edit Claude settings.

## 7 User state

### 7.1 Registration

The user installation has independent ownership and removal. Service refusals retain their code and receive a command remedy.

### 7.2 Initialization choice

`init --decline today|forever` and `--forget-decline` change only the home decisions file, keyed to the repository. A successful init clears its decision; failure to clear does not undo initialization.

### 7.3 Doctor

Rows cover installation channel, IA home, plugin state, cached update information, local language compatibility and initialization choice, with or without a workspace. A requested host adds briefing and next-action fields. Doctor performs no repair or registry request.

## 8 Session hook

### 8.2 Briefing

The session hook asks the installed CLI for doctor state and renders a bounded briefing for the model and user. It distinguishes uninitialized, declined, ready, drifted and unavailable states. A briefing is evidence from observation, not a grant of execution permission.

## 9 Decision recovery

Broken decisions files are reported with location and repair. No session-start hook silently initializes a repository or rewrites authored records.

## 11 Updates and evidence

Cached update state can inform a next action without online polling by doctor. [User host tests](../../../apps/cli/tests/user-host.test.ts) and [briefing tests](../../../apps/cli/tests/briefing.test.ts) cover state reporting and command behavior. Live plugin activation remains separately qualified.
