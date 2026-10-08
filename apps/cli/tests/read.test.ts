/**
 * `ia read` (position-and-projection §5, design row 23), end to end against the repository's own records, copies of
 * the committed loop fixture and a copy of the conformance corpus whose work records name documents.
 *
 * The exit evidence of plan task ia-read-verb: `ia read agent-system/binding/agent/public-agent-system-steward` prints
 * the says text only. A read writes nothing and certifies nothing; structure stays in `ia inspect`.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { open, readInputs } from '@inventarch/db';
import { DISTRIBUTION_LIMITS } from '@inventarch/db/distribution';
// Through the root development dependency, as the db pins an adopted revision.
import { stableSerialize } from '@inventarch/graph';
import { Door, readBody } from '@inventarch/runtime';
import type { DoorOptions, DoorResponse, ReadBody } from '@inventarch/runtime';
import { parseArguments } from '../src/args.js';
import { findCommand } from '../src/commands.js';
import { NOT_CERTIFIED, readEnvelope, readOptions, readRefusal } from '../src/read.js';
import { quote } from '../src/render.js';
import { cleanup, commandsIn, nextArgv, repository, run, scratch, workspace } from './workspace-fixture.js';

afterAll(cleanup);

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const STEWARD = 'agent-system/binding/agent/public-agent-system-steward';
const LOOP_STEWARD = 'agent-system/binding/agent/agent-steward';
const PROCEDURE = 'governance-system/definition/procedure/sample-procedure';
const CONTRACT = 'compliance-system/contract/signature/foundation-authoring-contract';
const SPECS = '.ia/src/systems/work-system/records/located.ia';
const SECTION = '## Reading a body\n\nThe body behind a locator.\n\n### Detail\n\nStill this section.\n\n';
const DOCUMENT = `# Located\n\nIntro.\n\n${SECTION}## Next\n\nAnother section.\n`;

interface Envelope {
  readonly version: number;
  readonly locator: string;
  readonly identity: string;
  readonly kind: string;
  readonly path?: string;
  readonly digest: string;
  readonly body: string;
  readonly certified: boolean;
}
interface RefusalBody {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly exit: number;
  readonly where: { readonly path: string | null; readonly line: number | null; readonly identity: string | null };
  readonly next: string;
}
/** `ia read --json`: one value on stdout and nothing on stderr. */
async function read(root: string, locator: string, exitCode = 0, extra: readonly string[] = []) {
  const result = await run(['read', locator, ...extra, '--root', root, '--json']);
  expect(result.exitCode, result.stdout).toBe(exitCode);
  expect(result.stderr).toBe('');
  expect(result.stdout.slice(0, -1)).not.toContain('\n');
  return JSON.parse(result.stdout) as Envelope & RefusalBody;
}
/** The runtime Door's `read` of `locator` on `root`, through its own workspace reader and the manifest's mounts. */
function doorRead(root: string, locator: string, options: DoorOptions = {}, includeRuntime = false): DoorResponse {
  const door = new Door(root, { cache: false, ...options });
  try {
    return door.request({ operation: 'read', params: { locator, ...(includeRuntime ? { includeRuntime } : {}) } });
  } finally {
    door.close();
  }
}
/** The Door's body as `ia read --json` prints one, so the two are compared byte for byte. */
const doorEnvelope = (root: string, locator: string): unknown => {
  const got = doorRead(root, locator);
  if (!got.ok) throw new Error(`${got.code}: ${got.message}`);
  return readEnvelope(got.result as ReadBody);
};
/** Every file below `directory` with its bytes, so a read is shown to write nothing anywhere in the workspace. */
const tree = (directory: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((dirent) => dirent.isFile())
      .map((dirent) => {
        const path = join(dirent.parentPath, dirent.name);
        return [path, sha256(readFileSync(path))];
      }),
  );
const spec = (name: string, source: string): string =>
  `\n@spec ${name}\n  meaning\n    says "The ${name} statement."\n    answers "Where is ${name} written?"\n  work\n    title "${name}"\n    status draft\n    source "${source}"\n`;
