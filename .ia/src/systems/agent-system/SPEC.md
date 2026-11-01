# @inventarch/agent-system

Public language mechanism. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

Before `Engine.advance` returns a session, it checks the host's current grant for the calling principal, manifest workspace and root run's profile, including when no scheduler step runs. An expired grant or one that no longer admits that principal, workspace or profile refuses with `IA-ENGINE-AUTHORITY-DENIED`. This return check is bounded to 60 seconds and independent of execution deadlines, caller cancellation and executable-input verification; stopping execution does not bypass it. It does not introduce per-receipt disclosure labels or a new release policy.
