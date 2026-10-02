import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, readInputs } from '@ia/db';
import type { Handle } from '@ia/db';
import { stableSerialize } from '@ia/graph';
import { digest } from '@ia/session-system';
import { adoptWorkspace, captureWorkspace } from '../src/index.js';
import type { Capture } from '../src/index.js';
import {
  captureResources,
  resolveResources,
  resourceOccurrences,
  ResourceError,
  RESOURCE_LIMITS,
  verifyResources,
} from '../src/resources.js';
import type {
  CapturedResources,
  ResourceAssociation,
  ResourceCaptureRequest,
  ResourceFilePin,
  ResourceKey,
  ResourceOccurrence,
  ResourceResolveOptions,
} from '../src/resources.js';

// Cases capture real adopted packages and repeatedly validate their resources.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repository = fileURLToPath(new URL('../../../../..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'ia-resources-'));
const project = join(temporary, 'project'),
  foundation = join(temporary, 'foundation'),
  governance = join(temporary, 'governance');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const put = (root: string, path: string, bytes: string | Uint8Array) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
};
const resign = (value: CapturedResources): CapturedResources => {
  const { digest: _digest, ...body } = value;
  return { ...body, digest: sha(stableSerialize(body)) };
};
let capture: Capture, reader: Handle, envelope: CapturedResources, request: ResourceCaptureRequest;
let first: ResourceOccurrence, second: ResourceOccurrence, firstKey: ResourceKey, secondKey: ResourceKey;
let options: ResourceResolveOptions;

beforeAll(() => {
  mkdirSync(project);
  // Two real adopted packages share one resource filename. Definitions remain IA-only.
  for (const source of readInputs(repository, { adopted: [] }).sources) {
    if (source.path.startsWith('.ia/src/floor/')) continue;
    put(
      source.path.startsWith('.ia/src/systems/governance-system/') ? governance : foundation,
      source.path,
      source.text,
    );
  }
  const adopted = [adoptWorkspace(foundation, 'foundation'), adoptWorkspace(governance, 'governance')];
  capture = captureWorkspace(project, 'project', { adopted });
  reader = open(project, { cache: false, adopted });
  const inventory = resourceOccurrences(capture);
  first = inventory.occurrences.find((o) => o.identity.endsWith('/public-agent-system-steward'))!;
  second = inventory.occurrences.find((o) => o.identity.endsWith('/public-governance-system-steward'))!;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  firstKey = { source: first.source, revision: first.revision, path: 'references/guide.md' };
  secondKey = { source: second.source, revision: second.revision, path: 'references/guide.md' };
  const textA = '\uFEFF# Foundation\r\nLiteral data: <script>throw new Error("never run")</script>\r\n',
    textB = '# Governance\nSeparate package, same path.\n';
  put(foundation, firstKey.path, textA);
  put(governance, secondKey.path, textB);
  // A neighboring private file must never enter a capture implicitly.
  put(foundation, 'references/private.md', 'Private fixture data excluded by the host.');
  const pin = (key: ResourceKey, content: string): ResourceFilePin => ({
    key,
    bytes: Buffer.byteLength(content),
    sha256: sha(content),
    mediaType: 'text/markdown',
    encoding: 'utf8',
  });
  const association = (owner: ResourceOccurrence, key: ResourceKey): ResourceAssociation => ({
    owner,
    resources: [{ key, role: 'guide', order: 0, required: true, delivery: 'installed-reference' }],
  });
  request = {
    roots: [
      { source: first.source, revision: first.revision, root: foundation },
      { source: second.source, revision: second.revision, root: governance },
    ],
    files: [pin(firstKey, textA), pin(secondKey, textB)],
    associations: [association(first, firstKey), association(second, secondKey)],
  };
  envelope = captureResources(capture, request);
  options = {
    reader,
    within: reader.resolveScope().token,
    owners: [first, second],
    allowedResources: [firstKey, secondKey],
    expectedDigest: envelope.digest,
    maxBytes: RESOURCE_LIMITS.totalBytes,
  };
}, 30_000);
afterAll(() => {
  reader?.close();
  const target = resolve(temporary),
    parent = resolve(tmpdir());
  if (!target.startsWith(parent + sep) || !target.slice(parent.length + 1).startsWith('ia-resources-'))
    throw new Error('Unsafe fixture cleanup');
  rmSync(target, { recursive: true, force: true });
});