/** The conformance corpus, with work records whose source locators name documents in, out of and under a link. */
function located(): string {
  const root = resolve(scratch('read'), 'workspace');
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, '.ia/src'), { recursive: true });
  mkdirSync(resolve(root, '.ia/src/systems/work-system/records'), { recursive: true });
  writeFileSync(
    resolve(root, SPECS),
    [
      '#! ia 1.0\n',
      spec('whole-spec', 'docs/located.md'),
      spec('section-spec', 'docs/located.md#reading-a-body'),
      spec('missing-anchor-spec', 'docs/located.md#no-such-heading'),
      spec('absent-spec', 'docs/absent.md'),
      spec('escaping-spec', '../outside.md'),
      spec('linked-spec', 'linked/located.md'),
    ].join(''),
  );
  mkdirSync(resolve(root, 'docs'));
  writeFileSync(resolve(root, 'docs/located.md'), DOCUMENT);
  writeFileSync(resolve(root, '../outside.md'), '# Outside\n');
  // A directory reached through a junction, which the workspace file reader refuses to read through.
  const target = scratch('read-link-target');
  writeFileSync(resolve(target, 'located.md'), DOCUMENT);
  symlinkSync(target, resolve(root, 'linked'), 'junction');
  return root;
}

it('prints the says text only for the plan exit-evidence identity, with its digest and the not-certified line', async () => {
  const says = 'Identifies the owner of agent-system contracts in this example.';
  const human = await run(['read', STEWARD, '--root', repository]);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(human.stderr).toBe('');
  const [header, facts, ...rest] = human.stdout.trimStart().split('\n\n');
  // The body follows the header and its facts exactly as read: the says text, and none of the answers, sections or
  // fields.
  expect(rest.join('\n\n')).toBe(`${says}\n`);
  expect(header).toBe(`Read  ${STEWARD}`);
  expect(facts).toContain('record');
  expect(human.stdout).toContain(`sha256 ${sha256(says).slice(0, 12)}`);
  // The design's wording (position-and-projection §5, IM-43), not only whatever the constant holds.
  expect(NOT_CERTIFIED).toBe('body not certified by this read');
  expect(human.stdout).toContain('body not certified by this read');
  for (const structure of ['Who owns the agent and mandate words', 'meaning', 'governance', 'applies'])
    expect(human.stdout, structure).not.toContain(structure);
  const machine = await read(repository, STEWARD);
  expect(Object.keys(machine)).toEqual(['version', 'locator', 'identity', 'kind', 'digest', 'body', 'certified']);
  expect(machine).toEqual({
    version: 1,
    locator: STEWARD,
    identity: STEWARD,
    kind: 'record',
    digest: sha256(says),
    body: says,
    certified: false,
  });
});

