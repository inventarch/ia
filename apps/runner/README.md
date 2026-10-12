# @inventarch/runner

Run an admitted native agent profile with bounded execution and a durable local journal.

```sh
ia-runner run --root . --profile reader-profile --task "Read the captured task source"
ia-runner step --root . --profile reader-profile --id <run-id>
ia-runner submit --root . --profile reader-profile --id <run-id> --attempt <attempt-id> --response response.json
```

The workspace must select the installed `runner-local-v1` host contract, `runner-read-v1` mandate contract, and `runner-entry-v1` entry mapping. The conformance composition under `examples/conformance/composition` demonstrates these declarations. Installation alone supplies no authority. The default model waits for an explicit local response and creates no credentials.

Hosts can import `openRunner` and `runnerCatalog`, supply a trusted model adapter, and call `start`, `step`, `run`, `resume`, `submit` and `close`. See [SPEC.md](SPEC.md) for execution, context, persistence and evidence boundaries.
