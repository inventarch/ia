# @inventarch/learning-system

Public language mechanism. The [language reference](LANGUAGE.md) defines vocabulary and evaluation limits. Package exports describe the installed API. Curated agent methods and hosted services are supplied independently.

An `@observation` may carry `evidence.label`, a list of opaque host-defined text ids. Runner evidence retains the full session label on every observation, including observations made before labelled content arrived; releasing an outcome does not lower that label. The labels grant no authority. Readers apply their current clearance, and projections must not silently discard labels that a selected legacy schema cannot represent.
