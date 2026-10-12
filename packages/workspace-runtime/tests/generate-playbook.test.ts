import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { open } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { PACKET_MARKER } from '@inventarch/runtime';
import type { PacketDefinition } from '@inventarch/runtime';
import { adoptWorkspace } from '../src/corpus.js';
import { copyPublicLanguageFixture } from '../../../tools/native/public-fixture.js';
import {
  generateAgentProfiles,
  generateDefinitions,
  generateHostSet,
  generateHooks,
  generateHookSet,
  generatePlaybookSkills,
  hookDeclaration,
} from '../src/generate/index.js';

// Milestone generation-binding task generation-playbook-skill (plan amendments C8 and C12): the authored `@playbook` of
// apps/cli's composition fixture renders one skill per host. The fixture's `.ia/src` is laid over the conformance
// corpus adopted at band 90, as an installed base would be, so its records are the authored ones and the corpus's own
// playbook is an adopted one.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repository = resolve(import.meta.dirname, '../../..'),
  FIXTURE = resolve(repository, 'apps/cli/tests/fixtures/composition-workspace/.ia/src'),
  NATIVE = resolve(repository, 'examples/conformance/native'),
  PLAYBOOK = readFileSync(resolve(FIXTURE, 'playbook.ia'), 'utf8'),
  IDENTITY = 'governance-system/definition/procedure/note-review',
  temporary = mkdtempSync(join(tmpdir(), 'ia-generate-')),
  handles: Handle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
/**
 * The fixture over the adopted conformance corpus: `authored` replaces or adds files under the workspace root, and
 * `adopted` adds files to the base before it is pinned. Admission must find no error.
 */
