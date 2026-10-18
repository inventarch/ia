# @inventarch/mcp-door

[![npm](https://img.shields.io/npm/v/@inventarch/mcp-door?label=npm)](https://www.npmjs.com/package/@inventarch/mcp-door) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json)

> `ia-mcp-door` is a local MCP server that gives an agent host read-only access to one IA workspace over stdio. It serves twelve tools: eleven Door operations from [`@inventarch/runtime`](../../packages/runtime/README.md), the same reads the `ia` CLI performs, and `ia_vocabulary`.
>
> `ia host claude` and `ia host codex` register it for you. Any other MCP client can launch it directly.

## ⚡ Quick start

**With Claude Code or Codex.** In an initialized project, preview the registration, then apply it:

```sh
ia host claude
ia host claude --apply --yes
```

Claude Code gets an `ia-workspace` server in `.mcp.json`; `ia host codex --apply --yes` adds `[mcp_servers."ia-workspace"]` to `.codex/config.toml`. Both entries start the copy of this server bundled in the host payload that `ia host` installs under `~/.ia/hosts/` (or `$IA_HOME/hosts/`), with your Node binary and the project's absolute path as `--root`. The files are machine-local; do not commit them. Claude Code asks for approval before it starts a project MCP server.

**With any MCP client.** Install the package and point the server at a workspace:

```sh
npm install --global @inventarch/mcp-door
ia-mcp-door --root path/to/your-project
```

Without `--root` it serves the current directory. It speaks MCP `2025-11-25` as UTF-8 JSON-RPC, one message per line on stdin and stdout. A client sends `initialize` and `notifications/initialized` before `tools/list` or `tools/call`. In the project from the [root quick start](../../README.md#-quick-start), this session reads the authored `@decision`:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ia_read","arguments":{"locator":"work-system/definition/decision/api-response-format"}}}' \
  | ia-mcp-door --root .
```

The second response line carries the result as `structuredContent` (shortened here):

```text
{"jsonrpc":"2.0","id":2,"result":{"content":[…],"structuredContent":{"ok":true,"result":{…,"kind":"record","digest":"dae12679…","body":"Choose a response format for the public API.","certified":false}},"isError":false}}
```

## 🧭 What it does

| Tool | Returns |
| --- | --- |
| `ia_scope` | A scope token, or one narrowed by `phase`, `identities` or `root`. Pass it as `within` to later calls. |
| `ia_context` | Cited procedure cells and applicable governance for a declared phase and primitive. `format: "compact"` summarizes omissions. |
| `ia_select` | Exactly one of the identities you supply; a tie or a missing coordinate refuses. |
| `ia_get` | One admitted record. |
| `ia_records` | The admitted record snapshot. It can be large; `ia_search`, `ia_get` and `ia_traverse` read less. |
| `ia_resolve` | The identity a typed reference resolves to; an unresolved reference says why. |
| `ia_search` | Ranked matches in decoded record text, with statistics computed inside the scope. |
| `ia_traverse` | Relationships followed from start records, with typed filters and optional condition gating. |
| `ia_read` | The body behind a locator (`<identity>`, `<identity>#<phase>/<Primitive>`, `<identity>#<REQ-ID>` or `<path>:<line>`), with the SHA-256 of its UTF-8 bytes and `certified: false`. `includeRuntime: true` reads a record at runtime placement. |
| `ia_next` | One plan's delivery view, as `ia next` prints it: milestones and tasks in prerequisite order, each task's verdict, and `next`, the command for the first task with no declared blocker. |
| `ia_position` | `{body, digest, hostNote}` for a scope key: `seat` (an identity or `{path}`), `shape`, `phase`, `depth` (0 to 2), `budget` (0 to 64) and `word`, plus optional `primitive`. Omitted, primitive is derived from shape; explicit primitive also supplies the default phase. No key part means the repository's `@workspace` at context, orient, depth 0, budget 0. |
| `ia_vocabulary` | The public words and their schemas, from the catalogue shipped with the server. It reads no workspace and takes no scope token. |

The first eight tools were introduced in machine-protocol version 1 and `ia_read`, `ia_next` and `ia_position` in version 2. The server uses the latest protocol, version 3, whose `ia_position` schema additionally accepts `primitive`. A runtime Door explicitly serving version 2 still refuses that parameter. The protocol's `report` operation has no tool; run `ia report` from the CLI.

Every result carries its JSON as `structuredContent` and as text. A refusal sets `isError: true` and returns `ok: false` with a `code`. Refusals from the three version 2 tools can also carry `next`, the one command to run:

- `ia_read`: `IA-RUNTIME-READ-UNADMITTED` for a locator no admitted record in the scope answers. Through a narrowed token it names nothing outside the scope; through the whole workspace it says what the sources hold there, such as a record whose admission was refused.
- `ia_next`: `IA-RUNTIME-NEXT-SEAT`, `-NO-PLAN`, `-AMBIGUOUS` or `-CYCLE`, with the `plans` or the `cycle` concerned.
- `ia_position`: `IA-RUNTIME-REQUEST-INVALID` for an invalid key or an unknown parameter, such as free text.

The `ia_position` body is a pure function of the key and the admitted records. It names no root, token or time, so two agents asking the same key of the same records read the same body and digest. `hostNote` sits beside it and says how fresh the last `ia capture` is.

## ⚖️ What it does not do

- **It never writes.** Every tool is annotated `readOnlyHint: true`, and the workspace files are unchanged after a session. Authoring, validation and capture stay with the CLI (`ia preview`, `ia author`, `ia validate`, `ia capture`).
- **It checks no `@mandate`.** The CLI's mandate-checked commands, the edit guard and `ia-runner` check mandates; these tools do not. Mandates are cooperative restrictions, not authentication or a sandbox.
- **It grants nothing.** `ia_select` and `ia_context` choose and deliver records; they execute nothing. A read certifies nothing: the digest identifies bytes, not whether they are true.
- **Scope tokens are process-local.** A token from `ia_scope` lasts as long as the server process. Narrowing a token limits what later calls read through it.
- **Bounded transport.** Stdio only, with no network listener. A line over 4 MiB or invalid UTF-8 ends the session, and `tools/list` issues no pagination cursor.

## 📚 Learn more

- [SPEC.md](SPEC.md): the package contract
- [LANGUAGE.md](LANGUAGE.md): the packaged summary of the words this release ships
- [`@inventarch/runtime`](../../packages/runtime/README.md): the Door, `MACHINE_PROTOCOL`, positions and delivery views behind these tools
- [CLI guide](../cli/README.md): `ia host`, `ia doctor` and the matching `ia position`, `ia next` and `ia read` commands
- [Architecture reference](../../docs/reference/architecture/README.md)
- [Root README](../../README.md)
