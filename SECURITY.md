# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.1.x | Yes, once 1.1.0 is published |
| 1.0.x | Until 1.1.0 is published |

Security fixes go to the latest release line. The release tooling publishes only forward and only to the `latest` tag, so once 1.1.0 is published a fix ships as a 1.1.x release, not as a 1.0.x one. There are no earlier public releases.

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately through GitHub's vulnerability reporting form for this repository:

<https://github.com/inventarch/ia/security/advisories/new>

If you cannot use the form, email <admin@inventarch.dev>. Either route reaches the repository maintainers only. Include what you can of the following:

- The affected component: the language packages, the `ia` CLI, the MCP server, the VS Code extension, the steward hook or the repository tooling.
- The version or commit you tested, and the output of `ia doctor --json` if the CLI is involved.
- Steps to reproduce, including any `.ia` records, workspace layout or host registration needed.
- The impact you observed or expect.

We acknowledge reports in the advisory thread and keep you informed there as we assess and fix the problem. We ask that you give us reasonable time to publish a fix before disclosing details publicly, and we credit reporters in the advisory unless they ask otherwise.

## Scope

This policy covers the code and records published in this repository and the artifacts attached to its releases. Hosted InventArch services and the private marketplace are not part of this repository; problems in them are reported to their own operators, not here.

Running `ia host claude`, `ia host codex` or `ia host cursor` writes files into your workspace and user profile, and registers hooks and an MCP server with that host. Review the plan the command prints before applying it. A report about what the host set is permitted to do is in scope.