it('round-trips exact inert bytes, source pins and admitted occurrences without broadening Capture v1', () => {
  expect(verifyResources(JSON.stringify(envelope), capture)).toEqual(envelope);
  expect(
    captureResources(capture, {
      ...request,
      files: [...request.files].reverse(),
      associations: [...request.associations].reverse(),
    }),
  ).toEqual(envelope);
  expect(envelope.files[0]!.content.startsWith('\uFEFF')).toBe(true);
  expect(envelope.files.map((f) => Buffer.from(f.content, f.encoding))).toEqual(
    request.files.map((pin) =>
      readFileSync(join(pin.key.source === 'foundation' ? foundation : governance, pin.key.path)),
    ),
  );
  expect(envelope.sourceRevisions.map((s) => s.source)).toEqual(['foundation', 'governance', 'project']);
  expect(capture.sources.every((s) => s.path.endsWith('.ia'))).toBe(true);
  expect(JSON.stringify(envelope)).not.toContain('Private fixture data');
  expect(JSON.stringify(envelope)).not.toContain(temporary);
  expect(Object.isFrozen(envelope.files[0]!.key)).toBe(true);
  expect(resourceOccurrences(capture).occurrences).toContainEqual(second);
});

it('resolves both same-named files through distinct package keys and relocatable content references', () => {
  const result = resolveResources(envelope, capture, options);
  expect(result.items.map((r) => r.file.content)).toEqual(envelope.files.map((f) => f.content));
  expect(new Set(result.items.map((r) => r.reference)).size).toBe(2);
  expect(result.items[0]!.citation).toContain(`foundation@${first.revision}:references/guide.md#sha256=`);
  const original = join(temporary, 'artifact'),
    relocated = join(temporary, 'relocated');
  for (const item of result.items) put(original, item.reference, Buffer.from(item.file.content, item.file.encoding));
  cpSync(original, relocated, { recursive: true });
  for (const item of result.items) expect(sha(readFileSync(join(relocated, item.reference)))).toBe(item.file.sha256);
  expect(result.omissions).toEqual([]);
});

it('requires separate record and resource authority, including exact occurrence coordinates', () => {
  const within = reader.resolveScope({ identities: [first.identity] }).token;
  expect(() => resolveResources(envelope, capture, { ...options, within })).toThrow(ResourceError);
  expect(
    resolveResources(envelope, capture, { ...options, within, owners: [first], allowedResources: [firstKey] }).items,
  ).toHaveLength(1);
  expect(() =>
    resolveResources(envelope, capture, { ...options, owners: [first], allowedResources: [secondKey] }),
  ).toThrow(ResourceError);
  expect(() =>
    resolveResources(envelope, capture, { ...options, owners: [{ ...first, line: first.line + 1 }] }),
  ).toThrow(ResourceError);
  expect(() => resolveResources(envelope, capture, { ...options, owners: [first, first] })).toThrow(ResourceError);
});

it('rejects omitted, forged, foreign, stale and closed scope tokens', () => {
  const other = open(project, {
    cache: false,
    adopted: [adoptWorkspace(foundation, 'foundation'), adoptWorkspace(governance, 'governance')],
  });
  const foreign = other.resolveScope().token;
  for (const within of [undefined, '', 'forged', foreign])
    expect(() => resolveResources(envelope, capture, { ...options, within } as ResourceResolveOptions)).toThrow();
  const stale = other.resolveScope().token;
  put(project, '.ia/src/records/stale.ia', '# changed local source\n');
  other.refresh();
  expect(() => resolveResources(envelope, capture, { ...options, reader: other, within: stale })).toThrow();
  expect(() =>
    resolveResources(envelope, capture, { ...options, reader: other, within: other.resolveScope().token }),
  ).toThrow(/Native resource view differs/);
  other.close();
  expect(() => resolveResources(envelope, capture, { ...options, reader: other, within: foreign })).toThrow();
});

