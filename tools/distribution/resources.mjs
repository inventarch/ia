import { createHash } from 'node:crypto';
import { fieldTypeText } from '../../packages/language/dist/index.js';

/** Self-contained installed contract; package documentation must not depend on repository-relative links. */
export function publicLanguageGuide(words) {
  const lines = [
    '# Public IA language',
    '',
    'IA records declare typed identities, fields and relationships. Owning canonical schemas define the structural contract; language syntax and reference resolution preserve those declarations.',
    '',
    'The selected vocabulary below is shared by this release. Use `ia vocabulary --json` for its attributed catalogue and `ia vocabulary --schema` for canonical field schemas. `ia validate` reports structural and evaluated evidence separately. An admitted declaration does not establish semantic quality or grant execution authority.',
    '',
    'Spec source locators do not load documents. Resource capture and disclosure require explicit selection, matching pins and a host-owned disclosure boundary. Model, operation, evaluator and authority callbacks belong to the application host.',
    '',
    '| Word | Owner | Meaning |',
    '| --- | --- | --- |',
  ];
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  for (const word of words) lines.push(`| @${cell(word.word)} | ${cell(word.owner)} | ${cell(word.description)} |`);
  lines.push(
    '',
    'This guide describes the selected structural vocabulary. Private expert procedures, live provider behavior and unobserved platform qualification are separate from the installed public contract.',
    '',
  );
  return lines.join('\n');
}

/**
 * Packages outside the system folders that ship the public-language guide as LANGUAGE.md. Each is a byte-for-byte copy
 * of the guide every system folder carries, so `pnpm public:generate` writes it and `generate-public.mjs --check`
 * reports one that drifts. tools/distribution/language-guide.test.ts checks this list against every package that ships
 * the guide, by manifest or on disk.
 */
export const LANGUAGE_GUIDE_COPIES = [
  'apps/cli/LANGUAGE.md',
  'apps/distribution/LANGUAGE.md',
  'apps/mcp-door/LANGUAGE.md',
  'apps/runner/LANGUAGE.md',
  'apps/steward-hook/LANGUAGE.md',
  'apps/vscode/LANGUAGE.md',
  'packages/compliance/LANGUAGE.md',
  'packages/db/LANGUAGE.md',
  'packages/graph/LANGUAGE.md',
  'packages/kb/LANGUAGE.md',
  'packages/language/LANGUAGE.md',
  'packages/runtime/LANGUAGE.md',
  'packages/service-contracts/LANGUAGE.md',
  'packages/workspace-runtime/LANGUAGE.md',
];

