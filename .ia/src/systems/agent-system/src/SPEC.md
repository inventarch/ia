# Agent execution runtime

The engine runs host-authorized profiles against a durable session store. Host callbacks own model, operation, evaluator and authority bindings. Native language declarations alone do not grant execution authority.

Before `Engine.advance` returns a session, it checks the host's current grant for the calling principal, manifest workspace and root run's profile, including when no scheduler step runs. An expired grant or one that no longer admits that principal, workspace or profile refuses with `IA-ENGINE-AUTHORITY-DENIED`. This return check is bounded to 60 seconds and independent of execution deadlines, caller cancellation and executable-input verification; stopping execution does not bypass it. It does not introduce per-receipt disclosure labels or a new release policy.

Rule and evaluator names carry no version: new manifests, sessions and reviews write `independent-exact-candidate`, `operator-exact-candidate` and `completion`. The original literals `independent-exact-candidate-v1`, `operator-exact-candidate-v1` and `ia.completion.v1` stay accepted wherever a stored manifest, session or review is read, as compatibility for at least one major release; any other value is refused.