it('reserves required bytes before optional content and reports each omission explicitly', () => {
  const optionalKey = { ...firstKey, path: 'references/optional.md' };
  const mixed = resign({
    ...envelope,
    associations: [
      {
        owner: first,
        resources: [
          { key: firstKey, role: 'body', order: 0, required: false, delivery: 'inline' },
          { key: optionalKey, role: 'example', order: 0, required: false, delivery: 'inline' },
          { key: secondKey, role: 'guide', order: 0, required: true, delivery: 'installed-reference' },
        ],
      },
    ],
  });
  const onlyRequired = {
    ...options,
    owners: [first],
    expectedDigest: mixed.digest,
    maxBytes: envelope.files[1]!.bytes,
  };
  const result = resolveResources(mixed, capture, {
    ...onlyRequired,
    allowedResources: [firstKey, secondKey, optionalKey],
  });
  expect(result.items.map((i) => i.use.key)).toEqual([secondKey]);
  expect(result.omissions.map((o) => o.reason).sort()).toEqual(['budget', 'missing']);
  expect(
    resolveResources(mixed, capture, { ...onlyRequired, allowedResources: [secondKey] }).omissions.map((o) => o.reason),
  ).toEqual(['excluded', 'excluded']);
  expect(() => resolveResources(mixed, capture, { ...onlyRequired, maxBytes: onlyRequired.maxBytes - 1 })).toThrow(
    /Required resources exceed/,
  );
  expect(() => resolveResources(envelope, capture, { ...options, maxBytes: 0 })).toThrow(/Required resources exceed/);
});

it('detects resource-only changes independently of the native source revision', () => {
  const original = readFileSync(join(foundation, firstKey.path)),
    replacement = Buffer.from('# Updated resource\n');
  try {
    put(foundation, firstKey.path, replacement);
    expect(() => captureResources(capture, request)).toThrow(/pinned size\/hash/);
    const changed = captureResources(capture, {
      ...request,
      files: request.files.map((pin) =>
        pin.key.source === 'foundation' ? { ...pin, bytes: replacement.length, sha256: sha(replacement) } : pin,
      ),
    });
    expect(changed.nativeCaptureRevision).toBe(envelope.nativeCaptureRevision);
    expect(changed.digest).not.toBe(envelope.digest);
    expect(() => resolveResources(envelope, capture, { ...options, expectedDigest: changed.digest })).toThrow(/stale/);
    // Frozen snapshot verification never silently consults the changed live file.
    expect(verifyResources(envelope, capture)).toEqual(envelope);
  } finally {
    put(foundation, firstKey.path, original);
  }
});

it('refuses changed or substituted physical native packages', () => {
  const path = capture.sources
    .find((s) => s.path.startsWith(`.ia/adopted/foundation/${first.revision}/`))!
    .path.split(`/${first.revision}/`)[1]!;
  const original = readFileSync(join(foundation, path));
  try {
    put(foundation, path, Buffer.concat([original, Buffer.from('\n# changed\n')]));
    expect(() => captureResources(capture, request)).toThrow(/Physical native source differs/);
  } finally {
    put(foundation, path, original);
  }
  expect(() =>
    captureResources(capture, {
      ...request,
      roots: request.roots.map((r) => ({ ...r, root: r.source === 'foundation' ? governance : foundation })),
    }),
  ).toThrow(/Physical native source differs/);
});

