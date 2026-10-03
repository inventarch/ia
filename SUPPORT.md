# Getting help

## Read first

- The [README](README.md) covers installation, the quick start and the editor and agent hosts.
- The [language guide](docs/reference/language/README.md) and [vocabulary catalogue](docs/reference/language/vocabulary.md) explain every word, its schema and how validation results read.
- The [CLI guide](apps/cli/README.md), [MCP server guide](apps/mcp-door/README.md) and [VS Code extension guide](apps/vscode/README.md) cover each tool. `ia --help` and `ia <command> --help` are the authoritative command syntax.
- `ia doctor` reports the runtime, workspace, installation and host state it observes, with the repair it suggests for each problem.

## Ask

Open an issue using the templates:

- **Bug report** when a command, the extension or the MCP server behaves differently from its contract. Include the output of `ia doctor --json` and the smallest workspace that reproduces it.
- **Feature request** for a change to the language, the vocabulary, the CLI or the hosts.
- **Documentation** when a document is wrong, missing or unclear.

A question that is not one of those is still welcome as an issue; say what you tried and what you expected.

## Security

Do not report security problems in an issue. Use the process in [SECURITY.md](SECURITY.md).

## What this repository does not cover

Hosted InventArch services and the private marketplace are separate products. Questions about them belong with their operators, not in this repository.