function fixture(
  authored: Readonly<Record<string, string | null>> = {},
  adopted: Readonly<Record<string, string>> = {},
): { readonly root: string; readonly db: Handle; readonly within: string } {
  const base = mkdtempSync(join(temporary, 'w-')),
    root = join(base, 'root'),
    vendor = join(base, 'vendor');
  cpSync(NATIVE, join(vendor, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(adopted)) put(vendor, path, text);
  cpSync(FIXTURE, join(root, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(authored))
    if (text === null) rmSync(resolve(root, path));
    else put(root, path, text);
  const db = open(root, { cache: false, adopted: [adoptWorkspace(vendor, 'foundation')] });
  handles.push(db);
  expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  return { root, db, within: db.resolveScope().token };
}

const SKILL = `---
name: "note-review"
description: "Review one of the demo workspace's notes and report what the review finds."
---

${PACKET_MARKER}

# note-review

- playbook \`${IDENTITY}\`

## orient

- Memory (primary): Recall the findings already reported on the note.
- Attention: Notice which records the note cites.

## plan

- Inference (primary): Infer which of the note's claims its cited records can confirm.
- Decision: Decide which claims to check first.

## act

- Decision (primary): Report each finding with the record and field behind it.
- Escalation (when severity is blocking): Name the demo participant before reporting a blocking finding.

## learn

- Learning (primary): Record what the review did not check.
`;

it('renders the fixture playbook as one claude skill with its four phase sections in cycle order', () => {
  const { db, within } = fixture(),
    files = generatePlaybookSkills(db, within, 'claude').files;
  // The adopted corpus's own playbook renders nothing.
  expect(files).toEqual([
    { path: '.claude/skills/note-review/SKILL.md', text: SKILL, identity: IDENTITY, word: 'playbook' },
  ]);
  expect(Object.isFrozen(files) && Object.isFrozen(files[0])).toBe(true);
  // Frontmatter first, describing the playbook by its meaning; the marker next, on its own line.
  const lines = files[0]!.text.split('\n');
  expect(lines.slice(0, 4)).toEqual([
    '---',
    'name: "note-review"',
    `description: ${JSON.stringify("Review one of the demo workspace's notes and report what the review finds.")}`,
    '---',
  ]);
  expect(lines.slice(4, 7)).toEqual(['', PACKET_MARKER, '']);
  expect(lines.filter((line) => line === PACKET_MARKER)).toHaveLength(1);
  expect(lines.filter((line) => line.startsWith('## '))).toEqual(['## orient', '## plan', '## act', '## learn']);
});

it('renders the same skill for codex under .agents/skills', () => {
  const { db, within } = fixture();
  expect(generatePlaybookSkills(db, within, 'codex')).toEqual({
    files: [{ path: '.agents/skills/note-review/SKILL.md', text: SKILL, identity: IDENTITY, word: 'playbook' }],
    unsupported: [],
  });
});

it('keeps each condition, lists a phase without a primary as authored, and leaves out a phase with no cell', () => {
  // An inline condition and a child when both read as their terms; a multi-paragraph cell is printed on one line.
  // Authored act before orient, with no plan or learn: the sections follow the cycle, and only phases with cells show.
  const playbook = [
    '#! ia 1.0',
    '',
    '@playbook triage',
    '  meaning',
    '    says """',
    '      Triage a note.',
    '',
    '      Escalate what blocks.',
    '    """',
    '    answers "How is a note triaged?"',
    '  cognition',
    '    act',
    '      Escalation means "Escalate a blocking note." when shape is governance and severity is blocking',
    '      Decision means "Decide the next step."',
    '        when phase is act',
    '    orient',
    '      primary Attention',
    '      Memory means """',
    '        Recall the note.',
    '',
    '        Say what it cites.',
    '      """',
    '      Attention means "Read the note."',
    '',
  ].join('\n');
  const { db, within } = fixture({ '.ia/src/triage.ia': playbook }),
    files = generatePlaybookSkills(db, within, 'claude').files;
  expect(files.map((file) => file.path)).toEqual([
    '.claude/skills/note-review/SKILL.md',
    '.claude/skills/triage/SKILL.md',
  ]);
  expect(files[1]!.text).toBe(`---
name: "triage"
description: "Triage a note. Escalate what blocks."
---

${PACKET_MARKER}

# triage

- playbook \`governance-system/definition/procedure/triage\`

## orient

- Attention (primary): Read the note.
- Memory: Recall the note. Say what it cites.

## act

- Escalation (when shape is governance and severity is blocking): Escalate a blocking note.
- Decision (when phase is act): Decide the next step.
`);
});

it('renders nothing for an adopted playbook', () => {
  const { db, within } = fixture({ '.ia/src/playbook.ia': null }, { '.ia/src/playbook.ia': PLAYBOOK });
  expect(db.get(IDENTITY, { within })?.band).toBe(90);
  for (const host of ['claude', 'codex'] as const)
    expect(generatePlaybookSkills(db, within, host), host).toEqual({ files: [], unsupported: [] });
});

it("reports an authored playbook named after the packet's ia-authoring skill, however it is spelled, for either host", () => {
  const { db, within } = fixture({
    '.ia/src/playbook.ia': PLAYBOOK.replace('@playbook note-review', '@playbook IA-Authoring'),
  });
  for (const host of ['claude', 'codex'] as const)
    expect(generatePlaybookSkills(db, within, host), host).toEqual({
      files: [],
      unsupported: [
        {
          identity: 'governance-system/definition/procedure/ia-authoring',
          word: 'playbook',
          reason:
            "Playbook governance-system/definition/procedure/ia-authoring would render over the packet's ia-authoring skill; rename the playbook",
        },
      ],
    });
});

it("renders a public system's authored example playbook only in the explicit example workspace", () => {
  // The authored example remains at band 100; the live repository and a consumer's adopted base do not author it.
  const live = open(repository, { cache: false });
  handles.push(live);
  expect(live.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  for (const host of ['claude', 'codex'] as const)
    expect(generatePlaybookSkills(live, live.resolveScope().token, host).files).toEqual([]);
  const root = mkdtempSync(join(temporary, 'public-'));
  copyPublicLanguageFixture(repository, root);
  const db = open(root, { cache: false });
  handles.push(db);
  expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  const within = db.resolveScope().token;
  for (const [host, root] of [
    ['claude', '.claude/skills'],
    ['codex', '.agents/skills'],
  ] as const)
    expect(generatePlaybookSkills(db, within, host).files.map((file) => [file.path, file.identity])).toEqual([
      [`${root}/example-method/SKILL.md`, 'governance-system/definition/procedure/example-method'],
    ]);
});

it('refuses an unknown host, and a forged or stale token for either host', () => {
  const { root, db, within } = fixture();
  expect(() => generatePlaybookSkills(db, within, 'cursor' as 'claude')).toThrow(
    expect.objectContaining({ diagnostic: { code: 'IA-PROJECTION-INPUT-INVALID', message: 'Unknown host: cursor' } }),
  );
  for (const host of ['claude', 'codex'] as const)
    expect(() => generatePlaybookSkills(db, 'forged', host), host).toThrow('IA-DB-SCOPE-UNAVAILABLE');
  put(root, '.ia/src/new.ia', '#! ia 1.0\n');
  db.refresh();
  for (const host of ['claude', 'codex'] as const)
    expect(() => generatePlaybookSkills(db, within, host), host).toThrow('IA-DB-STALE');
});

it('writes the same bytes at two roots and names neither root nor scope token', () => {
  const one = fixture(),
    two = fixture();
  for (const host of ['claude', 'codex'] as const) {
    const first = generatePlaybookSkills(one.db, one.within, host).files;
    expect(generatePlaybookSkills(two.db, two.within, host).files).toEqual(first);
    expect(generatePlaybookSkills(one.db, one.db.resolveScope().token, host).files).toEqual(first);
    for (const { root, within } of [one, two])
      for (const file of first) {
        expect(file.text).not.toContain(root);
        expect(file.text).not.toContain(within);
      }
  }
});

/** The harness rows of `definitions`, typed as harness definitions. */
const harnesses = (definitions: readonly PacketDefinition[]) =>
  definitions.filter((row): row is Extract<PacketDefinition, { word: 'harness' }> => row.word === 'harness');
const HARNESS = 'agent-composition-system/definition/harness/note-workspace',
  PROFILE = 'agent-composition-system/binding/agent-profile/reviewer',
  HOOK = 'hook-authoring-system/binding/hook/note-edits';

it('renders operation and harness definitions without importing a handler or validator', () => {
  const { db, within } = fixture();
  const definitions = generateDefinitions(db, within, 'claude');
  expect(definitions).toEqual([
    {
      identity: 'authoring-system/binding/operation/read-note',
      word: 'operation',
      definition: {
        name: 'read-note',
        description: 'Read one captured note.',
        handler: 'read-note-v1',
        input: 'read-note-input-v1',
        output: 'read-note-output-v1',
        effects: ['read-only'],
      },
    },
    {
      identity: HARNESS,
      word: 'harness',
      definition: {
        name: 'note-workspace',
        description: 'The documentation review registrations.',
        workspace: 'workspace-system/definition/workspace/demo',
        hostProfile: 'claude-prose',
        profiles: [PROFILE],
        bindings: ['agent-composition-system/binding/execution-binding/notes-hook'],
        registrations: {
          agents: [{ identity: PROFILE, path: '.claude/agents/reviewer.md' }],
          skills: [{ identity: IDENTITY, path: '.claude/skills/note-review/SKILL.md' }],
          hooks: [
            {
              identity: HOOK,
              event: 'PreToolUse',
              tools: ['Write', 'Edit', 'MultiEdit'],
              paths: ['docs/**', 'restricted/**'],
              message: "Use the participant's documentation mandate.",
            },
          ],
        },
      },
    },
  ]);
  // Codex registers no agent or hook, so its harness selects only the skill.
  expect(harnesses(generateDefinitions(db, within, 'codex')).map((row) => row.definition.registrations)).toEqual([
    { agents: [], skills: [{ identity: IDENTITY, path: '.agents/skills/note-review/SKILL.md' }], hooks: [] },
  ]);
});

it("renders this repository's read-captured-source operation as a definition row with its handler and I/O ids (R3 exit)", () => {
  // The milestone's exit row: the handler and validators are catalog keys, copied as authored and never imported.
  const db = open(repository, { cache: false });
  handles.push(db);
  const within = db.resolveScope().token;
  expect(
    generateDefinitions(db, within, 'claude').filter(
      (row) => row.identity === 'authoring-system/binding/operation/read-captured-source',
    ),
  ).toEqual([
    {
      identity: 'authoring-system/binding/operation/read-captured-source',
      word: 'operation',
      definition: {
        name: 'read-captured-source',
        description: 'Read one exact captured native source through the first-party adapter.',
        handler: 'captured-source-read-v1',
        input: 'captured-source-read-input-v1',
        output: 'captured-source-read-output-v1',
        effects: ['read-only'],
      },
    },
  ]);
});

it('selects the skills of included capabilities, and only what its own profiles and bindings name (A-R9)', () => {
  const extra = [
    '#! ia 1.0',
    '',
    '@playbook other-review',
    '  meaning',
    '    says "Unrelated playbook."',
    '    answers "Which playbook is unrelated?"',
    '  cognition',
    '    orient',
    '      primary Memory',
    '      Memory means "Recall."',
    '',
    '@playbook included-review',
    '  meaning',
    '    says "Included playbook."',
    '    answers "Which playbook is included?"',
    '  cognition',
    '    orient',
    '      primary Memory',
    '      Memory means "Recall."',
    '',
    '@capability inner',
    '  meaning',
    '    says "Inner."',
    '    answers "Which inner?"',
    '  composition',
    '    playbooks [@playbook included-review]',
    '  execution',
    '    effects [read]',
    '',
    '@capability outer',
    '  meaning',
    '    says "Outer."',
    '    answers "Which outer?"',
    '  composition',
    '    includes [@capability inner]',
    '  execution',
    '    effects [read]',
    '',
    '@agent-profile scribe',
    '  meaning',
    '    says "Scribe."',
    '    answers "Which scribe?"',
    '  composition',
    '    agent @agent reviewer',
    '    capabilities [@capability outer]',
    '  execution',
    '    role scribe',
    '    outcomes scribe-v1',
    '    mandate-contract review-v1',
    '',
    '@harness scribe-only',
    '  meaning',
    '    says "Only the scribe."',
    '    answers "Which harness holds only the scribe?"',
    '  composition',
    '    workspace @workspace demo',
    '    profiles [@agent-profile scribe]',
    '    bindings []',
    '  execution',
    '    host-profile claude-prose',
    '',
  ].join('\n');
  const { db, within } = fixture({ '.ia/src/extra.ia': extra });
  const scribe = 'agent-composition-system/binding/agent-profile/scribe';
  // outer includes inner: the scribe selects inner's playbook through outer, and neither the
  // fixture's reviewer, its playbook and hook, nor the unrelated playbook.
  expect(
    harnesses(generateDefinitions(db, within, 'claude')).find((row) => row.definition.name === 'scribe-only')!
      .definition,
  ).toEqual({
    name: 'scribe-only',
    description: 'Only the scribe.',
    workspace: 'workspace-system/definition/workspace/demo',
    hostProfile: 'claude-prose',
    profiles: [scribe],
    bindings: [],
    registrations: {
      agents: [{ identity: scribe, path: '.claude/agents/scribe.md' }],
      skills: [
        {
          identity: 'governance-system/definition/procedure/included-review',
          path: '.claude/skills/included-review/SKILL.md',
        },
      ],
      hooks: [],
    },
  });
  // With inner including outer, a cycle the composition compiler refuses, the scribe renders no agent and selects no
  // skill (A-RC5).
  const cycle = fixture({
    '.ia/src/extra.ia': extra.replace(
      '    playbooks [@playbook included-review]\n',
      '    playbooks [@playbook included-review]\n    includes [@capability outer]\n',
    ),
  });
  expect(
    harnesses(generateDefinitions(cycle.db, cycle.within, 'claude')).find(
      (row) => row.definition.name === 'scribe-only',
    )!.definition.registrations,
  ).toEqual({ agents: [], skills: [], hooks: [] });
  // The fixture's own harness selects as before.
  expect(
    harnesses(generateDefinitions(db, within, 'claude')).find((row) => row.identity === HARNESS)!.definition
      .registrations,
  ).toEqual({
    agents: [{ identity: PROFILE, path: '.claude/agents/reviewer.md' }],
    skills: [{ identity: IDENTITY, path: '.claude/skills/note-review/SKILL.md' }],
    hooks: [
      {
        identity: HOOK,
        event: 'PreToolUse',
        tools: ['Write', 'Edit', 'MultiEdit'],
        paths: ['docs/**', 'restricted/**'],
        message: "Use the participant's documentation mandate.",
      },
    ],
  });
});

it('computes the host set once, so what it applies is exactly what its harness definitions register', () => {
  const { db, within } = fixture({
    '.ia/src/extra-hooks.ia':
      '#! ia 1.0\n\n@hook session-start\n  meaning\n    says "Runs at session start."\n    answers "What runs at session start?"\n  hook\n    event Stop\n    tools [Write]\n    paths ["docs/**"]\n    message "Not an edit guard."\n',
  });
  for (const host of ['claude', 'codex'] as const) {
    const set = generateHostSet(db, within, host),
      agents = generateAgentProfiles(db, within, host),
      skills = generatePlaybookSkills(db, within, host),
      hooks = generateHookSet(db, within, host);
    expect(set.files, host).toEqual([...agents.files, ...skills.files]);
    expect(set.hooks, host).toEqual(hooks.hooks);
    expect(set.unsupported, host).toEqual([...agents.unsupported, ...skills.unsupported, ...hooks.unsupported]);
    expect(set.definitions, host).toEqual(generateDefinitions(db, within, host));
    expect(Object.isFrozen(set) && Object.isFrozen(set.files), host).toBe(true);
    for (const row of harnesses(set.definitions)) {
      const { agents: agentRows, skills: skillRows, hooks: hookRows } = row.definition.registrations;
      for (const registered of [...agentRows, ...skillRows])
        expect(
          set.files.some((file) => file.identity === registered.identity && file.path === registered.path),
          host,
        ).toBe(true);
      for (const registered of hookRows) expect(set.hooks, host).toContainEqual(registered);
    }
  }
  expect(generateHostSet(db, within, 'claude').unsupported.map((row) => row.identity)).toEqual([
    'hook-authoring-system/binding/hook/session-start',
  ]);
  expect(generateHostSet(db, within, 'codex').unsupported.map((row) => [row.word, row.identity])).toEqual([
    ['agent-profile', PROFILE],
    ['hook', HOOK],
    ['hook', 'hook-authoring-system/binding/hook/session-start'],
  ]);
});

it('generates authored hooks only and reports tools and selections outside the edit guard contract', () => {
  const hooks = readFileSync(resolve(FIXTURE, 'hooks.ia'), 'utf8');
  const authored = fixture();
  expect(generateHooks(authored.db, authored.within, 'claude')).toHaveLength(1);
  expect(generateHooks(authored.db, authored.within, 'codex')).toEqual([]);
  // C12: Codex registers no hook and reports each authored one.
  expect(generateHookSet(authored.db, authored.within, 'codex')).toEqual({
    hooks: [],
    unsupported: [
      {
        identity: 'hook-authoring-system/binding/hook/note-edits',
        word: 'hook',
        reason: 'Codex hooks are unsupported',
      },
    ],
  });
  const adopted = fixture({ '.ia/src/hooks.ia': null }, { '.ia/src/hooks.ia': hooks });
  expect(generateHooks(adopted.db, adopted.within, 'claude')).toEqual([]);
  expect(generateHookSet(adopted.db, adopted.within, 'claude').unsupported).toEqual([]);
  for (const [text, why] of [
    [hooks.replace('[Write, Edit, MultiEdit]', '[Bash]'), 'hook.tools must name Write, Edit or MultiEdit'],
    [hooks.replace('"docs/**"', '"../docs/**"'), 'hook.paths must hold workspace-relative path selections'],
    // No C1 control or bidirectional control either (G-R7).
    [hooks.replace('"docs/**"', '"docs/\u0085x/**"'), 'hook.paths must hold workspace-relative path selections'],
    [hooks.replace('"docs/**"', '"docs/\u202ex/**"'), 'hook.paths must hold workspace-relative path selections'],
    // A backslash is no separator in the dialect: the selection must be written with /.
    [
      hooks.replace('"docs/**"', '"docs\\\\**"'),
      'hook.paths must hold workspace-relative path selections written with /',
    ],
    [hooks.replace('event PreToolUse', 'event Stop'), 'event Stop is not PreToolUse'],
    // A hook that selects no path could never deny: it is reported, never registered as a guard that guards nothing.
    [hooks.replace('["docs/**", "restricted/**"]', '[]'), 'hook.paths selects no path'],
    [
      hooks.replace(`message "Use the participant's documentation mandate."`, 'message " "'),
      'hook.message is required and not blank',
    ],
  ] as const) {
    const broken = fixture({ '.ia/src/hooks.ia': text });
    expect(generateHooks(broken.db, broken.within, 'claude')).toEqual([]);
    const { unsupported } = generateHookSet(broken.db, broken.within, 'claude');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatchObject({ identity: 'hook-authoring-system/binding/hook/note-edits', word: 'hook' });
    expect(unsupported[0]!.reason).toContain(why);
    // The guard reads the same declaration, so it refuses what registration reports.
    const node = broken.db.records({ within: broken.within }).find((record) => record.discriminator === 'hook')!;
    expect(() => hookDeclaration(node)).toThrow(why);
  }
  // One unsupported hook leaves every supported one registered, and the harness definitions still render.
  const mixed = fixture({
    '.ia/src/extra-hooks.ia':
      '#! ia 1.0\n\n@hook session-start\n  meaning\n    says "Runs at session start."\n    answers "What runs at session start?"\n  hook\n    event Stop\n    tools [Write]\n    paths ["docs/**"]\n    message "Not an edit guard."\n',
  });
  const set = generateHookSet(mixed.db, mixed.within, 'claude');
  expect(set.hooks.map((hook) => hook.identity)).toEqual(['hook-authoring-system/binding/hook/note-edits']);
  expect(set.unsupported.map((hook) => hook.identity)).toEqual(['hook-authoring-system/binding/hook/session-start']);
  expect(generateDefinitions(mixed.db, mixed.within, 'claude').map((row) => row.word)).toEqual([
    'operation',
    'harness',
  ]);
});

it('reports a hook beyond the bounds a registration holds, never refusing the others (H-N2)', () => {
  const selections = (count: number) => `[${Array.from({ length: count }, (_, at) => `"notes/n${at}/**"`).join(', ')}]`;
  const hook = (name: string, paths: string) =>
    `\n@hook ${name}\n  meaning\n    says "Hook ${name}."\n    answers "Which hook is ${name}?"\n  hook\n    event PreToolUse\n    tools [Write]\n    paths ${paths}\n    message "Use the ${name} mandate."\n`;
  // 65 selections and a 600-character selection are each an unsupported row; 64 selections of 512 register.
  const bounded = fixture({
    '.ia/src/extra-hooks.ia':
      '#! ia 1.0\n' +
      hook('many-paths', selections(65)) +
      hook('long-path', `["${'a'.repeat(600)}/**"]`) +
      hook('at-bounds', selections(63).replace(']', `, "${'b'.repeat(512 - 3)}/**"]`)),
  });
  const set = generateHookSet(bounded.db, bounded.within, 'claude');
  expect(set.hooks.map((row) => row.identity)).toEqual([
    'hook-authoring-system/binding/hook/at-bounds',
    'hook-authoring-system/binding/hook/note-edits',
  ]);
  expect(set.hooks[0]!.paths).toHaveLength(64);
  expect(set.unsupported).toEqual([
    {
      identity: 'hook-authoring-system/binding/hook/long-path',
      word: 'hook',
      reason: expect.stringContaining('a selection longer than the 512 characters a registration records'),
    },
    {
      identity: 'hook-authoring-system/binding/hook/many-paths',
      word: 'hook',
      reason: expect.stringContaining('hook.paths holds 65 selections, and a registration records at most 64'),
    },
  ]);
  // Past 64 accepted hooks, each further one is reported.
  const crowded = fixture({
    '.ia/src/extra-hooks.ia':
      '#! ia 1.0\n' +
      Array.from({ length: 64 }, (_, at) => hook(`h${String(at).padStart(2, '0')}`, '["docs/**"]')).join(''),
  });
  const full = generateHookSet(crowded.db, crowded.within, 'claude');
  expect(full.hooks).toHaveLength(64);
  expect(full.unsupported).toEqual([
    {
      identity: 'hook-authoring-system/binding/hook/note-edits',
      word: 'hook',
      reason: expect.stringContaining('a registration holds at most 64 hooks, and 64 come before it'),
    },
  ]);
});

it('reports a playbook whose name is no portable host name or whose text is not inert, and renders the others', () => {
  // Review findings N5 and A-R3: com0 and lpt0 as db's input paths refuse them, a trailing or doubled hyphen, and a cell
  // that runs a command or holds active HTML; the fixture's own playbook still renders.
  const extra = (name: string, text = 'Read the note.'): string =>
    `#! ia 1.0\n\n@playbook ${name}\n  meaning\n    says "Playbook ${name}."\n    answers "Which playbook is ${name}?"\n  cognition\n    orient\n      primary Attention\n      Attention means "${text}"\n`;
  for (const [name, text, reason] of [
    ['con', undefined, 'Unsafe generated host name: con'],
    ['com0', undefined, 'Unsafe generated host name: com0'],
    ['lpt0', undefined, 'Unsafe generated host name: lpt0'],
    ['triage-', undefined, 'Unsafe generated host name: triage-'],
    ['tri--age', undefined, 'Unsafe generated host name: tri--age'],
    ['runner', 'Run !`rm -rf ~` first.', 'Executable dynamic context is unsupported in inert prose'],
    ['styled', 'Read <b>this</b>.', 'Active HTML is unsupported in inert prose'],
  ] as const) {
    const { db, within } = fixture({ '.ia/src/extra.ia': extra(name, text) });
    for (const host of ['claude', 'codex'] as const)
      expect(generatePlaybookSkills(db, within, host), `${name} ${host}`).toMatchObject({
        files: [{ identity: IDENTITY }],
        unsupported: [{ identity: `governance-system/definition/procedure/${name}`, word: 'playbook', reason }],
      });
  }
});

it('writes cell text as the packet writes free text, each IA word a code span and a comment opener escaped', () => {
  const { db, within } = fixture({
      '.ia/src/playbook.ia': PLAYBOOK.replace(
        'Learning means "Record what the review did not check."',
        'Learning means "Record each @task the review did not check, not a@b.c. <!-- hidden"',
      ),
    }),
    [file] = generatePlaybookSkills(db, within, 'claude').files;
  expect(
    file!.text.endsWith(
      '- Learning (primary): Record each `@task` the review did not check, not a@b.c. &lt;!-- hidden\n',
    ),
  ).toBe(true);
});
