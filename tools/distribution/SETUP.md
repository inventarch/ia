# npm account and repository setup

Setup readiness and release publication are separate. Follow the [publishing sequence](NPM-PUBLISHING.md) after fresh setup inspection. Historical account observations are retained as execution evidence, not current instructions.

## One-time account and repository setup

`pnpm npm:setup` is a read-only inspection. It reads public package metadata from the same registry URL as the publisher, authenticated exact-package metadata, access status, pending stages and trusted publishers for every package, plus the GitHub settings below. It exits nonzero when npm readiness is incomplete or an npm inspection fails; review the separately reported GitHub settings as well. npm's access command labels a false visibility result `private`; setup reports this as `non-public`, which does not establish that the package exists. Existence requires positive exact-name metadata, an exact-package stage or a valid trust record returned for that package. Public release readiness is a separate fact. Neither an anonymous nor an authenticated 404, even with an empty stage list, proves that a name is available or owned by the caller. Without positive evidence, existence stays `unconfirmed`.

The authenticated metadata helper uses the existing configuration of pinned npm 12.2.0. It fetches the raw packument from the canonical registry with a fresh, bounded read, rather than using `npm view`, whose version/tag selection can hide an existing package. It checks the requested name and metadata shape and returns only validated identity or a sanitized error code. It does not initiate authentication, persist configuration or expose credentials or metadata bodies. An unreadable or malformed response blocks readiness; a 404 conflicting with positive package evidence requires investigation. Mocked regression tests do not prove live authenticated access.

`pnpm npm:setup --apply` inspects before making supported account writes, then inspects again before reporting readiness. Repeated runs reuse known state. Complete inspection requires a maintainer:

- logged in with `npm login` on an account with 2FA and write access;
- logged in with `gh auth login` as a repository admin;
- with Node 22.22.2 or later available, which the pinned npm 12.2.0 needs. The shell's own Node can be older: the command runs npm with the newest compatible Node that fnm has installed (`fnm install 22.22.2`), or with `--node <path>`. It installs the pinned npm into a fresh private temporary directory, validates its physical files and package identity before execution, removes that installation when finished, and uses the existing npm login without printing credentials.

