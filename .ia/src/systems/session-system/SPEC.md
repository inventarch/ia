# @inventarch/session-system

Public language mechanism. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

`@run` records declared execution metadata. `execution.phase` is an optional id: omit it when the phase is unknown. Historical values, including `recorded`, remain admitted; declaring a phase does not prove the engine's current state. `execution.status` remains a required id without a closed vocabulary, and `execution.owner` remains a required reference.

A projection of a runner journal omits an unknown phase when the selected run schema allows omission. When an older selected schema requires the field, the projection retains its historical `recorded` sentinel for compatibility. Neither representation establishes a live engine phase.
