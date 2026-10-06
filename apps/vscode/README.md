# IA Language for Visual Studio Code

IA Language provides local diagnostics, completion, hover information, navigation, references, symbols, semantic highlighting and formatting for `.ia` files.

Install the `inventarch-ia-<version>.vsix` asset from the [latest GitHub release](https://github.com/inventarch/ia/releases/latest) using **Extensions: Install from VSIX** in VS Code 1.138.0 or later. Open a local IA workspace folder and a file under `.ia/src/` to start language analysis. Each folder in a multi-root workspace has its own language server.

The extension runs local language analysis in restricted workspaces. Virtual workspaces are not supported. Language analysis does not require an account or a hosted service.

See the [language reference](https://github.com/inventarch/ia/blob/main/docs/reference/language/README.md) for syntax and the [package contract](https://github.com/inventarch/ia/blob/main/apps/vscode/SPEC.md) for scope. To build a VSIX from this repository, run `pnpm install --frozen-lockfile`, `pnpm build`, then `pnpm --dir apps/vscode exec vsce package --no-dependencies`.
