# Public emitted qualification

Exercises built authoring/resource APIs, public guide resolution and host projection success/refusal against the public native tree.

`pnpm packages:qualify` packs every public npm package and installs the archives into a temporary consumer outside the repository. Dependency installation prefers the local package cache and may retrieve missing registry metadata. It verifies release versions, runtime policy, dependency pins, license notices and every exported target, then imports all exports with the development condition enabled. A second consumer installs only the CLI and its declared dependencies. With network fetches refused and home/configuration paths isolated, that installed CLI initializes and validates a workspace and registers both supported hosts. The same check packages the editor VSIX. Run the root build first; `pnpm public:qualify` includes this artifact check.

This establishes local installed-artifact behavior on the executing platform. It does not publish artifacts, establish registry ownership, or qualify a live editor or fresh agent session.