Reading a trusted publisher can require 2FA even for a list. Ordinary inspection captures structured output, so npm cannot prompt through it: [npm 12.2.0's authentication helper](https://github.com/npm/cli/blob/v12.2.0/lib/utils/auth.js) requires both standard input and standard output to be terminals. An `EOTP` from trust inspection leaves trust unknown; being logged in does not satisfy a request-specific 2FA challenge.

An owner who wants to complete that challenge can explicitly opt in from a terminal at the repository root:

```sh
pnpm npm:setup --interactive-auth --skip-github
```

Run this command without pipes or output redirection. It uses the same resolved Node and pinned npm **12.2.0** as setup; it does not use the shell's `npm`, which may be older and report `Unknown command: trust`. Do not substitute a bare `npm trust list` command for this recovery path. The command remains an inspection: it does not log in, persist new credentials, change trust or visibility, or approve or reject stages.

For an `EOTP` trust read, the opt-in helper lets npm handle its browser challenge on the terminal and masks classic one-time-password input. A separate result channel returns the completed trust read for the same strict structured validation as ordinary inspection; terminal prompt text is never treated as a trust result. Setup never records the OTP, persists it, or passes it in command arguments or the result channel. A challenge is scoped to its request, so npm may prompt for each package and again during a fresh inspection; one completed challenge is not a promise that later reads are authenticated.

Without the opt-in, setup reports the failed read and the recovery command. With the opt-in but either input or output redirected, it refuses instead of prompting. Failed, cancelled or timed-out authentication stops further interactive attempts in that run and leaves unread state blocked; the helper has a five-minute deadline. Resolve the cause before starting another inspection. The option does not enable interactive retries of setup writes or authenticated metadata reads, or relax any `--apply` checks. A failed, malformed or ambiguous access, stage, trust or metadata response remains a blocker, not permission to write. If recovery needs a new login, credential or permission change, stop for separate owner authorization.

Mocked regression checks cover the authentication control flow and structured result handling. They do not establish that a live npm browser/OTP challenge succeeds, or that interactive terminal transport works on every supported platform. Successful authentication also does not repair a private package or an anonymous public 404.

**npm.** Every package must trust GitHub repository **inventarch/ia**, workflow **npm-publish.yml** and environment **npm** for direct publishing. npm accepts a trusted publisher only for a name that already exists. Setup readiness requires authenticated metadata consistent with the package evidence, public access, readable public package metadata, a successful unambiguous stage inspection and the intended direct-publish trust configuration. Non-public visibility, public 404s and unknown states remain not ready, even after a successful write. Setup does not change visibility. `npm:preflight` and the publisher retain their missing-name safety check and still read public metadata before publication; a setup pass does not replace that check or establish actual OIDC authorization.

`--apply` creates missing trust only after successful inspection permits it. Existing matching trust is retained. A configuration for another repository, workflow or environment, or one without direct-publish permission, blocks setup; the owner must review it separately. Setup never overwrites or revokes it. `pnpm npm:trust-commands` prints the intended trust commands without running them.

Creating a new name also requires the owner to explicitly confirm each full package name with the repeatable `--bootstrap-name` option, for example `pnpm npm:setup --apply --bootstrap-name @inventarch/new-package`. This confirmation is necessary even when authenticated inspection returns 404. It permits a bootstrap only when public metadata, authenticated metadata and authenticated access all return 404, stage listing succeeds with no stages, and trust is either explicitly absent or returns 404. Positive existence evidence, ambiguous data, authentication failure or permission failure refuses a new bootstrap. Non-public visibility with unconfirmed existence also remains blocked, even with the option; the detection correction does not broaden bootstrap authorization. The option cannot repair an existing blocked package.

For a confirmed new name, setup stages `0.0.0-bootstrap.0` under the `bootstrap` tag with public access using [staged publishing](https://docs.npmjs.com/staged-publishing/), then inspects the resulting state before configuring missing trust. It retains and reports the exact package, version and stage ID. An existing pending bootstrap stage for that exact package and version is reused, including after an interrupted run; multiple candidates or uncertain identity/status block setup. The confirmed status must be `staged`; a stage still `validating` is retained, and setup stops for a later read. Setup never approves or rejects a stage and never automatically cleans one up. Retaining the stage avoids destructive setup cleanup; it is not evidence that stage retention fixes inconsistent npm registry visibility.

Keep the stage identity with the release record until the normal workflow publishes and verifies a real cohort version, including its archive integrity, `latest` tag and provenance. Only after that verification may an owner separately authorize manual cleanup of the exact retained bootstrap stage, after checking its current identity and status. Never approve a bootstrap payload or publish dummy contents as a real version. Never overwrite a published version, repurpose an existing tag, or use a 404 as proof of name ownership. Final verification requires an npm provenance attestation on every published package, which only the workflow's OIDC publication adds.

**GitHub.** `--apply` restricts the `npm` environment to main and makes the code owner, or `--reviewer <login>`, its required reviewer. Approving that environment is the publication checkpoint; the prepare job's summary shows the changeset digest and archive integrity being approved. It also enables GitHub's bundled permission for Actions to create and approve pull requests, so the release workflow can open `release/next`. The workflow itself creates a PR and does not submit an approving review. It makes the default workflow token read-only, since every workflow declares its own permissions, and it creates any ruleset in `.github/rulesets/` that is missing. The tag ruleset must keep allowing tag creation, because the release job creates `v<version>`.

Pull requests and pushes made with the workflow token start no other workflows. The release workflow therefore dispatches Public quality on `release/next`, and the publish workflow dispatches the release workflow after tagging.

### Owner actions: PowerShell recipe

Run the blocks separately in the same interactive terminal, beginning at the repository root. For a future package, the owner supplies its exact new `PackageName` and absolute paths for the `Node22` executable and the `Npm122` **npm-cli.js** already resolved by setup. Reuse the existing authorized login. These commands do not install npm, create credentials or change npm configuration. Stop if those prerequisites are missing.

First, verify the selected tools and inspect current state without writes:

```powershell
param(
    [Parameter(Mandatory)][string]$Node22,
    [Parameter(Mandatory)][string]$Npm122,
    [Parameter(Mandatory)][string]$PackageName
)
$ErrorActionPreference = 'Stop'
if ($PackageName -notmatch '^@inventarch/[a-z0-9][a-z0-9._-]*$') { throw 'Supply the exact owner-confirmed new package name.' }
$Node22 = (Resolve-Path -LiteralPath $Node22).ProviderPath
$Npm122 = (Resolve-Path -LiteralPath $Npm122).ProviderPath
if ((& $Node22 --version) -ne 'v22.22.2') { throw 'Select Node 22.22.2.' }
if ((& $Node22 $Npm122 --version) -ne '12.2.0') { throw 'Select pinned npm 12.2.0.' }
pnpm npm:setup --skip-github --node $Node22 --npm-cli $Npm122
```

Review the inspection before continuing; incomplete readiness deliberately returns a nonzero exit code. For trust-read `EOTP`, use the existing `--interactive-auth` recovery instructions. A 404 or non-public result never authorizes the next block. Only an owner who separately confirms the exact name is new and authorizes its creation may stage it. If an exact bootstrap stage already exists, retain and inspect it instead of creating another.

The following creates a minimal payload for that bootstrap route in a fresh temporary directory containing only a manifest and README, with no scripts or dependencies:

```powershell
$BootstrapDir = Join-Path ([IO.Path]::GetTempPath()) ('ia-npm-owner-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $BootstrapDir
$Utf8 = [Text.UTF8Encoding]::new($false)
$Manifest = [ordered]@{
    name = $PackageName
    version = '0.0.0-bootstrap.0'
    description = 'Creates the package name so its trusted publisher can be configured. Never approved or installed.'
    license = 'Apache-2.0'
    repository = [ordered]@{ type = 'git'; url = 'git+https://github.com/inventarch/ia.git' }
}
[IO.File]::WriteAllText((Join-Path $BootstrapDir 'package.json'), ($Manifest | ConvertTo-Json -Depth 3), $Utf8)
[IO.File]::WriteAllText((Join-Path $BootstrapDir 'README.md'), "# $PackageName`n`nNever approve this setup placeholder.`n", $Utf8)
& $Node22 $Npm122 stage publish $BootstrapDir --access public --tag bootstrap --ignore-scripts --json --registry https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Staging did not confirm success. Inspect stages before any retry.' }
```

Retain the returned exact package, version and stage ID. Inspect current stages with the pinned CLI and manually require exactly one record matching that stage ID, `$PackageName`, version `0.0.0-bootstrap.0` and status `staged`. Stop on a missing or multiple match; retain a `validating` or uncertain stage and investigate before further writes. Do not approve or reject the bootstrap stage. Check public metadata independently:

```powershell
& $Node22 $Npm122 stage list $PackageName --json --registry https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Stage inspection failed.' }
$PublicUri = 'https://registry.npmjs.org/' + [Uri]::EscapeDataString($PackageName)
$Public = Invoke-RestMethod -Method Get -Uri $PublicUri -TimeoutSec 30
if ($Public.name -ne $PackageName) { throw 'Unexpected public package identity.' }
$PublicVersions = @($Public.versions.PSObject.Properties.Name)
if ($PublicVersions -notcontains '0.0.0-stage') { throw 'Expected registry-created placeholder is absent; investigate.' }
[pscustomobject]@{ Name = $Public.name; Versions = $PublicVersions }
```

After fresh inspection confirms public existence and no matching trust, the separately authorized owner creates only the intended trust. A different or unreadable configuration requires owner investigation. Run without pipes or redirection so npm can complete its confirmation and 2FA challenge; never put an OTP in command arguments or logs:

```powershell
& $Node22 $Npm122 trust github $PackageName --file npm-publish.yml --repo inventarch/ia --environment npm --allow-publish --registry https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Trust creation did not confirm success. Reinspect before any retry.' }
pnpm npm:setup --skip-github --node $Node22 --npm-cli $Npm122
if ($LASTEXITCODE -ne 0) { throw 'Fresh setup inspection is not ready; stop before release.' }
```

Require a successful fresh setup result before proceeding to the normal release workflow. Keep the retained stage under the existing retention/cleanup policy. Trust inspection and its 2FA challenge authenticate an owner read; they are not a test of GitHub OIDC publication. [npm 12.2.0 trust-list implementation](https://github.com/npm/cli/blob/v12.2.0/lib/commands/trust/list.js)

### Trust validation and expiry

A new trusted-publisher configuration must complete its first successful publish within **two days of creation**. That publish validates the configuration and binds the repository's immutable identity. Otherwise, the configuration expires; an owner must delete the expired configuration, create a replacement and complete its first publish within the new window. Setup does not perform that lifecycle repair. [npm trusted-publisher expiry](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry)

Configured does not mean validated. The pinned CLI formats selected trust identity and permission fields and omits validation/expiry fields, so setup's `configured` result cannot establish a configuration's expiry deadline or OIDC readiness. Do not calculate expiry from a later setup-read timestamp. [npm 12.2.0 trust response formatter](https://github.com/npm/cli/blob/v12.2.0/lib/trust-cmd.js) and [GitHub trust-field mapping](https://github.com/npm/cli/blob/v12.2.0/lib/commands/trust/github.js)

npm supports multiple trust configurations, but this repository's current setup parser accepts one configuration object and blocks ambiguous or multiple output. Treat that as a tooling limitation, not permission to delete other configurations or weaken inspection. [npm configuration management](https://docs.npmjs.com/trusted-publishers/#managing-trusted-publisher-configurations)