it('reads every locator form from a copy of the loop fixture and writes nothing', async () => {
  const root = workspace(),
    before = tree(root);
  // The steward's governance clause is structure; its body is the says text alone.
  expect(await read(root, LOOP_STEWARD)).toMatchObject({
    identity: LOOP_STEWARD,
    kind: 'record',
    body: 'The designated expert for expert agent identities and bounded mandates.',
  });
  const cell = await read(root, `${PROCEDURE}#act/Decision`);
  expect(cell).toEqual({
    version: 1,
    locator: `${PROCEDURE}#act/Decision`,
    identity: PROCEDURE,
    kind: 'record',
    digest: sha256('Sample fixture statement 18.'),
    body: 'Sample fixture statement 18.',
    certified: false,
  });
  expect(await read(root, `${CONTRACT}#REQ-FOUNDATION-INPUT`)).toMatchObject({
    identity: CONTRACT,
    body: 'Supply the intended owner, complete native registry closure and authored record source.',
  });
  const line = await read(root, '.ia/src/systems/agent-system/steward.ia:5');
  expect(line).toMatchObject({ locator: '.ia/src/systems/agent-system/steward.ia:5', identity: LOOP_STEWARD });
  // Human output names the locator beside `record` when it is not the identity alone, wrapped to the width.
  const human = await run(['read', `${PROCEDURE}#act/Decision`, '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout.replace(/\s+/g, ' ')).toContain(` record, ${PROCEDURE}#act/Decision sha256 `);
  expect(human.stdout.endsWith('\n\nSample fixture statement 18.\n')).toBe(true);
  // Nothing here is at runtime placement, so the flag reads the same body.
  expect(await read(root, LOOP_STEWARD, 0, ['--include-runtime'])).toEqual(await read(root, LOOP_STEWARD));
  expect(tree(root)).toEqual(before);
});

it('reads the document a source locator names, or the section under its markdown anchor', async () => {
  const root = located(),
    before = tree(root);
  const whole = await read(root, 'work-system/contract/spec/whole-spec');
  expect(Object.keys(whole)).toEqual(['version', 'locator', 'identity', 'kind', 'path', 'digest', 'body', 'certified']);
  expect(whole).toEqual({
    version: 1,
    locator: 'work-system/contract/spec/whole-spec',
    identity: 'work-system/contract/spec/whole-spec',
    kind: 'document',
    path: 'docs/located.md',
    digest: sha256(readFileSync(resolve(root, 'docs/located.md'))),
    body: DOCUMENT,
    certified: false,
  });
  expect(await read(root, 'work-system/contract/spec/section-spec')).toMatchObject({
    kind: 'document',
    path: 'docs/located.md',
    digest: sha256(SECTION),
    body: SECTION,
  });
  // Human output prints the document's path, its digest and the not-certified line, then the section as read.
  const human = await run(['read', 'work-system/contract/spec/section-spec', '--root', root]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toMatch(/document {2}docs\/located\.md/);
  expect(human.stdout).toContain('body not certified by this read');
  expect(human.stdout.endsWith(`\n\n${SECTION}`)).toBe(true);
  expect(tree(root)).toEqual(before);
});

it('refuses an unreachable locator, a path escape and a link with the record to repair', async () => {
  const root = located(),
    rooted = `--root ${quote(root)}`;
  const refused = async (name: string, path: string | null, pattern: RegExp): Promise<void> => {
    const identity = `work-system/contract/spec/${name}`;
    const body = await read(root, identity, 3);
    expect(body, name).toMatchObject({ ok: false, code: 'IA-RUNTIME-READ-UNREACHABLE', exit: 3 });
    expect(body.where, name).toEqual({ path: path ?? realpathSync(root), line: null, identity });
    expect(body.message, name).toMatch(pattern);
    expect(commandsIn(body.next), name).toEqual([`ia inspect ${identity} ${rooted}`]);
  };
  await refused('missing-anchor-spec', 'docs/located.md', /selects heading #no-such-heading, which docs\/located\.md/);
  await refused('absent-spec', 'docs/absent.md', /docs\/absent\.md, cannot be read: Missing input docs\/absent\.md$/);
  await refused('escaping-spec', null, /\.\.\/outside\.md, is outside the workspace$/);
  await refused('linked-spec', 'linked/located.md', /cannot be read: Link\/junction is not allowed/);
  // A file the locator names is restored or the locator corrected; a path outside the workspace names no file to restore.
  expect((await read(root, 'work-system/contract/spec/absent-spec', 3)).next).toBe(
    `Restore docs/absent.md or correct the record's locator, which "ia inspect work-system/contract/spec/absent-spec ${rooted}" locates at its source line.`,
  );
  expect((await read(root, 'work-system/contract/spec/escaping-spec', 3)).next).toBe(
    `Correct the record's locator, which "ia inspect work-system/contract/spec/escaping-spec ${rooted}" locates at its source line.`,
  );
  // The named command runs: it shows the record whose locator needs the repair.
  const inspect = await run(nextArgv((await read(root, 'work-system/contract/spec/absent-spec', 3)).next));
  expect(inspect.exitCode).toBe(0);
  expect(inspect.stdout).toContain(SPECS);
  // Human output names the same command on its `→` line.
  const human = await run(['read', 'work-system/contract/spec/absent-spec', '--root', root]);
  expect(human.exitCode).toBe(3);
  expect(human.stderr).toContain(`"ia inspect work-system/contract/spec/absent-spec ${rooted}"`);
});

it("reads an adopted record's document from the directory .ia/workspace.json binds its mount to", async () => {
  const root = resolve(scratch('read-adopted'), 'workspace'),
    vendor = 'vendor/foundation',
    guide = 'authoring-system/definition/authoring-guide/spec-guide';
  cpSync(resolve(repository, 'examples/conformance/native'), resolve(root, vendor, '.ia/src'), { recursive: true });
  mkdirSync(resolve(root, vendor, '.ia/src/systems/authoring-system/records'));
  writeFileSync(
    resolve(root, vendor, '.ia/src/systems/authoring-system/records/guide.ia'),
    '#! ia 1.0\n@authoring-guide spec-guide\n  meaning\n    says "Guides a spec."\n    answers "How is a spec authored?"\n  reference\n    owner work-system\n    word spec\n    schema @schema spec\n    document "docs/spec-guide.md#writing"\n  guidance\n    select-when "A spec."\n    avoid-when "Not a spec."\n    consider "Fields."\n  relationships\n    cites @schema spec\n',
  );
  mkdirSync(resolve(root, vendor, 'docs'));
  writeFileSync(resolve(root, vendor, 'docs/spec-guide.md'), '# Guide\n\n## Writing\n\nState the status.\n');
  mkdirSync(resolve(root, '.ia/src'), { recursive: true });
  // The pin covers the mount's `.ia/src` sources, its floor excluded, as the db computes it.
  const pinned = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = sha256(stableSerialize(pinned));
  writeFileSync(
    resolve(root, '.ia/workspace.json'),
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  const before = tree(root);
  expect(await read(root, guide)).toEqual({
    version: 1,
    locator: guide,
    identity: guide,
    kind: 'document',
    path: `${vendor}/docs/spec-guide.md`,
    digest: sha256('## Writing\n\nState the status.\n'),
    body: '## Writing\n\nState the status.\n',
    certified: false,
  });
  // The runtime Door binds the mount from the same manifest and reads the same body and digest.
  expect(doorEnvelope(root, guide)).toEqual(await read(root, guide));
  // Nothing is written, and no directory appears under the label the mount's sources carry.
  expect(tree(root)).toEqual(before);
  expect(existsSync(resolve(root, '.ia/adopted'))).toBe(false);
});

// Plan risk "two file readers for read": the Door reads through db readWorkspaceBytes and this verb through the
// distribution workspace reader, so the two are held to the same bodies, digests and refusals.
it('agrees with the runtime Door read on body and digest, on link, nonportable-path and size refusals, and on a runtime placement', async () => {
  const root = located();
  for (const locator of [
    LOOP_STEWARD,
    'floor/definition/system/agent-system',
    `${PROCEDURE}#act/Decision`,
    `${CONTRACT}#REQ-FOUNDATION-INPUT`,
    '.ia/src/systems/agent-system/steward.ia:3',
    `${SPECS}:4`,
    'work-system/contract/spec/whole-spec',
    'work-system/contract/spec/section-spec',
  ])
    expect(doorEnvelope(root, locator), locator).toEqual(await read(root, locator));
  // Refusals: both readers refuse the record's document with the same code, for the same record and document path, and
  // give the same reason up to the reader's own words.
  const refusesAlike = async (identity: string, source: string, cause: RegExp): Promise<void> => {
    const verb = await read(root, identity, 3),
      door = doorRead(root, identity);
    expect(door, identity).toMatchObject({ ok: false, code: verb.code, identity, path: verb.where.path });
    const reason = `The work.source of ${identity}, ${source}, cannot be read: `;
    expect(verb.message.startsWith(reason) && !door.ok && door.message.startsWith(reason), identity).toBe(true);
    expect(!door.ok && door.message.slice(reason.length), identity).toMatch(cause);
  };
  // A link: both refuse to read through the junction.
  await refusesAlike(
    'work-system/contract/spec/linked-spec',
    'linked/located.md',
    /^IA-DB-PATH-UNSAFE: Symlink\/junction traversal is not admitted: linked\/located\.md$/,
  );
  // Nonportable paths, which name files that exist: both refuse a decomposed (NFD) name, and a colon, which on Windows
  // names an alternate data stream of docs/located.md and elsewhere a file of its own. And the bound: a document of
  // exactly the workspace file reader's limit reads alike, and one byte more is refused by both.
  const nfd = 'docs/café.md',
    stream = 'docs/located.md:hidden';
  writeFileSync(resolve(root, nfd), '# Decomposed\n');
  writeFileSync(resolve(root, stream), '# Hidden\n');
  writeFileSync(resolve(root, 'docs/bound.md'), 'b'.repeat(DISTRIBUTION_LIMITS.metadata));
  writeFileSync(resolve(root, 'docs/oversized.md'), 'o'.repeat(DISTRIBUTION_LIMITS.metadata + 1));
  writeFileSync(
    resolve(root, '.ia/src/systems/work-system/records/portable.ia'),
    [
      '#! ia 1.0\n',
      spec('nfd-spec', nfd),
      spec('stream-spec', stream),
      spec('bound-spec', 'docs/bound.md'),
      spec('oversized-spec', 'docs/oversized.md'),
    ].join(''),
  );
  for (const [name, source] of [
    ['nfd-spec', nfd],
    ['stream-spec', stream],
  ] as const)
    await refusesAlike(`work-system/contract/spec/${name}`, source, /^IA-DB-PATH-UNSAFE: Nonportable workspace path: /);
  const bound = 'work-system/contract/spec/bound-spec';
  expect(doorEnvelope(root, bound)).toEqual(await read(root, bound));
  await refusesAlike(
    'work-system/contract/spec/oversized-spec',
    'docs/oversized.md',
    new RegExp(`^IA-DB-SOURCE-UNAVAILABLE: File exceeds ${DISTRIBUTION_LIMITS.metadata} bytes: docs/oversized\\.md$`),
  );
  // A runtime placement: this verb opens every source at its default placement, so its own reader options read the
  // handle the Door opens with the placement, and the two answer alike with and without the flag.
  const principle = 'governance-system/governance/principle/sample-principle',
    locations: NonNullable<DoorOptions['locations']> = {
      '.ia/src/systems/governance-system/records/sample-principle.ia': {
        placement: { kind: 'runtime', band: 0, reach: '' },
        provenance: 'runtime',
      },
    };
  const handle = open(root, { cache: false, locations });
  try {
    for (const includeRuntime of [false, true]) {
      const verbs = readBody(handle, principle, readOptions(root, handle, includeRuntime));
      expect(doorRead(root, principle, { locations }, includeRuntime), String(includeRuntime)).toEqual(
        verbs.ok ? { ok: true, result: verbs.body } : verbs,
      );
      expect(verbs, String(includeRuntime)).toMatchObject(
        includeRuntime ? { ok: true } : { ok: false, code: 'IA-RUNTIME-READ-PLACEMENT', identity: principle },
      );
    }
  } finally {
    handle.close();
  }
});

it('refuses a locator no admitted record answers, a missing fragment and a malformed locator, each naming one command', async () => {
  // The loop fixture with its foreign record, whose source admission refuses.
  const root = workspace({ foreign: true }),
    rooted = `--root ${quote(root)}`;
  const unadmitted = await read(root, 'agent-system/binding/agent/absent', 1);
  expect(unadmitted).toMatchObject({
    code: 'IA-RUNTIME-READ-UNADMITTED',
    message: "agent-system/binding/agent/absent is not in this workspace's sources",
    where: { path: realpathSync(root), line: null, identity: 'agent-system/binding/agent/absent' },
  });
  // An identity no source holds names the nearest admitted one, as `ia inspect` names it, or else the overview.
  expect(commandsIn(unadmitted.next)).toEqual([`ia read ${LOOP_STEWARD} ${rooted}`]);
  const inspected = JSON.parse(
    (await run(['inspect', 'agent-system/binding/agent/absent', '--root', root, '--json'])).stdout,
  ) as RefusalBody;
  expect(commandsIn(inspected.next)).toEqual([`ia inspect ${LOOP_STEWARD} ${rooted}`]);
  const distant = await read(root, 'nope/nope/nope/nope', 1);
  expect(commandsIn(distant.next)).toEqual([`ia inspect ${rooted}`]);
  // An identity a source holds whose record admission refused is in the workspace's sources: both verbs name the
  // validation that says why.
  const foreign = 'governance-system/definition/procedure/foreign-procedure';
  const refused = await read(root, foreign, 1);
  expect(refused).toMatchObject({
    code: 'IA-RUNTIME-READ-UNADMITTED',
    message: `${foreign} is in this workspace's sources, but admission refused it`,
    where: { path: '.ia/src/systems/agent-system/records/foreign.ia', line: 2, identity: foreign },
  });
  expect(commandsIn(refused.next)).toEqual([`ia validate ${rooted}`]);
  const refusedInspect = JSON.parse((await run(['inspect', foreign, '--root', root, '--json'])).stdout) as RefusalBody;
  expect(refusedInspect).toMatchObject({ code: 'IA-DB-SOURCE-UNAVAILABLE', exit: 1 });
  expect(commandsIn(refusedInspect.next)).toEqual([`ia validate ${rooted}`]);
  // A line locator's path is relative to the root; an absolute path inside the root reads the path it names, and the
  // locator is echoed as given.
  const absolute = `${resolve(realpathSync(root), '.ia/src/systems/agent-system/steward.ia')}:3`;
  const steward = await read(root, absolute);
  const relativeRead = await read(root, '.ia/src/systems/agent-system/steward.ia:3');
  expect(steward).toMatchObject({ locator: absolute, kind: 'record', identity: relativeRead.identity });
  expect(steward.digest).toBe(relativeRead.digest);
  // A line no admitted record spans: of an admitted source, a source whose records admission refused, or no source.
  for (const [path, message, command] of [
    [
      '.ia/src/systems/agent-system/steward.ia',
      'the admitted records of .ia/src/systems/agent-system/steward.ia span other lines',
      `ia inspect --path .ia/src/systems/agent-system/steward.ia ${rooted}`,
    ],
    [
      '.ia/src/systems/agent-system/records/foreign.ia',
      'admission refused records of .ia/src/systems/agent-system/records/foreign.ia',
      `ia validate ${rooted}`,
    ],
    [
      '.ia/src/systems/agent-system/absent.ia',
      "no record of this workspace's sources is in .ia/src/systems/agent-system/absent.ia",
      `ia inspect ${rooted}`,
    ],
  ] as const) {
    const line = await read(root, `${path}:1`, 1);
    expect(line, path).toMatchObject({
      code: 'IA-RUNTIME-READ-UNADMITTED',
      message: `No admitted record spans ${path}:1; ${message}`,
      where: { path, line: 1, identity: null },
    });
    expect(commandsIn(line.next), path).toEqual([command]);
    expect((await run(nextArgv(line.next))).exitCode, path).toBe(command.startsWith('ia validate') ? 1 : 0);
  }
  for (const [locator, message] of [
    [`${LOOP_STEWARD}#act/Decision`, `${LOOP_STEWARD} has no cell act/Decision`],
    [`${CONTRACT}#REQ-ABSENT`, `${CONTRACT} has no requirement REQ-ABSENT`],
  ] as const) {
    const fragment = await read(root, locator, 1);
    expect(fragment, locator).toMatchObject({ code: 'IA-RUNTIME-READ-FRAGMENT', message });
    expect(fragment.where.identity, locator).toBe(locator.split('#')[0]);
    expect(commandsIn(fragment.next), locator).toEqual([`ia inspect ${locator.split('#')[0]} ${rooted}`]);
  }
  // A malformed locator is usage, refused before the workspace is opened, so even an absent root is not reached.
  const malformed = await run(['read', 'Not/An/Identity', '--root', resolve(root, 'absent'), '--json']);
  expect(malformed.exitCode).toBe(2);
  expect(JSON.parse(malformed.stdout)).toMatchObject({ code: 'IA-CLI-USAGE' });
  expect(commandsIn((JSON.parse(malformed.stdout) as RefusalBody).next)).toEqual(['ia read --help']);
  expect((await run(['read', '--root', root, '--json'])).exitCode).toBe(2);
});

it('names the read that includes a runtime-placed record, whose flag the runtime honours', () => {
  const command = findCommand('read')!,
    locator = 'governance-system/governance/principle/sample-principle';
  const context = { args: parseArguments([locator, '--root', 'a b'], command.grammar) };
  const refusal = readRefusal(
    {
      ok: false,
      code: 'IA-RUNTIME-READ-PLACEMENT',
      message: `${locator} is at runtime placement (band 0), which a read includes only when asked to`,
      identity: locator,
      path: '.ia/src/systems/governance-system/records/sample-principle.ia',
      line: 3,
    },
    context,
    '/w',
  );
  expect(refusal).toMatchObject({
    code: 'IA-RUNTIME-READ-PLACEMENT',
    exit: 3,
    where: { path: '.ia/src/systems/governance-system/records/sample-principle.ia', line: 3, identity: locator },
  });
  expect(commandsIn(refusal.next!)).toEqual([`ia read ${locator} --include-runtime --root "a b"`]);
});
