import { createHash } from 'node:crypto';
import { fieldTypeText } from '../../packages/language/dist/index.js';

export function publicResources({ outputs, text, put, json, manifest }) {
  const words = JSON.parse(text('docs/reference/language/vocabulary.json')).words;
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
      `Owner: ${word.owner}. Identity: ${word.identity}. Facets: ${word.facets.join(', ')}.`,
      '',
      `Canonical schema: ${word.schema.path}.`,
      '',
      ...word.schema.sections.map(
        (section) => `Section ${section.name}: ${section.required ? 'required' : 'optional'}.`,
      ),
      '',
      ...word.schema.fields.map(
        (field) => `- ${field.path}: ${fieldTypeText(field)}; ${field.required ? 'required' : 'optional'}.`,
      ),
      '',
      ...word.schema.edges.map(
        (edge) =>
          `Relationship ${edge.predicate} to ${edge.target}: ${edge.cardinality}; ${edge.required ? 'required' : 'optional'}.`,
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
    for (const file of ['README.md', 'SPEC.md']) {
      if (!outputs.has(base + '/' + file))
        put(
          base + '/' + file,
          `# ${system.name}\n\nOwns the declared public vocabulary and canonical schemas. The public language catalogue describes required fields, reference semantics and evaluation limits. Extensions use new owners and preserve existing word identities.\n`,
        );
      pin(base + '/' + file);
    }
    associations.push({
      owner: { source: 'self', path, identity: `floor/definition/system/${system.name}` },
      resources: ['README.md', 'SPEC.md'].map((file, order) => ({
        key: { source: 'self', path: base + '/' + file },
        role: order === 0 ? 'guide' : 'support',
        order: 0,
        required: true,
        delivery: 'inline',
      })),
    });
    return {
      system: { source: 'self', path, identity: `floor/definition/system/${system.name}` },
      authoring: [{ source: 'self', path: base + '/README.md' }],
      architecture: [{ source: 'self', path: base + '/SPEC.md' }],
      extensions: [],
      methods: [],
      steward: { source: 'self', path, identity: `agent-system/binding/agent/public-${system.name}-steward` },
      base: null,
    };
  });
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
