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
  'apps/steward-hook/LANGUAGE.md',
  'apps/vscode/LANGUAGE.md',
  'packages/compliance/LANGUAGE.md',
  'packages/db/LANGUAGE.md',
  'packages/graph/LANGUAGE.md',
  'packages/language/LANGUAGE.md',
  'packages/runtime/LANGUAGE.md',
  'packages/service-contracts/LANGUAGE.md',
  'packages/workspace-runtime/LANGUAGE.md',
];

/** Prose a word reference prints as is: `<facet>` or `<tool>@<version>` would read as an HTML tag, so `<` is escaped. */
const referenceText = (text) => text.replaceAll('<', '\\<');

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
    const name = `public-${word.owner}-${word.word}`;
    const document = `.ia/src/systems/authoring-system/reference/${word.word}.md`;
    const content = [
      `# @${word.word}`,
      '',
      word.description,
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
      `    answers "What does @${word.word} represent?"`,
      '  reference',
      `    owner ${word.owner}`,
      `    word ${word.word}`,
      `    schema @schema ${word.schema.name}`,
      `    document "${document}"`,
      `    default-file "${word.word}.ia"`,
      '  guidance',
      `    select-when ${JSON.stringify(word.description)}`,
      '    avoid-when "The intended record has a different semantic role."',
      '    consider "Check required fields and references; declaration is not execution evidence."',
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