/** Prose a word reference prints as is: `<facet>` or `<tool>@<version>` would read as an HTML tag, so `<` is escaped. */
const referenceText = (text) => text.replaceAll('<', '\\<');
/** Maintained selection advice. Generated records and installed references share this single source. */
const AUTHORING_GUIDANCE = {
  system: [
    'Introduce a vocabulary owner with registered words, direct dependencies and relationship consent.',
    'Use @workspace to select existing systems; use @schema to describe one word within its owner.',
    'Name a local steward, declare only direct dependencies and check consent at both ends of every cross-system edge.',
  ],
  schema: [
    'Define the fields, sections and relationships accepted for one registered word.',
    'Use @contract for evaluated behavioral requirements; a schema cannot prove those requirements.',
    'Match the registered discriminator and owner; distinguish required structure from host-enforced semantic conditions.',
  ],
  kind: [
    'Classify the semantic role produced by lowering a registered word.',
    'Use @category for concept classification or @artifact-set for artifact genre.',
    'Keep the closed role set consistent with lowering and retrieval lanes before changing registration metadata.',
  ],
  category: [
    'Define a concept classification used by record shapes and contextual selection.',
    'Use @kind for semantic role or @dimension for a condition and lookup coordinate.',
    'Check all registered shapes and selectors that consume the closed category set.',
  ],
  lane: [
    'Define the retrieval channel associated with a record kind.',
    'Use @placement for source authority; a lane does not assign source precedence.',
    'Keep lane mappings consistent with lowering and delivery; the authority lane contains governance records and authority-facet contracts.',
  ],
  phase: [
    'Name a cognitive stage used to select procedure cells.',
    'Use @primitive for the cognitive operation or @run for an execution instance.',
    'Use orient, plan, act or learn; a declared phase does not prove that execution reached it.',
  ],
  primitive: [
    'Name the cognitive operation paired with a phase to select a procedure cell.',
    'Use @move for an action classification or @intent-shape for request framing.',
    'Check cell coverage for explicit primitive selection and preserve intent-shape defaults when no override is given.',
  ],
  move: [
    'Classify the action or activity that a participant may undertake.',
    'Use @operation for an executable implementation contract or @primitive for cell selection.',
    'Use the closed move vocabulary in authority bounds; a declared allowed move does not grant host permission.',
  ],
  predicate: [
    'Define a directed relationship with its inverse spelling.',
    'Use a schema field for scalar data; avoid a new predicate for an existing relationship spelling.',
    'Specify direction, canonical spelling and inverse consistently; participating systems must consent to the edge.',
  ],
  axis: [
    'Define a closed coordinate axis used to select context.',
    'Use @dimension for a supported record attribute or @intent-shape for retrieval defaults.',
    'Keep axis values and the actor or runtime that supplies them consistent with the position protocol.',
  ],
  dimension: [
    'Define a record coordinate supported by conditions and lookup.',
    'Use @axis for a closed selection axis or an ordinary field for data with no selector semantics.',
    'Confirm that a consumer actually interprets the dimension; naming it alone does not implement a condition.',
  ],
  'intent-shape': [
    'Frame a request with retrieval defaults for its purpose.',
    'Use @primitive to select a cognitive operation explicitly or @playbook to supply a procedure.',
    'Document default phase, primitive and delivery bounds; retain explicit caller overrides.',
  ],
  'artifact-set': [
    'Group artifact genres for classification and filtering.',
    'Use @distribution to select concrete roots for packaging or @kind for semantic role.',
    'Distinguish source specifications from generated outputs inside a genre; membership does not prove provenance.',
  ],
  placement: [
    'Define source authority, precedence and reach within a captured workspace.',
    'Use @lane for retrieval routing or @workspace sources to select actual source roots.',
    'Check placement band and reach together; location metadata does not grant disclosure authority.',
  ],
  'value-type': [
    'Define a field value type available to canonical schemas.',
    'Use @schema for a particular word contract or @cardinality for relationship multiplicity.',
    'Keep parsing, schema validation and author-facing type rendering aligned before adding a type.',
  ],
  cardinality: [
    'Define the multiplicity accepted for a relationship target.',
    'Use a schema required marker for field presence; relationship multiplicity is a separate constraint.',
    'Prefer may one for an optional single edge; preserve optional as a compatibility alias and test requiredness separately.',
  ],
  agent: [
    'Identify a participant and the vocabulary addressed by its governance.',
    'Use @agent-profile for capability composition or @mandate for bounded authority.',
    'Give the participant an unambiguous identity; host permissions require separate authorization.',
  ],
  mandate: [
    'State bounded participant authority with allowed moves, workspace scope and exclusions.',
    'Use @agent for participant identity or @contract for requirements independent of a grant.',
    'Bind the intended participant and explicit scope; confirm host authorization before executing an allowed move.',
  ],
  contract: [
    'State versioned requirements that other records can adopt and evaluators can assess.',
    'Use @schema for field structure or @law for a governing rule.',
    'Give requirements stable identifiers and connect checks, cases and current evidence without treating adoption as proof.',
  ],
  check: [
    'Name an evaluator implementation and the scope it is intended to assess.',
    'Use @case for scenario inputs and expectations or @observation for an actual evaluation result.',
    'Verify that the host installs the named evaluator and that its evidence identifies the evaluated subject revision.',
  ],
  case: [
    'Describe reproducible scenario inputs, a request and its expected success or refusal.',
    'Use @check to name an evaluator or @observation to record an observed result.',
    'Bind the case to an executable assertion and expected code where relevant; declaring a case does not run it.',
  ],
  workspace: [
    'Select systems and source roots for an explicit work boundary.',
    'Use @system to own vocabulary or @distribution to select packaging roots.',
    'Declare source placements and an appropriate steward; validate the selected closure before using it.',
  ],
  distribution: [
    'Select root records whose dependency closure is to be packaged.',
    'Use @workspace for a working source boundary or @template for rendering structure.',
    'Choose roots that exclude repository-only maintenance records; qualification must inspect the resulting archive bytes.',
  ],
  law: [
    'State a rule whose violations have a declared severity.',
    'Use @principle for governing rationale or @convention for an agreed practice.',
    'Connect the rule to intended subjects with operative relationships or path scope and verify delivery from their seats.',
  ],
  principle: [
    'Explain a governing rationale used to judge choices across cases.',
    'Use @law for a severity-bearing rule or @convention for a customary practice.',
    'State the tradeoff the rationale resolves and its scope so it can guide a decision without duplicating a rule.',
  ],
  convention: [
    'Record a shared practice that keeps authoring or operation consistent.',
    'Use @law for a rule with severity or @principle for the rationale behind a practice.',
    'Describe a concrete practice and its intended subjects; cite an existing rule instead of restating it.',
  ],
  playbook: [
    'Provide a procedure whose cells are selected by phase and primitive.',
    'Use @operation for an executable implementation or @authoring-guide for choosing and writing records.',
    'Cover the intended phase and primitive combinations, including refusal or escalation where needed; cell delivery is not execution.',
  ],
  run: [
    'Identify a governed execution and record its status and any known phase.',
    'Use @task for intended work or @observation for execution evidence.',
    'Keep journal-only runs phase-free when no live phase is known; status and ownership declarations do not start execution.',
  ],
  'authoring-guide': [
    'Link a registered word and its schema to advice for selecting and authoring that word.',
    'Use @playbook for a procedure or @schema for the structural contract itself.',
    'Explain nearest alternatives and minimum useful content; keep document references and resource pins synchronized.',
  ],
  operation: [
    'Declare an implementation contract with inputs, outputs and effects for host execution.',
    'Use @playbook for procedure text or @template for bounded rendering inputs.',
    'Define success and refusal behavior and test the installed adapter; naming an implementation does not install it.',
  ],
  voice: [
    'Specify communication attributes to compose into an agent profile.',
    'Use @mandate for authority or @playbook for procedure; tone does not supply either.',
    'Make attributes actionable for the intended audience and check they do not smuggle in execution permissions.',
  ],
  'agent-profile': [
    'Compose a participant with capabilities and optional voice, mandate or delegates.',
    'Use @agent for identity or @harness for workspace-level execution composition.',
    'Resolve every selected capability and binding; composition does not establish that the host installed them.',
  ],
  harness: [
    'Compose profiles and execution bindings for a workspace under a host contract.',
    'Use @agent-profile for one participant composition or @workspace for source selection.',
    'Check workspace and binding compatibility and retain qualification evidence for the actual installed host.',
  ],
  capability: [
    'Group related operations, procedures, templates and checks under declared execution bounds.',
    'Use @operation for one executable contract or @agent-profile to select capabilities for a participant.',
    'Resolve included capabilities and their limits; test effect and authority bounds at the execution boundary.',
  ],
  'execution-binding': [
    'Connect a native target to an entry or descriptor installed by a host.',
    'Use @operation for the implementation contract or @harness to compose bindings.',
    'Qualify against the actual host catalog; absent installations are unavailable evidence, not successful bindings.',
  ],
  template: [
    'Describe bounded inputs and output structure for rendering.',
    'Use @operation for a broader executable effect or @spec for maintained requirements.',
    'Scalar templates require parameters and lines; structured-v1 templates use their resource and may omit those legacy fields or keep empty lists.',
  ],
  hook: [
    'Describe a host event and selection guard with its response message.',
    'Use @operation for an executable contract or @law for a rule independent of host events.',
    'Verify registration and event matching in the host adapter; declaration alone neither registers nor executes a guard.',
  ],
  observation: [
    'Record an attributed account of evidence, its interpretation and retention.',
    'Use @case for an expectation or @improvement for a proposed change based on evidence.',
    'Identify the evaluated subject revision, verdict and concrete evidence; distinguish an unavailable check from a pass.',
  ],
  improvement: [
    'Propose a change with review and publication metadata.',
    'Use @observation for supporting evidence or @decision for the choice to accept a proposal.',
    'Describe the proposed change and review basis; keep approval, application and publication evidence separate.',
  ],
  plan: [
    'Arrange milestones toward an intent at the top of the work hierarchy.',
    'Use @milestone for one outcome or @task for an owned action; plans do not nest.',
    'State intent and status, connect milestones and reference maintained sources instead of copying mutable release values.',
  ],
  milestone: [
    'Name an outcome and exit criterion within exactly one plan.',
    'Use @task for the action toward that outcome or @plan for the overarching arrangement.',
    'Make exit observable and keep it aligned with the evidence required of its tasks.',
  ],
  task: [
    'Assign one owner an action toward exactly one milestone.',
    'Use @milestone for the resulting condition or @spec for maintained requirements.',
    'State expected artifacts and prerequisites; exit evidence must succeed at the current task revision and does not change work.status.',
  ],
  decision: [
    'Record a question, options and decider, then the selected choice and rationale when made.',
    'Use @task for implementation work or @improvement for a proposal awaiting review.',
    'Keep status consistent with the choice; pin historical evidence while current policy decisions refer to maintained sources.',
  ],
  spec: [
    'Maintain a specification with explicit status and optional same-word supersession.',
    'Use @contract for evaluable requirement adoption or @task for work implementing the specification.',
    'Keep at most one supersession and identify maintained content; a source locator neither loads nor verifies its document body.',
  ],
};