describe('strict envelope refusals', () => {
  it.each([
    ['unknown field', (e: CapturedResources) => ({ ...e, unexpected: true })],
    ['unknown format', (e: CapturedResources) => ({ ...e, format: 'ia.captured-resources.v2' })],
    ['bad digest', (e: CapturedResources) => ({ ...e, digest: '0'.repeat(64) })],
    ['native revision', (e: CapturedResources) => ({ ...e, nativeCaptureRevision: '0'.repeat(64) })],
    ['incomplete vector', (e: CapturedResources) => ({ ...e, sourceRevisions: e.sourceRevisions.slice(1) })],
    [
      'tampered content',
      (e: CapturedResources) => ({ ...e, files: e.files.map((f) => ({ ...f, content: 'changed' })) }),
    ],
    [
      'media encoding mismatch',
      (e: CapturedResources) => ({ ...e, files: e.files.map((f) => ({ ...f, encoding: 'base64' })) }),
    ],
    ['required absent', (e: CapturedResources) => ({ ...e, files: [] })],
    ['duplicate file', (e: CapturedResources) => ({ ...e, files: [e.files[0], ...e.files] })],
    ['unordered inventory', (e: CapturedResources) => ({ ...e, files: [...e.files].reverse() })],
    [
      'unadmitted owner',
      (e: CapturedResources) => ({
        ...e,
        associations: e.associations.map((a) => ({
          ...a,
          owner: { ...a.owner, identity: 'agent-system/agent/steward/absent' },
        })),
      }),
    ],
    ['duplicate owner', (e: CapturedResources) => ({ ...e, associations: [...e.associations, e.associations[0]] })],
    [
      'duplicate use',
      (e: CapturedResources) => ({
        ...e,
        associations: e.associations.map((a) => ({ ...a, resources: [...a.resources, a.resources[0]] })),
      }),
    ],
  ])('rejects %s', (_name, mutate) => {
    expect(() => verifyResources(mutate(envelope), capture)).toThrow(ResourceError);
  });

  it('rejects duplicate decoded JSON keys, malformed JSON and excessive depth/bytes', () => {
    const json = JSON.stringify(envelope);
    for (const input of [
      json.replace('{', '{"f\\u006frmat":"ia.captured-resources.v1",'),
      json + '{}',
      json.slice(0, -1) + ',}',
      '['.repeat(18) + '0' + ']'.repeat(18),
      ' '.repeat(RESOURCE_LIMITS.serializedBytes + 1),
    ])
      expect(() => verifyResources(input, capture)).toThrow(ResourceError);
  });

  it.each([
    '../outside.md',
    '/absolute.md',
    'C:/absolute.md',
    'references\\guide.md',
    'references/./guide.md',
    'references//guide.md',
    'references/guide.md.',
    'references/con.txt',
    'references/cafe\u0301.md',
  ])('rejects unsafe path %s before reading', (path) => {
    const key = { ...firstKey, path };
    expect(() =>
      captureResources(capture, {
        ...request,
        files: [{ ...request.files[0]!, key }],
        associations: [{ owner: first, resources: [{ ...request.associations[0]!.resources[0]!, key }] }],
      }),
    ).toThrow(ResourceError);
  });

  it('rejects case aliases, unassociated files, oversized selections and relative roots', () => {
    const alias = { ...firstKey, path: 'references/GUIDE.md' };
    expect(() =>
      captureResources(capture, {
        ...request,
        files: [...request.files, { ...request.files[0]!, key: alias }],
        associations: [
          ...request.associations,
          {
            owner: resourceOccurrences(capture).occurrences.find(
              (o) => o.identity !== first.identity && o.identity !== second.identity,
            )!,
            resources: [{ key: alias, role: 'guide', order: 0, required: true, delivery: 'inline' }],
          },
        ],
      }),
    ).toThrow(ResourceError);
    expect(() => captureResources(capture, { ...request, associations: [] })).toThrow(ResourceError);
    expect(() =>
      captureResources(capture, {
        ...request,
        files: [{ ...request.files[0]!, bytes: RESOURCE_LIMITS.fileBytes + 1 }],
      }),
    ).toThrow(ResourceError);
    expect(() =>
      captureResources(capture, { ...request, files: Array.from({ length: 257 }, () => request.files[0]!) }),
    ).toThrow(ResourceError);
    expect(() =>
      captureResources(capture, { ...request, roots: request.roots.map((r) => ({ ...r, root: '.' })) }),
    ).toThrow(ResourceError);
  });
});

it('rejects hard links and directory junctions/symlinks even for matching pinned bytes', () => {
  const linkPath = 'references/hardlink.md',
    junctionPath = 'alias/guide.md';
  linkSync(join(foundation, firstKey.path), join(foundation, linkPath));
  symlinkSync(
    join(foundation, 'references'),
    join(foundation, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  try {
    for (const path of [firstKey.path, linkPath, junctionPath]) {
      const key = { ...firstKey, path };
      expect(() =>
        captureResources(capture, {
          roots: [request.roots[0]!],
          files: [{ ...request.files[0]!, key }],
          associations: [{ owner: first, resources: [{ ...request.associations[0]!.resources[0]!, key }] }],
        }),
      ).toThrow(ResourceError);
    }
  } finally {
    rmSync(join(foundation, linkPath));
    rmSync(join(foundation, 'alias'));
  }
});

it('preserves binary bytes and rejects noncanonical base64 and invalid UTF-8', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]),
    key = { ...firstKey, path: 'references/inert.png' };
  put(foundation, key.path, bytes);
  const binary = captureResources(capture, {
    roots: [request.roots[0]!],
    files: [{ key, bytes: bytes.length, sha256: sha(bytes), mediaType: 'image/png', encoding: 'base64' }],
    associations: [
      { owner: first, resources: [{ key, role: 'image', order: 0, required: true, delivery: 'installed-reference' }] },
    ],
  });
  expect(Buffer.from(verifyResources(JSON.stringify(binary), capture).files[0]!.content, 'base64')).toEqual(bytes);
  expect(() =>
    verifyResources({ ...binary, files: binary.files.map((f) => ({ ...f, content: f.content + '\n' })) }, capture),
  ).toThrow(ResourceError);
  expect(() =>
    captureResources(capture, {
      roots: [request.roots[0]!],
      files: [{ key, bytes: bytes.length, sha256: sha(bytes), mediaType: 'text/plain', encoding: 'utf8' }],
      associations: binary.associations,
    }),
  ).toThrow(ResourceError);
});

