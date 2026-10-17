# @inventarch/agent-system

Public language mechanism. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

## Write admission

An `EngineHost` that sets `requireAdmission` is refused with `IA-ENGINE-ADMISSION-UNAVAILABLE` unless its store reports `admission: true`, that is, unless the store runs a host admission gate on every write (see the session-system package contract). Engine checks this at construction and again at every use of the store, so a store the host replaces later is refused before Engine reads or writes it. When the store refuses a write, `advance` rejects with the store's redacted `IA-SESSION-ADMISSION-DENIED` and writes nothing more. An operation whose result was refused stays dispatched, and the next owner recovers it as it recovers any dispatched attempt. A read-only operation is recorded without output and waits for a retry, which needs current authority again. Other operations reconcile or wait under their recovery contract, and any output a reconciliation records passes the gate again.
