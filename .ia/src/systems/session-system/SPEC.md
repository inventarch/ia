# @inventarch/session-system

Public language mechanism. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

## Write admission

A host can make every durable write pass its own current-authority check. It configures a gate with `sqliteStore(root, { admit })`, `new SqliteBackend(root, { admit })`, `memoryStore({ admit })` or `new MemoryBackend({ admit })`. Without `admit` a store behaves as before. A configured `admit` that is not a function refuses at construction with `IA-SESSION-ADMISSION-UNAVAILABLE`, so a host that meant to require the gate never runs without it. `store.admission` is `true` only when the store's backend runs a gate.

The backend calls the gate once for each commit and each checkpoint, inside its write transaction: after the ownership, idempotency and revision checks and after every await, immediately before the first write. Nothing yields between the gate's answer and the commit. A revocation that lands before the write, including one that lands while the store awaits ownership validation, is therefore seen by the gate. An idempotent replay of a command already committed writes nothing and is not offered.

The gate receives an `Admission`, a deeply frozen copy of the write: its kind, session, principal and owner fence; the command and the exact events a commit appends; the session as it will stand afterwards; and the attempts whose output the write stores (those a commit observes or reconciles, or every observed attempt in a checkpoint). Each attempt carries its operation target, binding and input digests, invocation and the authority recorded when it was prepared, so the host can recheck exactly that authority, including a revision it put in its grant. A recovery record that stores no output has `output: null`. Model output inside an admission is payload, never authority.

Only a synchronous `true` admits. `false`, any other value, a promise or thenable, or a throw rolls the transaction back and refuses with `IA-SESSION-ADMISSION-DENIED` and the message `Host admission refused the write`. The refusal carries neither the offered bytes nor the host's error, and no part of the refused write is stored. The gate cannot change what is written or grant anything. Writes admitted earlier stay in the journal: a later revocation refuses later writes and never rewrites history.

The guarantee holds against authority state the gate reads synchronously in the same process. It is not atomic against a remote authority service, another process or independently changing shared memory; those need their own lease, transaction or fencing protocol. A custom `JournalBackend` that runs a gate sets `admission` to `true` and calls it at the same point; `JournalStore.command` passes the resulting session as the fifth `commit` argument.