export function authoringGuidanceFor(word) {
  if (!Object.hasOwn(AUTHORING_GUIDANCE, word)) throw new Error('Missing authoring guidance for @' + word);
  const [select, avoid, consider] = AUTHORING_GUIDANCE[word];
  return { select, avoid, consider };
}

export function publicResources({ outputs, text, put, json, manifest }) {
  const words = JSON.parse(text('docs/reference/language/vocabulary.json')).words;
  const guide = publicLanguageGuide(words);
  const guidesPath = '.ia/src/systems/authoring-system/records/public-guides.ia';
  const records = ['#! ia 1.0', ''],
    files = [],
    associations = [];
  const pin = (path) => {
    const bytes = Buffer.from(outputs.get(path).bytes);
    files.push({
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'text/markdown',
      encoding: 'utf8',
    });
  };
  for (const word of words) {
    const advice = authoringGuidanceFor(word.word);
    const name = `public-${word.owner}-${word.word}`;
    const document = `.ia/src/systems/authoring-system/reference/${word.word}.md`;
    const content = [
      `# @${word.word}`,
      '',
      word.description,
      '',
      `Select when: ${referenceText(advice.select)}`,
      '',
      `Avoid when: ${referenceText(advice.avoid)}`,
      '',
      `Before authoring: ${referenceText(advice.consider)}`,
      '',
      `Owner: ${word.owner}. Identity: ${referenceText(word.identity)}. Facets: ${word.facets.join(', ')}. Artifact set: ${word.artifactSet}. Primitive: ${word.primitive}. Move: ${word.move}.`,
      '',
      `Canonical schema: ${word.schema.path}.`,
      '',
      `Default file: ${word.word}.ia, relative to the workspace's authored root (the sources row at placement authored).`,
      '',
      ...word.schema.sections.map(
        (section) => `Section ${section.name}: ${section.required ? 'required' : 'optional'}.`,
      ),
      '',
      ...word.schema.fields.map(
        (field) =>
          `- ${field.path}: ${fieldTypeText(field)}; ${field.required ? 'required' : 'optional'}.${field.description ? ` — ${referenceText(field.description)}` : ''}`,
      ),
      '',
      ...word.schema.edges.map(
        (edge) =>
          // An inbound rule keeps its authored spelling, so `grounded-by decision` never reads as the record grounding it.
          `Relationship ${edge.direction === 'in' ? `${edge.spelling} from ${edge.target} (inbound ${edge.predicate})` : `${edge.predicate} to ${edge.target}`}: ${edge.cardinality}; ${edge.required ? 'required' : 'optional'}.`,
      ),
      '',
      'A valid declaration establishes structural conformance. Execution, host authority and evidence verification require their respective explicit consumers.',
      '',
    ].join('\n');
    put(document, content);
    pin(document);
    records.push(
      `@authoring-guide ${name}`,
      '  meaning',
      `    says ${JSON.stringify(word.description)}`,
      `    answers "When should I use @${word.word}, and what should I check before authoring it?"`,
      '  reference',
      `    owner ${word.owner}`,
      `    word ${word.word}`,
      `    schema @schema ${word.schema.name}`,
      `    document "${document}"`,
      `    default-file "${word.word}.ia"`,
      '  guidance',
      `    select-when ${JSON.stringify(advice.select)}`,
      `    avoid-when ${JSON.stringify(advice.avoid)}`,
      `    consider ${JSON.stringify(advice.consider)}`,
      '  relationships',
      `    cites @schema ${word.schema.name}`,
      '',
    );
    associations.push({
      owner: { source: 'self', path: guidesPath, identity: `authoring-system/definition/authoring-guide/${name}` },
      resources: [
        { key: { source: 'self', path: document }, role: 'guide', order: 0, required: true, delivery: 'inline' },
      ],
    });
  }
  put(guidesPath, records.join('\n'));
  const systems = manifest.systems.map((system) => {
    const base = `.ia/src/systems/${system.name}`,
      path = base + '/system.ia';
    put(base + '/LANGUAGE.md', guide);
    for (const file of ['README.md', 'SPEC.md']) {
      if (!outputs.has(base + '/' + file))
        put(
          base + '/' + file,
          `# ${system.name}\n\nOwns the declared public vocabulary and canonical schemas. The public language catalogue describes required fields, reference semantics and evaluation limits. Extensions use new owners and preserve existing word identities.\n`,
        );
      pin(base + '/' + file);
    }
    const additional = [
      'LANGUAGE.md',
      ...(system.name === 'agent-composition-system'
        ? [
            'references/installed-read.md',
            'references/public-spec.md',
            'references/spec-read-boundary.md',
            'references/task-capture.md',
          ]
        : []),
    ];
    for (const file of additional) pin(base + '/' + file);
    associations.push({
      owner: { source: 'self', path, identity: `floor/definition/system/${system.name}` },
      resources: ['README.md', 'SPEC.md', ...additional].map((file, order) => ({
        key: { source: 'self', path: base + '/' + file },
        role: order === 0 ? 'guide' : 'support',
        order: order === 0 ? 0 : order - 1,
        required: true,
        delivery: 'inline',
      })),
    });
    return {
      system: { source: 'self', path, identity: `floor/definition/system/${system.name}` },
      authoring: [{ source: 'self', path: base + '/README.md' }],
      architecture: ['SPEC.md', ...additional].map((file) => ({ source: 'self', path: base + '/' + file })),
      extensions: [],
      methods: [],
      steward: { source: 'self', path, identity: `agent-system/binding/agent/public-${system.name}-steward` },
      base: null,
    };
  });
  // Shipped package documentation, not authoring resources: written, never pinned.
  for (const path of LANGUAGE_GUIDE_COPIES) put(path, guide);
  for (const path of ['.ia/src/floor/README.md', '.ia/src/floor/SPEC.md']) pin(path);
  const taxonomy = {
    source: 'floor',
    path: '.ia/src/floor/taxonomy.system.ia',
    identity: 'floor/definition/system/taxonomy',
  };
  const floorReadme = { source: 'self', path: '.ia/src/floor/README.md' },
    floorSpec = { source: 'self', path: '.ia/src/floor/SPEC.md' };
  associations.push({
    owner: taxonomy,
    resources: [
      { key: floorReadme, role: 'guide', order: 0, required: true, delivery: 'inline' },
      { key: floorSpec, role: 'support', order: 0, required: true, delivery: 'inline' },
    ],
  });
  systems.push({
    system: taxonomy,
    authoring: [floorReadme],
    architecture: [floorSpec],
    extensions: [],
    methods: [],
    steward: null,
    base: null,
  });
  files.sort((first, second) => (first.path < second.path ? -1 : first.path > second.path ? 1 : 0));
  const index = { systems, artifacts: [], profiles: [], documents: [], lifecycles: [] };
  json('.ia/src/systems/authoring-system/library.json', {
    format: 'ia.authoring-library.v1',
    files: files.map(({ path }) => ({ path })),
    associations,
    index,
  });
  json('.ia/authoring.resources.json', { format: 'ia.authoring-resources.v1', files, associations, index });
}
