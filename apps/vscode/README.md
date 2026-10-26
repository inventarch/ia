# IA Language for Visual Studio Code

[![Release](https://img.shields.io/github/v/release/inventarch/ia?label=release)](https://github.com/inventarch/ia/releases/latest) [![Public quality](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml/badge.svg?branch=main)](https://github.com/inventarch/ia/actions/workflows/platform-quality.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE) [![Node](https://img.shields.io/badge/node-22.x-brightgreen)](package.json) [![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.138.0-007acc)](package.json)

> IA Language (`inventarch-ia`) is the VS Code extension for `.ia` files. It checks your IA records as you edit, completes words, fields and references, and navigates between records.
>
> It bundles its own language server, built on the editor surface of `@inventarch/runtime`, and analyzes files locally without calling the `ia` CLI, an account or a hosted service. It ships as a VSIX on GitHub releases.

## ⚡ Quick start

1. Download the `inventarch-ia-<version>.vsix` asset from the [latest release](https://github.com/inventarch/ia/releases/latest).
2. In VS Code 1.138.0 or later, run **Extensions: Install from VSIX…** from the Command Palette and select the file.
3. Open the project folder that contains `.ia/`, then open a file under `.ia/src/`, such as `.ia/src/shopping-list.ia` from the [walkthrough](https://github.com/inventarch/ia/blob/main/docs/guide/walkthrough.md).

The extension activates on the first `.ia` file and starts one language server per workspace folder; in a multi-root workspace each folder gets its own, with an **IA language (*folder*)** output channel.

When a folder's installed distribution cannot be read, for example after a pull changed `.ia/distributions.lock.json` and nobody ran `ia restore`, that folder's server stays up and shows one error naming the folder and the reason. It reads the folder again when `.ia/distributions.lock.json`, `.ia/distributions/active.json` or a `.ia` file changes. The other folders keep working.

## 🧭 What it does

| Feature | What you get |
| --- | --- |
| Diagnostics | The workspace's admission findings (language, graph and compliance) in the **Problems** panel, refreshed as you type and save |
| Completion | Words, fields, values and references, with documentation for the selected item |
| Hover | A record's status, description, schema and findings |
| Navigation | **Go to Definition** and **Find All References** between records, **Go to Symbol** in the file and the workspace, and folding by record and section |
| Formatting | **Format Document** and the **Format IA with preservation checks** source action, for your authored files |
| Highlighting | A TextMate grammar plus semantic highlighting from the language server |
| Editing | `#` line comments, bracket and quote pairs, indentation after a record or section header, and an `.ia` file icon |

Only `.ia` files under the folder's `.ia/src/` are analyzed. Other `.ia` files get syntax highlighting only.

## ⚖️ What it does not do

- **No virtual workspaces.** The language server starts only for local `file:` folders; virtual workspaces are not supported.
- **Restricted Mode is local analysis only.** The extension still runs in an untrusted workspace, limited to local language analysis.
- **No commands or settings.** It contributes the `.ia` language and grammar; it adds no commands, views or configuration.
- **It does not replace the CLI.** It binds no checks, records no evidence and does not capture, author or register hosts; use `ia validate`, `ia preview`, `ia author`, `ia capture` and `ia host` for those.

## 📚 Learn more

- [Language guide](https://github.com/inventarch/ia/blob/main/docs/reference/language/README.md): syntax, relationships and your own vocabulary
- [SPEC.md](https://github.com/inventarch/ia/blob/main/apps/vscode/SPEC.md): the package contract
- [`@inventarch/runtime`](https://github.com/inventarch/ia/blob/main/packages/runtime/README.md): the editor surface behind the language server
- [Architecture reference](https://github.com/inventarch/ia/blob/main/docs/reference/architecture/README.md)
- [Root README](https://github.com/inventarch/ia#readme)

### Build a VSIX

With Node.js `>=22.22.0 <23` and the pinned pnpm, from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir apps/vscode exec vsce package --no-dependencies
```

`vsce` writes `inventarch-ia-<version>.vsix` in `apps/vscode/`. The documentation links above are absolute because this README also ships inside the VSIX.
