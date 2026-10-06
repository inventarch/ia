# Public IA language

IA records declare typed identities, fields and relationships. Owning canonical schemas define the structural contract; language syntax and reference resolution preserve those declarations.

The selected vocabulary below is shared by this release. Use `ia vocabulary --json` for its attributed catalogue and `ia vocabulary --schema` for canonical field schemas. `ia validate` reports structural and evaluated evidence separately. An admitted declaration does not establish semantic quality or grant execution authority.

Spec source locators do not load documents. Resource capture and disclosure require explicit selection, matching pins and a host-owned disclosure boundary. Model, operation, evaluator and authority callbacks belong to the application host.

| Word | Owner | Meaning |
| --- | --- | --- |
| @agent | agent-system | Names a participant and the vocabulary to which its governance applies. It does not grant host permissions. |
| @agent-profile | agent-composition-system | Composes an agent, capabilities, optional mandate/voice/delegates and installed execution contracts. |
| @artifact-set | taxonomy | Defines a closed grouping of artifact genres. |
| @authoring-guide | authoring-system | Associates a vocabulary owner and schema with an authoring reference and usage guidance. |
| @axis | taxonomy | Defines a closed coordinate axis for selection. |
| @capability | agent-composition-system | Groups operations, procedures, templates, checks and included capabilities with declared execution bounds. |
| @cardinality | taxonomy | Defines relationship multiplicity constraints. |
| @case | compliance-system | Declares scenario inputs, expected behavior and evaluator attribution. A declaration is not an observed test result. |
| @category | taxonomy | Defines a closed concept classification used by record shapes and contextual selection. |
| @check | compliance-system | Names a check implementation and scope. Declaring an implementation name does not install or execute it. |
| @contract | compliance-system | Names versioned requirements that may be adopted by other records. Requirements need explicit evaluation evidence. |
| @convention | governance-system | Declares a convention in the shared governance shape. |
| @decision | work-system | Represents a choice that is needed or has been made: the question, options and decider, and once made, the choice and rationale. |
| @dimension | taxonomy | Defines a supported record dimension used by conditions and lookup. |
| @distribution | workspace-system | Declares root records from which a distributable closure is selected. |
| @execution-binding | agent-composition-system | Connects a native target to a host-installed entry or operation descriptor. |
| @harness | agent-composition-system | Composes profiles and execution bindings in a workspace under a host contract. |
| @hook | hook-authoring-system | Represents a host event, tool/path selection and guard message. Registration and executing a guard require a host adapter. |
| @improvement | learning-system | Represents a proposed change, review metadata and publication metadata. It does not authorize or apply the proposal. |
| @intent-shape | taxonomy | Defines a request framing and its retrieval defaults. |
| @kind | taxonomy | Defines a closed semantic role for records; lowering determines the role of each registered word. |
| @lane | taxonomy | Defines a retrieval lane associated with record kinds. |
| @law | governance-system | Declares a rule with severity. Structural admission cannot establish the truth or suitability of its prose. |
| @mandate | agent-system | States bounded authority and conditions for a participant. Host authorization remains independent. |
| @milestone | work-system | Represents an outcome with an exit criterion inside exactly one plan; it names a condition, not the work toward it. |
| @move | taxonomy | Defines the closed classification of an agent action or activity. |
| @observation | learning-system | Represents an attributed evidence account with interpretation and retention metadata. Evidence claims are not verified by field typing. |
| @operation | authoring-system | Binds a declared operation to an implementation/input/output/effect contract; the host installs implementations. |
| @phase | taxonomy | Defines a cognitive phase coordinate: orient, plan, act or learn. |
| @placement | taxonomy | Defines source authority and reach metadata. |
| @plan | work-system | Represents an arrangement of milestones toward an intent; it heads the work hierarchy and has no parent. Plans do not nest. |
| @playbook | governance-system | Represents a procedure as phase/primitive cells. Cell delivery is generic; the authored method belongs to its author. |
| @predicate | taxonomy | Defines a directed relationship and its inverse spelling. |
| @primitive | taxonomy | Defines a cognitive primitive coordinate; a cell is selected using its phase and primitive. |
| @principle | governance-system | Declares a governing rationale in the shared governance shape. |
| @run | session-system | Represents a governed run identity, declared phase, status and owner. Declaration does not start execution. |
| @schema | floor | Declares the structural contract for exactly one registered discriminator. |
| @spec | work-system | Represents a maintained specification with explicit status and at most one same-word supersession. Contents and document membership belong to its author; a source locator does not load a body or prove semantic quality. |
| @system | floor | Registers vocabulary, direct system dependencies, a local steward and consent for relationships. |
| @task | work-system | Represents one owner's action toward exactly one milestone. Whether it is ready to start is computed by a work evaluator, never stored on the record. |
| @template | template-system | Represents bounded rendering inputs and output structure. Rendering does not publish or install output. |
| @value-type | taxonomy | Defines the field types that schemas may require. |
| @voice | agent-composition-system | Declares communication attributes separate from authority and procedure. |
| @workspace | workspace-system | Groups systems into an explicit work boundary; relationships can describe dependencies between boundaries. Its sources name the roots and placement bands its records are captured from, and its steward the agent that directs it by default. |

This guide describes the selected structural vocabulary. Private expert procedures, live provider behavior and unobserved platform qualification are separate from the installed public contract.
