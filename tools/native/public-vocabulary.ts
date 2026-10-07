import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicLanguageInputs } from './public-language.js';
import { checkNative } from './check.js';
import { fieldTypeText } from '../../packages/language/src/index.js';
import { isEntry } from '../entry/is-entry.mjs';

export const descriptions: Readonly<Record<string, string>> = {
  system: 'Registers vocabulary, direct system dependencies, a local steward and consent for relationships.',
  schema: 'Declares the structural contract for exactly one registered discriminator.',
  kind: 'Defines a closed semantic role for records; lowering determines the role of each registered word.',
  category: 'Defines a closed concept classification used by record shapes and contextual selection.',
  lane: 'Defines a retrieval lane associated with record kinds.',
  phase: 'Defines a cognitive phase coordinate: orient, plan, act or learn.',
  primitive: 'Defines a cognitive primitive coordinate; a cell is selected using its phase and primitive.',
  move: 'Defines the closed classification of an agent action or activity.',
  predicate: 'Defines a directed relationship and its inverse spelling.',
  axis: 'Defines a closed coordinate axis for selection.',
  dimension: 'Defines a supported record dimension used by conditions and lookup.',
  'intent-shape': 'Defines a request framing and its retrieval defaults.',
  'artifact-set': 'Defines a closed grouping of artifact genres.',
  placement: 'Defines source authority and reach metadata.',
  'value-type': 'Defines the field types that schemas may require.',
  cardinality: 'Defines relationship multiplicity constraints.',
  agent: 'Names a participant and the vocabulary to which its governance applies. It does not grant host permissions.',
  mandate:
    'States bounded authority and conditions for a participant. Host authorization remains independent. An authority section names the participant it binds, the closed moves it allows, the workspaces it scopes, the words it excludes and the paths it covers.',
  contract:
    'Names versioned requirements that may be adopted by other records. Requirements need explicit evaluation evidence.',
  check: 'Names a check implementation and scope. Declaring an implementation name does not install or execute it.',
  case: 'Declares scenario inputs, expected behavior and evaluator attribution. A declaration is not an observed test result.',
  workspace:
    'Groups systems into an explicit work boundary; relationships can describe dependencies between boundaries. Its sources name the roots and placement bands its records are captured from, and its steward the agent that directs it by default.',
  distribution: 'Declares root records from which a distributable closure is selected.',
  law: 'Declares a rule with severity. Structural admission cannot establish the truth or suitability of its prose.',
  principle: 'Declares a governing rationale in the shared governance shape.',
  convention: 'Declares a convention in the shared governance shape.',
  playbook:
    'Represents a procedure as phase/primitive cells. Cell delivery is generic; the authored method belongs to its author.',
  run: 'Represents a governed run identity, declared phase, status and owner. Declaration does not start execution.',
  'authoring-guide': 'Associates a vocabulary owner and schema with an authoring reference and usage guidance.',
  operation:
    'Binds a declared operation to an implementation/input/output/effect contract; the host installs implementations.',
  voice: 'Declares communication attributes separate from authority and procedure.',
  'agent-profile':
    'Composes an agent, capabilities, optional mandate/voice/delegates and installed execution contracts.',
  harness: 'Composes profiles and execution bindings in a workspace under a host contract.',
  capability:
    'Groups operations, procedures, templates, checks and included capabilities with declared execution bounds.',
  'execution-binding': 'Connects a native target to a host-installed entry or operation descriptor.',
  template: 'Represents bounded rendering inputs and output structure. Rendering does not publish or install output.',
  hook: 'Represents a host event, tool/path selection and guard message. Registration and executing a guard require a host adapter.',
  observation:
    'Represents an attributed evidence account with interpretation and retention metadata. Evidence claims are not verified by field typing.',
  improvement:
    'Represents a proposed change, review metadata and publication metadata. It does not authorize or apply the proposal.',
  plan: 'Represents an arrangement of milestones toward an intent; it heads the work hierarchy and has no parent. Plans do not nest.',
  milestone:
    'Represents an outcome with an exit criterion inside exactly one plan; it names a condition, not the work toward it.',
  task: "Represents one owner's action toward exactly one milestone. Whether it is ready to start is computed by a work evaluator, never stored on the record.",
  spec: 'Represents a maintained specification with explicit status and at most one same-word supersession. Contents and document membership belong to its author; a source locator does not load a body or prove semantic quality.',
  decision:
    'Represents a choice that is needed or has been made: the question, options and decider, and once made, the choice and rationale.',
};
export function vocabulary(root: string, read?: (path: string) => string) {
  const { inputs, folders } = publicLanguageInputs(root, undefined, read),
    corpus = checkNative(inputs, folders);
  if (!corpus.ok) throw new Error('Public contract corpus does not conform');
  const words = [...corpus.registry.registrations.values()]
    .sort((a, b) => a.keyword.localeCompare(b.keyword, 'en'))
    .map((registration) => {
      const schema = corpus.registry.schemas.get(registration.schema);
      if (!schema || !descriptions[registration.keyword])
        throw new Error(`Missing schema or normative description for ${registration.keyword}`);
      if (!registration.artifactSet || !registration.primitive || !registration.move)
        throw new Error(`Missing lowering rows (artifact-set, primitive, move) for ${registration.keyword}`);
      return {
        word: registration.keyword,
        owner: registration.system,
        kind: registration.kind,
        category: registration.category,
        artifactSet: registration.artifactSet,
        primitive: registration.primitive,
        move: registration.move,
        facets: registration.facets,
        identity: `${registration.system}/${registration.kind}/<facet>/<name>`,
        description: descriptions[registration.keyword]!,
        schema: {
          name: schema.name,
          path: schema.path,
          closed: schema.closed,
          sections: schema.sections.map(({ name, must }) => ({ name, required: must })),
          fields: schema.fields.map(({ section, key, type, must, description, values, target, form }) => ({
            path: `${section}.${key}`,
            type,
            required: must,
            ...(description ? { description } : {}),
            ...(values ? { values } : {}),
            ...(target ? { target } : {}),
            ...(form ? { form } : {}),
          })),
          edges: schema.edges.map(({ predicate, direction, spelling, target, cardinality, must }) => ({
            predicate,
            direction,
            spelling,
            target,
            cardinality,
            required: must,
          })),
        },
        kernelMembers:
          registration.system === 'taxonomy'
            ? corpus.records
                .filter((r) => r.discriminator === registration.keyword)
                .map((r) => r.name)
                .sort()
            : [],
        consumer:
          registration.system === 'agent-composition-system'
            ? 'language/schema admission; generic composition compiler and installed catalog'
            : 'language/schema admission; graph resolution; explicitly selected domain consumer for stronger semantics',
      };
    });
  return {
    version: 1,
    language: 'ia 1.0',
    status: 'public IA 1.0 language contract',
    sourceDigest: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    words,
  };
}
export function vocabularyMarkdown(data: ReturnType<typeof vocabulary>): string {
  const lines = [
    '# Public vocabulary reference',
    '',
    'Generated from the public contract corpus by `pnpm vocabulary:generate`. Required sections and fields are structural obligations; `id` is not an implicit enumeration. See [the language guide](README.md) for shared syntax, allowed values, relationship resolution, domain constraints and evaluator limits. The [JSON catalogue](vocabulary.json) carries the same machine-readable contract.',
    '',
    `This catalogue contains ${data.words.length} words. Source digest: \`${data.sourceDigest}\`.`,
    '',
  ];
  for (const word of data.words) {
    lines.push(
      `## @${word.word}`,
      '',
      word.description,
      '',
      `Owner: \`${word.owner}\`. Kind: \`${word.kind}\`. Category: \`${word.category}\`. Artifact set: \`${word.artifactSet}\`. Primitive: \`${word.primitive}\`. Move: \`${word.move}\`. Identity: \`${word.identity}\`.`,
      '',
      `Schema: [${word.schema.name}](../../../${word.schema.path}). ${word.schema.closed ? 'Closed ordinary sections' : 'Open ordinary sections'}; floor-owned cognition/activation rules also apply.`,
      '',
      `Facets: ${word.facets.map((f) => '\`' + f + '\`').join(', ')}; the first is the default.`,
      '',
      `Consumer: ${word.consumer}.`,
      '',
      `Required sections: ${
        word.schema.sections
          .filter((s) => s.required)
          .map((s) => s.name)
          .join(', ') || 'none'
      }. Optional sections: ${
        word.schema.sections
          .filter((s) => !s.required)
          .map((s) => s.name)
          .join(', ') || 'none'
      }.`,
      '',
      '| Field | Type | Required |',
      '|---|---|---|',
    );
    for (const field of word.schema.fields)
      lines.push(`| ${field.path} | ${fieldTypeText(field)} | ${field.required ? 'yes' : 'no'} |`);
    if (!word.schema.fields.length)
      lines.push('| See the shared schema grammar | structured declarations | per grammar |');
    if (word.schema.edges.length)
      lines.push(
        '',
        ...word.schema.edges.map(
          (e) =>
            `Relationship: ${e.spelling} ${e.direction === 'out' ? `→ ${e.target}` : `← ${e.target} (inbound ${e.predicate})`}; ${e.cardinality}; ${e.required ? 'required' : 'optional'}.`,
        ),
      );
    if (word.kernelMembers.length)
      lines.push('', `Closed kernel members: ${word.kernelMembers.map((n) => `\`${n}\``).join(', ')}.`);
    lines.push('');
  }
  return lines.join('\n');
}
export function vocabularyOutputs(root: string, read?: (path: string) => string) {
  const data = vocabulary(root, read);
  return { 'vocabulary.json': JSON.stringify(data, null, 2) + '\n', 'vocabulary.md': vocabularyMarkdown(data) };
}
/**
 * `ia vocabulary` reads the catalogue shipped inside the installed @inventarch/cli package and never the workspace or
 * docs/, so the same JSON bytes are emitted there under this gate. tools/ has no package.json at any depth, so
 * the catalogue has to travel as data rather than as an imported module.
 */
export const SHIPPED_CATALOGUE = 'apps/cli/assets/vocabulary.json';
/**
 * The MCP door's `ia_vocabulary` tool serves the same catalogue (apps/mcp-door/SPEC.md M04c). The door imports
 * only @inventarch/runtime (M01) and does not depend on @inventarch/cli, so its package ships its own byte-identical copy under
 * this drift gate instead of reading another package's files.
 */
export const DOOR_CATALOGUE = 'apps/mcp-door/assets/vocabulary.json';
if (isEntry(process.argv[1], import.meta.url)) {
  const mode = process.argv[2];
  if (!['--write', '--check'].includes(mode ?? '') || process.argv.length !== 3)
    throw new Error('Use --write or --check');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const outputs = vocabularyOutputs(root);
  const targets: readonly (readonly [string, string])[] = [
    ...Object.entries(outputs).map(([name, text]) => [`docs/reference/language/${name}`, text] as const),
    [SHIPPED_CATALOGUE, outputs['vocabulary.json']],
    [DOOR_CATALOGUE, outputs['vocabulary.json']],
  ];
  for (const [name, text] of targets) {
    const path = resolve(root, name);
    if (mode === '--write') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    } else if (!existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== text)
      throw new Error(`Public vocabulary drift: ${name}`);
  }
  console.log(
    'Public vocabulary: 44 documented words; schema, reference projection and shipped CLI and door catalogues verified.',
  );
}
