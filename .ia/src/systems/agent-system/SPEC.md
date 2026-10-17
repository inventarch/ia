# @inventarch/agent-system

Public language mechanism. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

## Write admission

An `EngineHost` that sets `requireAdmission` is refused by `new Engine` with `IA-ENGINE-ADMISSION-UNAVAILABLE` unless its store reports `admission: true`, that is, unless the store runs a host admission gate on every write (see the session-system package contract). When the store refuses a write, `advance` rejects with the store's redacted `IA-SESSION-ADMISSION-DENIED` and writes nothing more. An operation whose result was refused stays dispatched; the next owner's recovery records it without output, and a retry needs current authority again.
