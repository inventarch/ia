# Public vocabulary reference

Generated from the public contract corpus by `pnpm vocabulary:generate`. Required sections and fields are structural obligations; `id` is not an implicit enumeration. See [the language guide](README.md) for shared syntax, allowed values, relationship resolution, domain constraints and evaluator limits. The [JSON catalogue](vocabulary.json) carries the same machine-readable contract.

This catalogue contains 44 words. Source digest: `ff02010e5f8f87d7e3eddbff6e00cb7d67c3ad76425df2eaf32c0f4b817cc7e8`.

## @agent

Names a participant and the vocabulary to which its governance applies. It does not grant host permissions.

Owner: `agent-system`. Kind: `binding`. Category: `capability`. Artifact set: `operational`. Primitive: `Attention`. Move: `Delegation`. Identity: `agent-system/binding/<facet>/<name>`.

Schema: [agent](../../../.ia/src/systems/agent-system/schemas/agent.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `agent`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, governance. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| governance.applies | list of id | yes |

## @agent-profile

Composes an agent, capabilities, optional mandate/voice/delegates and installed execution contracts.

Owner: `agent-composition-system`. Kind: `binding`. Category: `capability`. Artifact set: `execution`. Primitive: `Decision`. Move: `Execution`. Identity: `agent-composition-system/binding/<facet>/<name>`.

Schema: [agent-profile](../../../.ia/src/systems/agent-composition-system/schemas/agent-profile.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `agent-profile`; the first is the default.

Consumer: language/schema admission; generic composition compiler and installed catalog.

Required sections: meaning, composition, execution. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| composition.agent | ref | yes |
| composition.capabilities | list of ref | yes |
| composition.voice | ref | no |
| composition.mandate | ref | no |
| composition.delegates | list of ref | no |
| execution.role | id | yes |
| execution.outcomes | id | yes |
| execution.mandate-contract | id | yes |
| execution.model-profile | id | no |
| execution.limit-steps | number | no |
| execution.limit-model-calls | number | no |
| execution.limit-operations | number | no |
| execution.limit-tokens | number | no |
| execution.limit-children | number | no |
| execution.limit-depth | number | no |
| execution.limit-bytes | number | no |
| execution.limit-duration-ms | number | no |

## @artifact-set

Defines a closed grouping of artifact genres.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-artifact-set](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `artifact-set`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |

Closed kernel members: `contract`, `decision`, `evidence`, `execution`, `inquiry`, `operational`, `principle`, `product-definition`, `projection`.

## @authoring-guide

Associates a vocabulary owner and schema with an authoring reference and usage guidance.

Owner: `authoring-system`. Kind: `definition`. Category: `representation`. Artifact set: `product-definition`. Primitive: `Memory`. Move: `Observation`. Identity: `authoring-system/definition/<facet>/<name>`.

Schema: [authoring-guide](../../../.ia/src/systems/authoring-system/schemas/authoring-guide.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `authoring-guide`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, reference, guidance, relationships. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| reference.owner | id | yes |
| reference.word | id | yes |
| reference.schema | ref | yes |
| reference.document | text | yes |
| guidance.select-when | text | yes |
| guidance.avoid-when | text | yes |
| guidance.consider | text | yes |

## @axis

Defines a closed coordinate axis for selection.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-axis](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `axis`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |
| data.values | list of id | yes |

Closed kernel members: `artifact-set`, `category`, `kind`, `lane`, `move`, `phase`, `predicate`, `primitive`, `shape`.

## @capability

Groups operations, procedures, templates, checks and included capabilities with declared execution bounds.

Owner: `agent-composition-system`. Kind: `definition`. Category: `capability`. Artifact set: `product-definition`. Primitive: `Inference`. Move: `Synthesis`. Identity: `agent-composition-system/definition/<facet>/<name>`.

Schema: [capability](../../../.ia/src/systems/agent-composition-system/schemas/capability.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `capability`; the first is the default.

Consumer: language/schema admission; generic composition compiler and installed catalog.

Required sections: meaning, execution. Optional sections: composition, relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| composition.operations | list of ref | no |
| composition.playbooks | list of ref | no |
| composition.templates | list of ref | no |
| composition.checks | list of ref | no |
| composition.includes | list of ref | no |
| execution.input | id | no |
| execution.outcomes | id | no |
| execution.context-profile | id | no |
| execution.procedure-profile | id | no |
| execution.mapping-profile | id | no |
| execution.effects | list of id | yes |
| execution.limit-steps | number | no |
| execution.limit-model-calls | number | no |
| execution.limit-operations | number | no |
| execution.limit-tokens | number | no |
| execution.limit-children | number | no |
| execution.limit-depth | number | no |
| execution.limit-bytes | number | no |
| execution.limit-duration-ms | number | no |

## @cardinality

Defines relationship multiplicity constraints.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-cardinality](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `cardinality`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |

Closed kernel members: `one`, `one-or-more`, `optional`.

## @case

Declares scenario inputs, expected behavior and evaluator attribution. A declaration is not an observed test result.

Owner: `compliance-system`. Kind: `definition`. Category: `evidence`. Artifact set: `evidence`. Primitive: `Learning`. Move: `Verification`. Identity: `compliance-system/definition/<facet>/<name>`.

Schema: [case](../../../.ia/src/systems/compliance-system/schemas/case.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `scenario`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, scenario, relationships. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| scenario.kind | id | yes |
| scenario.given | text | yes |
| scenario.request | text | yes |
| scenario.expected | text | yes |
| scenario.evaluator | text | yes |
| scenario.operation | ref | no |
| scenario.input | text | no |
| scenario.code | id | no |

## @category

Defines a closed concept classification used by record shapes and contextual selection.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-category](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `category`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |

Closed kernel members: `boundary`, `capability`, `decision`, `event`, `evidence`, `intent`, `kind`, `measure`, `process`, `property`, `relation`, `representation`, `rule`, `state`, `thing`.

## @check

Names a check implementation and scope. Declaring an implementation name does not install or execute it.

Owner: `compliance-system`. Kind: `check`. Category: `rule`. Artifact set: `evidence`. Primitive: `Decision`. Move: `Verification`. Identity: `compliance-system/check/<facet>/<name>`.

Schema: [check](../../../.ia/src/systems/compliance-system/schemas/check.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `gate`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, check. Optional sections: relationships, governance.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| check.runs | id | yes |
| check.scope | text | yes |

## @contract

Names versioned requirements that may be adopted by other records. Requirements need explicit evaluation evidence.

Owner: `compliance-system`. Kind: `contract`. Category: `relation`. Artifact set: `contract`. Primitive: `Memory`. Move: `Verification`. Identity: `compliance-system/contract/<facet>/<name>`.

Schema: [contract](../../../.ia/src/systems/compliance-system/schemas/contract.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `signature`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, relationships. Optional sections: inputs, outputs, preconditions, invariants, failures, authority, context, evolution.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| head.version | text | yes |

## @convention

Declares a convention in the shared governance shape.

Owner: `governance-system`. Kind: `governance`. Category: `rule`. Artifact set: `principle`. Primitive: `Inference`. Move: `Synthesis`. Identity: `governance-system/governance/<facet>/<name>`.

Schema: [convention](../../../.ia/src/systems/governance-system/schemas/convention.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `convention`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, governance. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| governance.severity | id | yes |

## @decision

Represents a choice that is needed or has been made: the question, options and decider, and once made, the choice and rationale.

Owner: `work-system`. Kind: `definition`. Category: `decision`. Artifact set: `decision`. Primitive: `Decision`. Move: `Synthesis`. Identity: `work-system/definition/<facet>/<name>`.

Schema: [decision](../../../.ia/src/systems/work-system/schemas/decision.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `decision`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, work, decision. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | no |
| work.title | text | yes |
| work.status | id in [open, made, superseded, withdrawn] | yes |
| work.owner | text | no |
| work.start | text form iso-date | no |
| work.due | text form iso-date | no |
| work.ended | text form iso-date | no |
| work.source | text | no |
| decision.question | text | yes |
| decision.options | list of text | no |
| decision.decider | text | no |
| decision.choice | text | no |
| decision.rationale | text | no |
| decision.constraints | list of text | no |

Relationship: supersede → decision; one; optional.

## @dimension

Defines a supported record dimension used by conditions and lookup.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-dimension](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `dimension`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |
| data.values | list of id | yes |
| data.path | text | yes |

Closed kernel members: `artifact-set`, `provenance`, `severity`.

## @distribution

Declares root records from which a distributable closure is selected.

Owner: `workspace-system`. Kind: `definition`. Category: `representation`. Artifact set: `projection`. Primitive: `Attention`. Move: `Observation`. Identity: `workspace-system/definition/<facet>/<name>`.

Schema: [distribution](../../../.ia/src/systems/workspace-system/schemas/distribution.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `distribution`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, distribution. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| distribution.records | list of ref | yes |

## @execution-binding

Connects a native target to a host-installed entry or operation descriptor.

Owner: `agent-composition-system`. Kind: `binding`. Category: `relation`. Artifact set: `execution`. Primitive: `Decision`. Move: `Execution`. Identity: `agent-composition-system/binding/<facet>/<name>`.

Schema: [execution-binding](../../../.ia/src/systems/agent-composition-system/schemas/execution-binding.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `execution-binding`; the first is the default.

Consumer: language/schema admission; generic composition compiler and installed catalog.

Required sections: meaning, binding. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| binding.kind | id | yes |
| binding.implementation | id | yes |
| binding.target | ref | no |
| binding.mapping | id | no |
| binding.event | id | no |
| binding.guard | id | no |
| binding.tools | list of id | no |
| binding.filters | list of text | no |

## @harness

Composes profiles and execution bindings in a workspace under a host contract.

Owner: `agent-composition-system`. Kind: `definition`. Category: `boundary`. Artifact set: `execution`. Primitive: `Decision`. Move: `Execution`. Identity: `agent-composition-system/definition/<facet>/<name>`.

Schema: [harness](../../../.ia/src/systems/agent-composition-system/schemas/harness.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `harness`; the first is the default.

Consumer: language/schema admission; generic composition compiler and installed catalog.

Required sections: meaning, composition, execution. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| composition.workspace | ref | yes |
| composition.profiles | list of ref | yes |
| composition.bindings | list of ref | yes |
| execution.host-profile | id | yes |
| execution.limit-steps | number | no |
| execution.limit-model-calls | number | no |
| execution.limit-operations | number | no |
| execution.limit-tokens | number | no |
| execution.limit-children | number | no |
| execution.limit-depth | number | no |
| execution.limit-bytes | number | no |
| execution.limit-duration-ms | number | no |

## @hook

Represents a host event, tool/path selection and guard message. Registration and executing a guard require a host adapter.

Owner: `hook-authoring-system`. Kind: `binding`. Category: `capability`. Artifact set: `operational`. Primitive: `Escalation`. Move: `Execution`. Identity: `hook-authoring-system/binding/<facet>/<name>`.

Schema: [hook](../../../.ia/src/systems/hook-authoring-system/schemas/hook.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `hook`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, hook. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| hook.event | id | yes |
| hook.tools | list of id | yes |
| hook.paths | list of text | yes |
| hook.message | text | yes |

## @improvement

Represents a proposed change, review metadata and publication metadata. It does not authorize or apply the proposal.

Owner: `learning-system`. Kind: `definition`. Category: `intent`. Artifact set: `inquiry`. Primitive: `Learning`. Move: `Synthesis`. Identity: `learning-system/definition/<facet>/<name>`.

Schema: [improvement](../../../.ia/src/systems/learning-system/schemas/improvement.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `improvement`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, proposal, review, publication, relationships. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| proposal.target | qname | yes |
| proposal.system | id | yes |
| proposal.path | text | yes |
| proposal.before | text | yes |
| proposal.candidate | text | yes |
| proposal.digest | text | yes |
| proposal.applies | text | yes |
| proposal.verification | text | yes |
| proposal.reversal | text | yes |
| review.status | id | yes |
| review.digest | text | no |
| review.reviewer | text | no |
| review.authority | text | no |
| review.at | text | no |
| review.rationale | text | no |
| review.revisit | text | no |
| publication.status | id | yes |
| publication.receipt | text | no |
| publication.digest | text | no |

## @intent-shape

Defines a request framing and its retrieval defaults.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-intent-shape](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `intent-shape`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data, routing. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |
| routing.category | id | yes |
| routing.primitive | id | yes |
| routing.tie-precedence | number | yes |
| routing.kind-focus | list of id | yes |
| routing.lane-focus | list of id | yes |
| routing.predicate-focus | list of id | yes |
| routing.priming-order | list of id | no |

Closed kernel members: `context`, `execution`, `governance`, `learning`, `sequence`.

## @kind

Defines a closed semantic role for records; lowering determines the role of each registered word.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-kind](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `kind`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |
| data.lane | id | yes |
| data.authority-lane | id | no |

Closed kernel members: `binding`, `check`, `contract`, `definition`, `governance`, `policy`, `template`.

## @lane

Defines a retrieval lane associated with record kinds.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-lane](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `lane`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |

Closed kernel members: `authority`, `bindings`, `contracts`, `definitions`, `enforcement`, `templates`.

## @law

Declares a rule with severity. Structural admission cannot establish the truth or suitability of its prose.

Owner: `governance-system`. Kind: `governance`. Category: `rule`. Artifact set: `principle`. Primitive: `Inference`. Move: `Verification`. Identity: `governance-system/governance/<facet>/<name>`.

Schema: [law](../../../.ia/src/systems/governance-system/schemas/law.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `law`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, governance. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| governance.severity | id | yes |

## @mandate

States bounded authority and conditions for a participant. Host authorization remains independent.

Owner: `agent-system`. Kind: `policy`. Category: `rule`. Artifact set: `principle`. Primitive: `Escalation`. Move: `Delegation`. Identity: `agent-system/policy/<facet>/<name>`.

Schema: [mandate](../../../.ia/src/systems/agent-system/schemas/mandate.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `mandate`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, governance. Optional sections: execution, relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| execution.contract | id | no |
| execution.limit-steps | number | no |
| execution.limit-model-calls | number | no |
| execution.limit-operations | number | no |
| execution.limit-tokens | number | no |
| execution.limit-children | number | no |
| execution.limit-depth | number | no |
| execution.limit-bytes | number | no |
| execution.limit-duration-ms | number | no |

## @milestone

Represents an outcome with an exit criterion inside exactly one plan; it names a condition, not the work toward it.

Owner: `work-system`. Kind: `definition`. Category: `state`. Artifact set: `product-definition`. Primitive: `Inference`. Move: `Verification`. Identity: `work-system/definition/<facet>/<name>`.

Schema: [milestone](../../../.ia/src/systems/work-system/schemas/milestone.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `milestone`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, work. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | no |
| work.title | text | yes |
| work.status | id in [proposed, open, held, closed, dropped, superseded] | yes |
| work.plan | ref to plan | yes |
| work.exit | text | yes |
| work.owner | text | no |
| work.start | text form iso-date | no |
| work.due | text form iso-date | no |
| work.ended | text form iso-date | no |
| work.source | text | no |

Relationship: require → milestone; one-or-more; optional.
Relationship: require → task; one-or-more; optional.
Relationship: require → decision; one-or-more; optional.
Relationship: supersede → milestone; one; optional.

## @move

Defines the closed classification of an agent action or activity.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-move](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `move`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |

Closed kernel members: `delegation`, `execution`, `observation`, `synthesis`, `verification`.

## @observation

Represents an attributed evidence account with interpretation and retention metadata. Evidence claims are not verified by field typing.

Owner: `learning-system`. Kind: `definition`. Category: `evidence`. Artifact set: `evidence`. Primitive: `Learning`. Move: `Observation`. Identity: `learning-system/definition/<facet>/<name>`.

Schema: [observation](../../../.ia/src/systems/learning-system/schemas/observation.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `observation`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, evidence, interpretation, retention. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| evidence.origin | id | yes |
| evidence.actor | text | yes |
| evidence.observed-at | text | yes |
| evidence.captured-at | text | yes |
| evidence.workspace | text | yes |
| evidence.locator | text | yes |
| evidence.revision | text | yes |
| evidence.bundle | text | yes |
| evidence.digest | text | yes |
| evidence.availability | id | yes |
| interpretation.applies | text | yes |
| interpretation.limits | text | yes |
| interpretation.reason | text | yes |
| interpretation.basis | id | yes |
| retention.status | id | yes |
| retention.explanation | text | no |

## @operation

Binds a declared operation to an implementation/input/output/effect contract; the host installs implementations.

Owner: `authoring-system`. Kind: `binding`. Category: `capability`. Artifact set: `execution`. Primitive: `Decision`. Move: `Execution`. Identity: `authoring-system/binding/<facet>/<name>`.

Schema: [operation](../../../.ia/src/systems/authoring-system/schemas/operation.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `operation`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, execution. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| execution.handler | id | yes |
| execution.effects | id | yes |
| execution.input | id | yes |
| execution.output | id | yes |
| execution.profile | id | no |
| execution.recovery | id | no |

## @phase

Defines a cognitive phase coordinate: orient, plan, act or learn.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-phase](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `phase`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |

Closed kernel members: `act`, `learn`, `orient`, `plan`.

## @placement

Defines source authority and reach metadata.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-placement](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `placement`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |
| data.band | number | yes |

Closed kernel members: `adopted`, `authored`, `floor`, `open`, `runtime`.

## @plan

Represents an arrangement of milestones toward an intent; it heads the work hierarchy and has no parent. Plans do not nest.

Owner: `work-system`. Kind: `definition`. Category: `process`. Artifact set: `product-definition`. Primitive: `Inference`. Move: `Synthesis`. Identity: `work-system/definition/<facet>/<name>`.

Schema: [plan](../../../.ia/src/systems/work-system/schemas/plan.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `plan`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, work. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | no |
| work.title | text | yes |
| work.status | id in [proposed, open, held, closed, dropped, superseded] | yes |
| work.owner | text | no |
| work.start | text form iso-date | no |
| work.due | text form iso-date | no |
| work.ended | text form iso-date | no |
| work.source | text | no |

Relationship: supersede → plan; one; optional.

## @playbook

Represents a procedure as phase/primitive cells. Cell delivery is generic; the authored method belongs to its author.

Owner: `governance-system`. Kind: `definition`. Category: `process`. Artifact set: `principle`. Primitive: `Inference`. Move: `Synthesis`. Identity: `governance-system/definition/<facet>/<name>`.

Schema: [playbook](../../../.ia/src/systems/governance-system/schemas/playbook.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `procedure`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, cognition. Optional sections: relationships, activation.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |

## @predicate

Defines a directed relationship and its inverse spelling.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-predicate](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `predicate`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |
| data.inverse | id | yes |
| data.phrase | text | yes |

Closed kernel members: `cite`, `constrain`, `consume`, `enforce`, `forbid`, `govern`, `grant-access-to`, `ground`, `implement`, `land`, `produce`, `record-lineage-from`, `require`, `route`, `run-before`, `supersede`, `trigger`, `use`.

## @primitive

Defines a cognitive primitive coordinate; a cell is selected using its phase and primitive.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-primitive](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `primitive`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |
| data.anchor | id | yes |

Closed kernel members: `attention`, `decision`, `escalation`, `inference`, `learning`, `memory`.

## @principle

Declares a governing rationale in the shared governance shape.

Owner: `governance-system`. Kind: `governance`. Category: `rule`. Artifact set: `principle`. Primitive: `Inference`. Move: `Synthesis`. Identity: `governance-system/governance/<facet>/<name>`.

Schema: [principle](../../../.ia/src/systems/governance-system/schemas/principle.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `principle`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, governance. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| governance.severity | id | yes |

## @run

Represents a governed run identity, declared phase, status and owner. Declaration does not start execution.

Owner: `session-system`. Kind: `definition`. Category: `event`. Artifact set: `operational`. Primitive: `Decision`. Move: `Execution`. Identity: `session-system/definition/<facet>/<name>`.

Schema: [run](../../../.ia/src/systems/session-system/schemas/run.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `run`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, execution. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| execution.status | id | yes |
| execution.phase | id | yes |
| execution.owner | ref | yes |

## @schema

Declares the structural contract for exactly one registered discriminator.

Owner: `floor`. Kind: `contract`. Category: `representation`. Artifact set: `contract`. Primitive: `Inference`. Move: `Verification`. Identity: `floor/contract/<facet>/<name>`.

Schema: [schema](../../../.ia/src/floor/floor.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `head`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: sections. Optional sections: fields, edges.

| Field | Type | Required |
|---|---|---|
| See the shared schema grammar | structured declarations | per grammar |

## @spec

Represents a maintained specification with explicit status and at most one same-word supersession. Contents and document membership belong to its author; a source locator does not load a body or prove semantic quality.

Owner: `work-system`. Kind: `contract`. Category: `rule`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `work-system/contract/<facet>/<name>`.

Schema: [spec](../../../.ia/src/systems/work-system/schemas/spec.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `spec`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, work. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | no |
| work.title | text | yes |
| work.status | id in [draft, accepted, superseded, withdrawn] | yes |
| work.owner | text | no |
| work.start | text form iso-date | no |
| work.due | text form iso-date | no |
| work.ended | text form iso-date | no |
| work.source | text | no |

Relationship: supersede → spec; one; optional.

## @system

Registers vocabulary, direct system dependencies, a local steward and consent for relationships.

Owner: `floor`. Kind: `definition`. Category: `boundary`. Artifact set: `product-definition`. Primitive: `Attention`. Move: `Observation`. Identity: `floor/definition/<facet>/<name>`.

Schema: [system](../../../.ia/src/floor/floor.schema.ia). Open ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `system`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: none. Optional sections: discriminators, requires, edges, relationships.

| Field | Type | Required |
|---|---|---|
| head.provider | text | yes |
| head.version | text | yes |
| head.steward | ref | no |
| head.describes | text | no |

## @task

Represents one owner's action toward exactly one milestone. Whether it is ready to start is computed by a work evaluator, never stored on the record.

Owner: `work-system`. Kind: `definition`. Category: `process`. Artifact set: `execution`. Primitive: `Decision`. Move: `Execution`. Identity: `work-system/definition/<facet>/<name>`.

Schema: [task](../../../.ia/src/systems/work-system/schemas/task.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `task`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, work. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | no |
| work.title | text | yes |
| work.status | id in [proposed, open, held, closed, dropped, superseded] | yes |
| work.milestone | ref to milestone | yes |
| work.owner | text | no |
| work.start | text form iso-date | no |
| work.due | text form iso-date | no |
| work.ended | text form iso-date | no |
| work.source | text | no |

Relationship: require → task; one-or-more; optional.
Relationship: require → milestone; one-or-more; optional.
Relationship: require → decision; one-or-more; optional.
Relationship: supersede → task; one; optional.

## @template

Represents bounded rendering inputs and output structure. Rendering does not publish or install output.

Owner: `template-system`. Kind: `template`. Category: `representation`. Artifact set: `projection`. Primitive: `Decision`. Move: `Execution`. Identity: `template-system/template/<facet>/<name>`.

Schema: [template](../../../.ia/src/systems/template-system/schemas/template.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `template`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, template. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| template.filename | text | yes |
| template.parameters | list of id | yes |
| template.lines | list of text | yes |
| template.profile | id | no |
| template.resource | text | no |

## @value-type

Defines the field types that schemas may require.

Owner: `taxonomy`. Kind: `definition`. Category: `kind`. Artifact set: `contract`. Primitive: `Memory`. Move: `Observation`. Identity: `taxonomy/definition/<facet>/<name>`.

Schema: [kernel-value-type](../../../.ia/src/floor/kernel.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `value-type`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, data. Optional sections: none.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| data.order | number | yes |

Closed kernel members: `flag`, `id`, `number`, `qname`, `ref`, `text`.

## @voice

Declares communication attributes separate from authority and procedure.

Owner: `agent-composition-system`. Kind: `definition`. Category: `property`. Artifact set: `product-definition`. Primitive: `Attention`. Move: `Synthesis`. Identity: `agent-composition-system/definition/<facet>/<name>`.

Schema: [voice](../../../.ia/src/systems/agent-composition-system/schemas/voice.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `voice`; the first is the default.

Consumer: language/schema admission; generic composition compiler and installed catalog.

Required sections: meaning, communication. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| communication.tone | text | yes |
| communication.terminology | text | yes |
| communication.explanation | text | yes |
| communication.uncertainty | text | yes |
| communication.audience | id | no |
| communication.citations | text | no |

## @workspace

Groups systems into an explicit work boundary; relationships can describe dependencies between boundaries.

Owner: `workspace-system`. Kind: `definition`. Category: `boundary`. Artifact set: `product-definition`. Primitive: `Attention`. Move: `Observation`. Identity: `workspace-system/definition/<facet>/<name>`.

Schema: [workspace](../../../.ia/src/systems/workspace-system/schemas/workspace.schema.ia). Closed ordinary sections; floor-owned cognition/activation rules also apply.

Facets: `workspace`; the first is the default.

Consumer: language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics.

Required sections: meaning, composition. Optional sections: relationships.

| Field | Type | Required |
|---|---|---|
| meaning.says | text | yes |
| meaning.answers | text | yes |
| composition.systems | list of ref | yes |
