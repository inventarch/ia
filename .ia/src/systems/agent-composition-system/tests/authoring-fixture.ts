import { KERNEL_SOURCES } from '@ia/language';
import { EditorSnapshot } from '@ia/db/editor';
import { digest } from '@ia/session-system';
import { verifyCapture } from '../src/corpus.js';
import { resourceOccurrences, verifyResources } from '../src/resources.js';
import { keyOf, metadataDigest, occurrenceOf, ordered, sha256 } from '../src/resource-format.js';
import type { ResourceFile, ResourceOccurrence } from '../src/resource-format.js';
import type { AuthoringIndexInput, AuthoringScope } from '../src/authoring-types.js';

const definitions = `#! ia 1.0
@system authoring-system
  provider "fixture"
  version "1.0.0"
  steward @agent fixture-steward
  requires
    - taxonomy
    - agent-system
  discriminators
    playbook lowers to definition
      category representation
      facets [head]
      schema @schema playbook
    note lowers to definition
      category representation
      facets [head]
      schema @schema note
    authoring-guide lowers to definition
      category representation
      facets [authoring-guide]
      schema @schema authoring-guide
  edges
    cite * using *
@schema playbook
  lowers to definition
  sections
    open
@schema note
  lowers to definition
  sections
    open
@schema authoring-guide
  lowers to definition
  sections
    must have meaning
    must have reference
    must have guidance
    must have relationships
    closed
  fields
    must have meaning.says as text
    must have meaning.answers as text
    must have reference.owner as id
    must have reference.word as id
    must have reference.schema as ref
    must have reference.document as text
    must have guidance.select-when as text
    must have guidance.avoid-when as text
    must have guidance.consider as text
@agent fixture-steward
  governance
    applies [playbook, note, authoring-guide]
@playbook fixture-method
@note requirement
  meaning
    says "The exact requirement evidence."
@authoring-guide note-guide
  meaning
    says "A note records an explicit bounded requirement."
    answers "When is a note useful?"
  reference
    owner authoring-system
    word note
    schema @schema note
    document "references/note.md"
  guidance
    select-when "There is an explicit requirement."
    avoid-when "A binding permission is needed."
    consider "Check the owning source."
  relationships
    cites @schema note
`;
const agentDefinitions = `#! ia 1.0
@system agent-system
  provider "fixture"
  version "1.0.0"
  steward @agent agent-steward
  discriminators
    agent lowers to definition
      category representation
      facets [head]
      schema @schema agent
  edges
    cite * using agent
@schema agent
  lowers to definition
  sections
    open
@agent agent-steward
  governance
    applies [agent]
`;
export function authoringFixture(
  change: (text: string) => string = (v) => v,
  extra: readonly { path: string; text: string }[] = [],
) {
  const sources = [
    ...KERNEL_SOURCES.map((s) => ({
      ...s,
      location: {
        placement: { kind: 'floor' as const, band: 10 as const, reach: '' },
        provenance: 'bootstrap' as const,
      },
    })),
    {
      path: '.ia/src/systems/agent-system/system.ia',
      text: agentDefinitions,
      location: {
        placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
        provenance: 'workspace' as const,
      },
    },
    {
      path: '.ia/src/systems/authoring-system/system.ia',
      text: change(definitions),
      location: {
        placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
        provenance: 'workspace' as const,
      },
    },
    ...extra.map((source) => ({
      ...source,
      location: {
        placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
        provenance: 'workspace' as const,
      },
    })),
  ];
  const body = {
    version: 1 as const,
    id: 'fixture',
    sources,
    folders: ['agent-system', 'authoring-system'],
    floorOrigin: 'embedded' as const,
  };
  const capture = verifyCapture({ ...body, revision: digest(body) });
  const reader = new EditorSnapshot({
    root: '.',
    sources,
    folders: body.folders,
    floorOrigin: body.floorOrigin,
    fingerprint: capture.revision,
  });
  const inventory = resourceOccurrences(capture),
    find = (suffix: string): ResourceOccurrence => {
      const found = inventory.occurrences.find((o) => o.identity.endsWith(suffix));
      if (!found)
        throw new Error(
          `Fixture occurrence missing ${suffix}: ${JSON.stringify(
            reader
              .inspect()
              .report.verdicts.flatMap((v) => v.findings)
              .filter((f) => f.severity === 'error'),
          )}`,
        );
      return found;
    };
  const guide = find('/authoring-guide/note-guide'),
    system = find('/system/authoring-system'),
    target = find('/head/requirement');
  const file = (path: string, content: string): ResourceFile => ({
    key: { source: capture.id, revision: capture.revision, path },
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    mediaType: 'text/markdown',
    encoding: 'utf8',
    content,
  });
  const files = ordered(
    [
      file('references/note.md', '# Note\nUse exact requirement evidence.\n'),
      file('references/system.md', '# Fixture system\nAuthor notes with the fixture method.\n'),
      file('documents/requirement.md', 'Explicit upstream requirement.\nAcceptance depends on it.\n'),
    ],
    (f) => keyOf(f.key),
  );
  const key = (path: string) => files.find((f) => f.key.path === path)!.key;
  const associations = ordered(
    [
      {
        owner: guide,
        resources: [
          {
            key: key('references/note.md'),
            role: 'guide' as const,
            order: 0,
            required: false,
            delivery: 'inline' as const,
          },
        ],
      },
      {
        owner: system,
        resources: [
          {
            key: key('references/system.md'),
            role: 'guide' as const,
            order: 0,
            required: false,
            delivery: 'inline' as const,
          },
          {
            key: key('documents/requirement.md'),
            role: 'support' as const,
            order: 0,
            required: false,
            delivery: 'inline' as const,
          },
        ],
      },
    ],
    (a) => occurrenceOf(a.owner),
  );
  const resourceBody = {
    format: 'ia.captured-resources.v1' as const,
    sourceRevisions: inventory.sourceRevisions,
    nativeCaptureRevision: capture.revision,
    files,
    associations,
  };
  const resources = verifyResources({ ...resourceBody, digest: metadataDigest(resourceBody) }, capture);
  const input: AuthoringIndexInput = {
    systems: [
      {
        system,
        authoring: [key('references/system.md')],
        architecture: [key('references/system.md')],
        extensions: [],
        methods: [find('/head/fixture-method')],
        steward: find('/head/fixture-steward'),
        base: null,
      },
    ],
    artifacts: [
      {
        id: 'requirement',
        source: { kind: 'resource', key: key('documents/requirement.md'), range: null },
        purpose: 'Required upstream product intent',
        contract: key('references/note.md'),
        dependencies: [],
        lifecycle: [],
      },
    ],
    profiles: [
      {
        id: 'brief',
        version: '1',
        roles: [
          { id: 'requirement', min: 1, max: 1, context: 'required-input', contract: null },
          { id: 'acceptance', min: 1, max: 1, context: 'expected-output', contract: null },
        ],
        criteria: [{ id: 'coherence', version: '1', basis: 'semantic', text: 'Requirements agree with acceptance.' }],
      },
    ],
    documents: [
      {
        id: 'brief',
        version: '1',
        profile: { id: 'brief', version: '1' },
        members: [{ artifact: 'requirement', role: 'requirement', order: 0 }],
        gaps: [{ role: 'acceptance', reason: 'Expected after requirements are authored.' }],
      },
    ],
    lifecycles: [],
  };
  const scope: AuthoringScope = {
    reader,
    within: reader.resolveScope().token,
    allowedResources: files.map((f) => f.key),
    allowedSystems: ['agent-system', 'authoring-system', 'floor', 'taxonomy'],
    allowedRegistrations: [...reader.inspect().graph.registry.registrations.keys()],
    allowedArtifacts: ['requirement'],
    allowedDocuments: ['brief'],
  };
  return { capture, resources, input, scope, reader, guide, system, target, find, key };
}