it('associates system references with exact local occurrences beside an adopted dependency', () => {
  const adopted = [adoptWorkspace(governance, 'governance')],
    local = captureWorkspace(foundation, 'local', { adopted });
  const inventory = resourceOccurrences(local),
    owner = inventory.occurrences.find((o) => o.identity.endsWith('/system/agent-system'))!;
  expect(owner).toBeDefined();
  expect(owner.source).toBe('local');
  expect(owner.path).toBe('.ia/src/systems/agent-system/system.ia');
  const key = { source: 'local', revision: local.revision, path: firstKey.path };
  const captured = captureResources(local, {
    roots: [{ source: 'local', revision: local.revision, root: foundation }],
    files: [{ ...request.files[0]!, key }],
    associations: [{ owner, resources: [{ key, role: 'guide', order: 0, required: true, delivery: 'inline' }] }],
  });
  const db = open(foundation, { cache: false, adopted });
  try {
    const result = resolveResources(captured, local, {
      reader: db,
      within: db.resolveScope({ identities: [owner.identity] }).token,
      owners: [owner],
      allowedResources: [key],
      expectedDigest: captured.digest,
      maxBytes: request.files[0]!.bytes,
    });
    expect(result.items[0]!.owner).toEqual(owner);
    expect(result.items[0]!.file.content).toBe(envelope.files[0]!.content);
  } finally {
    db.close();
  }
});

it('rejects forged adopted revisions and source identities even in a correctly rehashed native capture', () => {
  const { revision: _revision, ...body } = capture;
  const changed = {
    ...body,
    sources: body.sources.map((s, index) =>
      index === body.sources.findIndex((row) => row.path.startsWith('.ia/adopted/'))
        ? { ...s, text: s.text + '\n# changed\n' }
        : s,
    ),
  };
  expect(() => resourceOccurrences({ ...changed, revision: digest(changed) })).toThrow(
    /Adopted source revision differs/,
  );
  const collision = { ...body, id: 'foundation' };
  expect(() => resourceOccurrences({ ...collision, revision: digest(collision) })).toThrow(
    /Conflicting adopted resource source/,
  );
});

it('omits a tied native owner from the admissible resource inventory', () => {
  const local = captureWorkspace(foundation, 'local', { adopted: [adoptWorkspace(governance, 'governance')] });
  const source = local.sources.find((s) => s.path === first.path)!;
  const { revision: _revision, ...body } = local;
  const changed = {
    ...body,
    sources: [...local.sources, { ...source, path: source.path.replace(/\.ia$/, '-duplicate.ia') }],
  };
  expect(
    resourceOccurrences({ ...changed, revision: digest(changed) }).occurrences.some(
      (o) => o.identity === first.identity,
    ),
  ).toBe(false);
});

it('accepts a maximum-size escaped text file and refuses aggregate overflow before file reads', () => {
  const content = '\u0000'.repeat(RESOURCE_LIMITS.fileBytes);
  const maximum = resign({
    ...envelope,
    files: [
      { ...envelope.files[0]!, content, bytes: RESOURCE_LIMITS.fileBytes, sha256: sha(content) },
      envelope.files[1]!,
    ],
  });
  expect(verifyResources(JSON.stringify(maximum), capture).files[0]!.bytes).toBe(RESOURCE_LIMITS.fileBytes);
  const files = Array.from({ length: 17 }, (_, index) => ({
    ...request.files[0]!,
    key: { ...firstKey, path: `references/large-${index}.md` },
    bytes: RESOURCE_LIMITS.fileBytes,
  }));
  const associations: ResourceAssociation[] = [
    {
      owner: first,
      resources: files.map((f, order) => ({ key: f.key, role: 'guide', order, required: true, delivery: 'inline' })),
    },
  ];
  expect(() => captureResources(capture, { roots: [request.roots[0]!], files, associations })).toThrow(
    /oversized resource file selection/,
  );
});
