import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { stableSerialize } from '@inventarch/graph';
import { readInputs } from '@inventarch/db';
import type { Location } from '@inventarch/language';
import { Door, READ_CODES, RUNTIME_CODES, SOURCE_LOCATORS, parseLocator, readBody } from '../src/index.js';
import type { ReadBodyOptions, ReadResult } from '../src/index.js';
import { headingAnchor, markdownSection } from '../src/locator.js';
import { database, methodId, playbook, put, workspace } from './workspace.js';

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const RECORDS = '.ia/src/systems/work-system/records/located.ia';
const AGENT = 'agent-system/binding/agent/agent-steward';
const CONTRACT = 'compliance-system/contract/signature/foundation-authoring-contract';
const DOCUMENT = [
  '# Spec',
  '',
  'Intro line.',
  '',
  '## Reading a body',
  '',
  'The body behind a locator.',
  '',
  '### Detail',
  '',
  'Nested under reading.',
  '',
  '```md',
  '## Not a heading',
  '```',
  '',
  '## Reading a body',
  '',
  'The second section with the same heading.',
  '',
  '## `ia read` and [links](https://example.com)!',
  '',
  'Last section.',
  '',
].join('\n');
const record = (word: string, name: string, work: string): string =>
  `\n@${word} ${name}\n  meaning\n    says "The ${name} body."\n    answers "What does ${name} say?"\n  work\n${work}`;
/** Work records with and without a source locator, beside the conformance corpus. */
const RECORD_TEXT = [
  '#! ia 1.0',
  record('spec', 'whole-spec', '    title "Whole"\n    status draft\n    source "docs/spec.md"\n'),
  record('spec', 'section-spec', '    title "Section"\n    status draft\n    source "docs/spec.md#reading-a-body"\n'),
  record(
    'spec',
    'repeated-spec',
    '    title "Repeated"\n    status draft\n    source "./docs/spec.md#reading-a-body-1"\n',
  ),
  record(
    'spec',
    'missing-anchor-spec',
    '    title "Missing"\n    status draft\n    source "docs/spec.md#not-a-heading"\n',
  ),
  record('spec', 'json-anchor-spec', '    title "Json"\n    status draft\n    source "docs/data.json#top"\n'),
  record('spec', 'absent-spec', '    title "Absent"\n    status draft\n    source "docs/absent.md"\n'),
  record('spec', 'escaping-spec', '    title "Escaping"\n    status draft\n    source "../outside.md"\n'),
  record('spec', 'absolute-spec', '    title "Absolute"\n    status draft\n    source "/etc/hosts"\n'),
  record('spec', 'url-spec', '    title "Remote"\n    status draft\n    source "https://example.com/spec.md"\n'),
  record('spec', 'binary-spec', '    title "Binary"\n    status draft\n    source "docs/binary.md"\n'),
  record('spec', 'fileless-spec', '    title "Fileless"\n    status draft\n    source "#spec"\n'),
  record('spec', 'upper-spec', '    title "Upper"\n    status draft\n    source "docs/UPPER.MD#upper"\n'),
  record('spec', 'bom-spec', '    title "Bom"\n    status draft\n    source "docs/bom.md#title"\n'),
  record('spec', 'unlocated-spec', '    title "Unlocated"\n    status draft\n'),
  record('plan', 'located-plan', '    title "Plan"\n    status open\n    source "docs/spec.md#spec"\n'),
  record(
    'milestone',
    'located-milestone',
    '    title "Milestone"\n    status open\n    plan @plan located-plan\n    exit "Done."\n    source "docs/spec.md#reading-a-body"\n',
  ),
  record(
    'decision',
    'located-decision',
    '    title "Decision"\n    status made\n    source "docs/data.json"\n  decision\n    question "Which?"\n    choice "This."\n',
  ),
  record('task', 'unlocated-task', '    title "Task"\n    status open\n    milestone @milestone located-milestone\n'),
  record(
    'task',
    'located-task',
    '    title "Task"\n    status open\n    milestone @milestone located-milestone\n    source "docs/data.json"\n',
  ),
].join('');

/** The conformance corpus, the work records above and the files their locators name. */
function located(): { readonly root: string; readonly options: ReadBodyOptions; readonly asked: string[] } {
  const root = workspace();
  put(root, RECORDS, RECORD_TEXT);
  put(root, 'docs/spec.md', DOCUMENT);
  put(root, 'docs/data.json', '{"top": 1}\n');
  put(root, 'docs/UPPER.MD', '# Upper\n\nShouted.\n');
  // A file saved with a byte order mark, as Windows editors often save one.
  put(root, 'docs/bom.md', '\uFEFF# Title\n\nBody.\n\n# Next\n');
  // Bytes that are not UTF-8.
  writeFileSync(resolve(root, 'docs/binary.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  const asked: string[] = [];
  return {
    root,
    asked,
    options: {
      read: (path) => {
        asked.push(path);
        return readFileSync(resolve(root, path));
      },
    },
  };
}
const body = (result: ReadResult) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.body;
};

it('parses the four locator forms and nothing else', () => {
  expect(parseLocator(AGENT)).toEqual({ form: 'identity', identity: AGENT });
  expect(parseLocator(`${methodId}#act/Decision`)).toEqual({
    form: 'cell',
    identity: methodId,
    fragment: 'act/Decision',
  });
  expect(parseLocator(`${CONTRACT}#REQ-FOUNDATION-INPUT`)).toEqual({
    form: 'requirement',
    identity: CONTRACT,
    fragment: 'REQ-FOUNDATION-INPUT',
  });
  expect(parseLocator('.ia/src/systems/agent-system/steward.ia:5')).toEqual({
    form: 'line',
    path: '.ia/src/systems/agent-system/steward.ia',
    line: 5,
  });
  // The last colon splits a path from its line, so a drive letter stays in the path.
  expect(parseLocator('C:/w/a.ia:12')).toEqual({ form: 'line', path: 'C:/w/a.ia', line: 12 });
  for (const malformed of [
    '',
    'agent-steward',
    'agent-system/binding/agent',
    'Agent-System/binding/agent/agent-steward',
    `${AGENT}#`,
    `${AGENT}#act`,
    `${AGENT}#act/decision`,
    `${AGENT}#invented/Decision`,
    `${AGENT}#act/Decision/again`,
    `${AGENT}#req-lower`,
    `${AGENT}#REQ-`,
    'a.ia:0',
    'a.ia:01',
    `a.ia:${'9'.repeat(20)}`,
  ])
    expect(parseLocator(malformed), malformed).toBeUndefined();
  expect(Object.isFrozen(parseLocator(AGENT))).toBe(true);
});

it('registers each read refusal in RUNTIME_CODES and names the locator field each locating schema declares', () => {
  expect(READ_CODES).toEqual([
    'IA-RUNTIME-READ-UNADMITTED',
    'IA-RUNTIME-READ-FRAGMENT',
    'IA-RUNTIME-READ-UNREACHABLE',
    'IA-RUNTIME-READ-PLACEMENT',
  ]);
  for (const code of READ_CODES) expect(RUNTIME_CODES).toContain(code);
  // Each field is the one the word's schema declares as text.
  const schemas = resolve(import.meta.dirname, '../../../.ia/src/systems');
  const declared: Readonly<Record<string, string>> = {
    'authoring-guide': 'authoring-system/schemas/authoring-guide.schema.ia',
    decision: 'work-system/schemas/decision.schema.ia',
    milestone: 'work-system/schemas/milestone.schema.ia',
    plan: 'work-system/schemas/plan.schema.ia',
    spec: 'work-system/schemas/spec.schema.ia',
    task: 'work-system/schemas/task.schema.ia',
    template: 'template-system/schemas/template.schema.ia',
  };
  expect(Object.keys(SOURCE_LOCATORS).sort()).toEqual(Object.keys(declared).sort());
  for (const [word, field] of Object.entries(SOURCE_LOCATORS))
    expect(readFileSync(resolve(schemas, declared[word]!), 'utf8'), word).toMatch(
      new RegExp(`have ${field.replace('.', '\\.')} as text`),
    );
  // Decision work-source-locator: every work word whose schema declares `work.source` reads it as its locator.
  for (const word of ['decision', 'milestone', 'plan', 'spec', 'task'])
    expect(SOURCE_LOCATORS, word).toHaveProperty(word, 'work.source');
});

it('slugs plain-text headings as GitHub does and bounds a section by the next heading of its level or higher', () => {
  expect(headingAnchor('Reading a body')).toBe('reading-a-body');
  expect(headingAnchor('`ia read` and [links](https://example.com)!')).toBe('ia-read-and-links');
  expect(headingAnchor('Décisions — made, 2026')).toBe('décisions--made-2026');
  expect(headingAnchor('snake_case and kebab-case')).toBe('snake_case-and-kebab-case');
  expect(headingAnchor('*Starred* and **strong**')).toBe('starred-and-strong');
  // GitHub's slugger keeps decimal and letter numbers only, so a superscript or a vulgar fraction is dropped.
  expect(headingAnchor('x² and ½ Ⅻ')).toBe('x-and--ⅻ');
  // Stated limits: the heading is not rendered first, so underscore emphasis and entities keep their markup.
  expect(headingAnchor('_Emphasis_ heading')).toBe('_emphasis_-heading');
  expect(headingAnchor('A &amp; B')).toBe('a-amp-b');
  const first = markdownSection(DOCUMENT, 'reading-a-body')!;
  // The deeper heading and the fenced line stay inside; the repeated heading at the same level ends it.
  expect(first).toBe(
    '## Reading a body\n\nThe body behind a locator.\n\n### Detail\n\nNested under reading.\n\n```md\n## Not a heading\n```\n\n',
  );
  expect(markdownSection(DOCUMENT, 'reading-a-body-1')).toBe(
    '## Reading a body\n\nThe second section with the same heading.\n\n',
  );
  expect(markdownSection(DOCUMENT, 'detail')).toBe(
    '### Detail\n\nNested under reading.\n\n```md\n## Not a heading\n```\n\n',
  );
  // The last section runs to the end of the file, and the top heading holds the whole document.
  expect(markdownSection(DOCUMENT, 'ia-read-and-links')).toBe(
    '## `ia read` and [links](https://example.com)!\n\nLast section.\n',
  );
  expect(markdownSection(DOCUMENT, 'spec')).toBe(DOCUMENT);
  // A heading inside fenced code is not one, and neither is a `#` without a space.
  expect(markdownSection(DOCUMENT, 'not-a-heading')).toBeUndefined();
  expect(markdownSection('#tag\n', 'tag')).toBeUndefined();
  // Closing hashes are not part of the heading, and line endings are kept as written.
  expect(markdownSection('## Title ##\r\nText\r\n## Next\r\n', 'title')).toBe('## Title ##\r\nText\r\n');
  // A heading that already reads as a suffixed anchor takes the next suffix, as GitHub's slugger numbers them.
  expect(markdownSection('# A\n# A\n# A 1\nlast\n', 'a-1-1')).toBe('# A 1\nlast\n');
  // A leading byte order mark is not part of the first heading, which keeps its anchor and its place in the numbering,
  // and the section keeps the mark as read.
  expect(markdownSection('\uFEFF# Title\n\nBody.\n## Next\n', 'title')).toBe('\uFEFF# Title\n\nBody.\n## Next\n');
  expect(markdownSection('\uFEFF# Notes\n\nTop.\n\n## Notes\n\nInner.\n', 'notes')).toBe(
    '\uFEFF# Notes\n\nTop.\n\n## Notes\n\nInner.\n',
  );
  expect(markdownSection('\uFEFF# Notes\n\nTop.\n\n## Notes\n\nInner.\n', 'notes-1')).toBe('## Notes\n\nInner.\n');
  // Only the first line can carry the mark.
  expect(markdownSection('Intro.\n\uFEFF# Title\n', 'title')).toBeUndefined();
  // Headings in a list item or a block quote, and setext headings, are not read.
  expect(markdownSection('- # Listed\n> # Quoted\nSetext\n======\n', 'listed')).toBeUndefined();
  expect(markdownSection('- # Listed\n> # Quoted\nSetext\n======\n', 'quoted')).toBeUndefined();
  expect(markdownSection('- # Listed\n> # Quoted\nSetext\n======\n', 'setext')).toBeUndefined();
});

// Every heading before the anchor is slugged, so a heading's links are read in time linear in it: the work grows as
// the input does, never as its square, which the link regular expression this reader replaced did on a run of unclosed
// brackets or destinations (CodeQL js/polynomial-redos). The sizes are small enough that a quadratic reader finishes in
// seconds, so a regression fails its growth ratio instead of stalling the suite.
/** The fastest of `runs` reads of the `target` section of `text`, in milliseconds; the section is always `# target`. */
function fastest(text: string, runs: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    expect(markdownSection(text, 'target')).toBe('# target\n');
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
it('reads the links of a heading in time linear in its length, however many brackets stay unclosed', () => {
  const inputs: Readonly<Record<string, (size: number) => string>> = {
    brackets: (size) => `# ${'[a'.repeat(size / 2)}\n# target\n`,
    destinations: (size) => `# ${'[](('.repeat(size / 4)}\n# target\n`,
  };
  for (const [name, input] of Object.entries(inputs)) {
    const small = fastest(input(1 << 12), 5),
      large = fastest(input(1 << 15), 5);
    // Eight times the input is about eight times the work when it is linear, sixty-four times when it is quadratic; a
    // read under a millisecond counts as one, so a linear reader's ratio stays near one at these sizes.
    expect(large / Math.max(small, 1), name).toBeLessThan(32);
  }
  // A link keeps its text, an image its alt text, and an unclosed bracket is text.
  expect(headingAnchor(`${'[a'.repeat(3)}[x](y) and ![alt](src)`)).toBe('aaax-and-alt');
});

it.each([
  '- Item\n\n  ## Overview\n\n  Nested body.\n',
  '1. Item\n\n   ## Overview\n\n   Nested body.\n',
  '- Item\nlazy continuation\n\n  ## Overview\n\n  Nested body.\n',
  '- Item\n  - Child\n\n  ## Overview\n\n  Nested body.\n',
  '-\n  ## Overview\n\n  Nested body.\n',
])('excludes list continuation headings from anchors and duplicate numbering: %j', (listed) => {
  const first = '## Overview\n\nFirst top-level body.\n\n',
    second = '## Overview\n\nSecond top-level body.\n',
    document = `${listed}\n${first}${second}`;
  expect(markdownSection(listed, 'overview')).toBeUndefined();
  expect(markdownSection(document, 'overview')).toBe(first);
  expect(markdownSection(document, 'overview-1')).toBe(second);
  expect(markdownSection(document, 'overview-2')).toBeUndefined();
});

it('keeps same-level and higher-level list headings inside their enclosing top-level section byte for byte', () => {
  const section = '\uFEFF## Main\r\n\r\n- Item\r\n\r\n  ## Same\r\n\r\n  # Higher\r\n\r\nOutside prose.\r\n\r\n',
    next = '  ## Next\r\nLast body.';
  expect(markdownSection(section + next, 'main')).toBe(section);
  expect(markdownSection(section + next, 'next')).toBe(next);
  expect(markdownSection(section + next, 'same')).toBeUndefined();
  expect(markdownSection(section + next, 'higher')).toBeUndefined();
});

it.each([
  '-\n\n',
  '- Item\n\nOutside paragraph.\n\n',
  '-   Item\n\n',
  '-\tItem\n\n',
  'Paragraph.\n2. Item\n\n',
  'Paragraph.\n-\n\n',
  '***\n\n',
  '* * *\n\n',
  '- Item\n---\n\n',
  '- Item\n> Quote outside the list.\n\n',
])('recognizes top-level indented headings after an ended or non-list block: %j', (before) => {
  const section = '   # Target\n\nBody.\n';
  expect(markdownSection(before + section, 'target')).toBe(section);
});

it.each(['```inline code```', '```lang`info', '   ````lang`info', '```lang\\`info'])(
  'does not treat a backtick in fence info as a fence opener: %j',
  (inline) => {
    const section = `# Main\n\n${inline}\n\n`,
      next = '# Next\n\nOther body.\n';
    expect(markdownSection(section + next, 'main')).toBe(section);
    expect(markdownSection(section + next, 'next')).toBe(next);
  },
);

it('keeps valid fences scoped to their list or quote and ignores marker-looking fenced contents', () => {
  const document = [
    '- ```md',
    '  # Listed code',
    '  ```',
    '',
    '  # Listed heading',
    '',
    '# Main',
    '',
    '~~~lang`info',
    '- An apparent list inside code',
    '# Fenced heading',
    '~~~',
    '',
    '> ```',
    '> # Quoted code',
    '# Next',
    '',
    '- Item',
    '  ```',
    '  # Unterminated listed code',
    '# Last',
    'Body.',
    '',
  ].join('\n');
  expect(markdownSection(document, 'main')).toBe(
    document.slice(document.indexOf('# Main'), document.indexOf('# Next')),
  );
  expect(markdownSection(document, 'next')).toBe(
    document.slice(document.indexOf('# Next'), document.indexOf('# Last')),
  );
  expect(markdownSection(document, 'last')).toBe('# Last\nBody.\n');
  for (const anchor of ['listed-code', 'listed-heading', 'fenced-heading', 'quoted-code', 'unterminated-listed-code'])
    expect(markdownSection(document, anchor), anchor).toBeUndefined();
});

it.each([0, 1, 2, 3])('preserves supported top-level ATX indentation of %i spaces', (indent) => {
  const section = `${' '.repeat(indent)}# Title\nBody.\n`;
  expect(markdownSection(section + '# Next\n', 'title')).toBe(section);
});

it('starts a new list after an unmatched container instead of lazily continuing its paragraph', () => {
  const section = '  # Target\nBody.\n';
  for (const before of ['- Item\n2. Item\n', '- > Item\n2. Item\n', '> Item\n2. Item\n'])
    expect(markdownSection(before + section, 'target'), before).toBe(section);
  const fenced = '# Main\n\n+ Item\n10) Item\n   ```\n# Stop\n';
  expect(markdownSection(fenced, 'main')).toBe(fenced);
  expect(markdownSection(fenced, 'stop')).toBeUndefined();
});

it('reads a record without a source locator as its meaning.says, and the plan exit evidence identity says only that', () => {
  const root = workspace(),
    db = database(root);
  const read = () => {
    throw new Error('A record body reads no file');
  };
  const steward = body(readBody(db, AGENT, { read }));
  expect(steward).toEqual({
    locator: AGENT,
    identity: AGENT,
    kind: 'record',
    digest: sha256('Identifies the owner of agent-system contracts in this example.'),
    body: 'Identifies the owner of agent-system contracts in this example.',
    certified: false,
  });
  expect(Object.isFrozen(steward)).toBe(true);
  // A @system states its head `describes`; a @schema states neither, so its body is empty.
  expect(body(readBody(db, 'floor/definition/system/agent-system', { read })).body).toBe(
    'Public agent-system vocabulary contracts',
  );
  const schema = body(readBody(db, 'floor/contract/head/agent', { read }));
  expect(schema).toMatchObject({ kind: 'record', body: '', digest: sha256('') });
  // A cell and a requirement read their own text.
  expect(body(readBody(db, `${methodId}#act/Decision`, { read })).body).toBe('Sample fixture statement 18.');
  expect(body(readBody(db, `${CONTRACT}#REQ-FOUNDATION-REFUSE`, { read }))).toMatchObject({
    kind: 'record',
    body: 'Missing required fields or foreign vocabulary receives a named refusal and is not reported as conforming.',
  });
});

it('reads an admitted custom word named constructor without treating inherited properties as source locators', () => {
  const root = workspace(),
    systemPath = '.ia/src/systems/agent-system/system.ia',
    schemaPath = '.ia/src/systems/agent-system/schemas/agent.schema.ia',
    stewardPath = '.ia/src/systems/agent-system/steward.ia',
    identity = 'agent-system/binding/agent/custom-reader',
    text = 'The custom word reads its own body.';
  put(
    root,
    systemPath,
    readFileSync(resolve(root, systemPath), 'utf8').replace(
      '  edges\n',
      '    constructor lowers to binding\n      category capability\n      facets [agent]\n      schema @schema constructor\n  edges\n',
    ),
  );
  put(
    root,
    '.ia/src/systems/agent-system/schemas/constructor.schema.ia',
    readFileSync(resolve(root, schemaPath), 'utf8').replace('@schema agent', '@schema constructor'),
  );
  put(
    root,
    stewardPath,
    readFileSync(resolve(root, stewardPath), 'utf8').replace(
      'applies [agent, mandate]',
      'applies [agent, mandate, constructor]',
    ),
  );
  put(
    root,
    '.ia/src/systems/agent-system/records/custom-reader.ia',
    `#! ia 1.0\n@constructor custom-reader\n  meaning\n    says "${text}"\n    answers "What is read?"\n  governance\n    applies []\n`,
  );
  const db = database(root);
  expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  expect(db.get(identity)?.discriminator).toBe('constructor');
  const gate = new Door(root, { cache: false });
  try {
    expect(gate.request({ operation: 'read', params: { locator: identity } })).toMatchObject({
      ok: true,
      result: { identity, kind: 'record', body: text, digest: sha256(text), certified: false },
    });
  } finally {
    gate.close();
  }
  expect(
    body(
      readBody(db, identity, {
        read: () => {
          throw new Error('No document should be read');
        },
      }),
    ),
  ).toMatchObject({
    kind: 'record',
    body: text,
    digest: sha256(text),
  });
});

it('reads the record whose source span holds a line, the innermost one, and refuses a line no record spans', () => {
  const root = workspace(),
    path = '.ia/src/systems/agent-system/system.ia',
    nested = '.ia/src/systems/agent-system/records/nested.ia';
  put(
    root,
    nested,
    '#! ia 1.0\n@agent outer-agent\n  meaning\n    says "Outer."\n    answers "Outer?"\n  governance\n    applies []\n    @agent inner-agent\n      meaning\n        says "Inner."\n        answers "Inner?"\n      governance\n        applies []\n',
  );
  const db = database(root);
  const options: ReadBodyOptions = { read: () => new Uint8Array() };
  // Both records span line 10; the one nested inside the other answers it.
  expect(db.get('agent-system/binding/agent/inner-agent')?.parent).toBe('agent-system/binding/agent/outer-agent');
  expect(body(readBody(db, `${nested}:10`, options))).toMatchObject({
    identity: 'agent-system/binding/agent/inner-agent',
    body: 'Inner.',
  });
  expect(body(readBody(db, `${nested}:4`, options)).body).toBe('Outer.');
  const steward = db.get('agent-system/binding/agent/agent-steward')!;
  const at = `${steward.source.path}:${steward.source.line + 2}`;
  expect(body(readBody(db, at, options))).toMatchObject({ locator: at, identity: AGENT, kind: 'record' });
  // A Windows separator and a leading `./` name the same source.
  expect(
    body(readBody(db, `./${steward.source.path.replaceAll('/', '\\')}:${steward.source.line}`, options)).identity,
  ).toBe(AGENT);
  const system = db.get('floor/definition/system/agent-system')!;
  expect(body(readBody(db, `${path}:${system.source.line}`, options)).identity).toBe(system.identity);
  // A line of an admitted source that no record spans says that the file's records span other lines.
  for (const line of [1, 9999])
    expect(readBody(db, `${steward.source.path}:${line}`, options)).toEqual({
      ok: false,
      code: 'IA-RUNTIME-READ-UNADMITTED',
      message: `No admitted record spans ${steward.source.path}:${line}; the admitted records of ${steward.source.path} span other lines`,
      path: steward.source.path,
      line,
      file: 'admitted',
    });
  // A file that holds no record of the workspace's sources says so, and a path outside the workspace, or one not
  // relative to its root, says that.
  for (const [locator, path, why] of [
    [
      '.ia/src/systems/agent-system/absent.ia:3',
      '.ia/src/systems/agent-system/absent.ia',
      "no record of this workspace's sources is in .ia/src/systems/agent-system/absent.ia",
    ],
    ['../outside.ia:3', '../outside.ia', '../outside.ia is not a path relative to the workspace root'],
    ['/abs/outside.ia:3', '/abs/outside.ia', '/abs/outside.ia is not a path relative to the workspace root'],
  ] as const)
    expect(readBody(db, locator, options), locator).toEqual({
      ok: false,
      code: 'IA-RUNTIME-READ-UNADMITTED',
      message: `No admitted record spans ${path}:3; ${why}`,
      path,
      line: 3,
    });
  // The workspace root itself, `.` or any spelling of it, is a directory: no source, so no record spans a line of it.
  for (const spelled of ['.', './', 'src/..'])
    expect(readBody(db, `${spelled}:3`, options), spelled).toEqual({
      ok: false,
      code: 'IA-RUNTIME-READ-UNADMITTED',
      message: `No admitted record spans ${spelled}:3; ${spelled} is the workspace root, a directory and no source`,
      path: '',
      line: 3,
    });
});

it('says that admission refused the records of a source whose line no admitted record spans', () => {
  const root = workspace(),
    refused = '.ia/src/systems/agent-system/records/foreign.ia';
  // A @playbook is the governance system's word, so the agent system's folder cannot author one.
  put(
    root,
    refused,
    playbook('foreign-procedure', '', '    act\n      primary Decision\n      Decision means "Foreign."\n'),
  );
  const db = database(root);
  expect(db.refused.map((r) => r.path)).toContain(refused);
  expect(readBody(db, `${refused}:3`, { read: () => new Uint8Array() })).toEqual({
    ok: false,
    code: 'IA-RUNTIME-READ-UNADMITTED',
    message: `No admitted record spans ${refused}:3; admission refused records of ${refused}`,
    path: refused,
    line: 3,
    file: 'refused',
  });
});

it('reads the document a source locator names: the whole file, or the section its anchor selects', () => {
  const { root, options, asked } = located(),
    db = database(root);
  const file = readFileSync(resolve(root, 'docs/spec.md'));
  const whole = body(readBody(db, 'work-system/contract/spec/whole-spec', options));
  expect(whole).toEqual({
    locator: 'work-system/contract/spec/whole-spec',
    identity: 'work-system/contract/spec/whole-spec',
    kind: 'document',
    path: 'docs/spec.md',
    digest: sha256(file),
    body: DOCUMENT,
    certified: false,
  });
  const section = body(readBody(db, 'work-system/contract/spec/section-spec', options));
  expect(section.body).toBe(markdownSection(DOCUMENT, 'reading-a-body'));
  expect(section.digest).toBe(sha256(section.body));
  expect(body(readBody(db, 'work-system/contract/spec/repeated-spec', options)).body).toBe(
    markdownSection(DOCUMENT, 'reading-a-body-1'),
  );
  expect(body(readBody(db, 'work-system/definition/plan/located-plan', options)).body).toBe(DOCUMENT);
  // `work.source` where present: a task with one reads its document, one without reads its own body, as does a spec.
  expect(body(readBody(db, 'work-system/definition/task/located-task', options))).toMatchObject({
    kind: 'document',
    path: 'docs/data.json',
    body: '{"top": 1}\n',
  });
  for (const identity of ['work-system/definition/task/unlocated-task', 'work-system/contract/spec/unlocated-spec'])
    expect(body(readBody(db, identity, options)), identity).toMatchObject({
      kind: 'record',
      body: `The ${identity.split('/').at(-1)!} body.`,
    });
  // A @milestone's and a @decision's `work.source` is a locator too (decision work-source-locator), and an anchor
  // narrows it to the section, not the whole document.
  expect(markdownSection(DOCUMENT, 'reading-a-body')).not.toBe(DOCUMENT);
  expect(body(readBody(db, 'work-system/definition/milestone/located-milestone', options))).toMatchObject({
    kind: 'document',
    path: 'docs/spec.md',
    body: markdownSection(DOCUMENT, 'reading-a-body'),
  });
  expect(body(readBody(db, 'work-system/definition/decision/located-decision', options))).toMatchObject({
    kind: 'document',
    path: 'docs/data.json',
    body: '{"top": 1}\n',
  });
  // The markdown extension is matched in any case, and a byte order mark leaves the first heading its anchor.
  expect(body(readBody(db, 'work-system/contract/spec/upper-spec', options))).toMatchObject({
    path: 'docs/UPPER.MD',
    body: '# Upper\n\nShouted.\n',
  });
  expect(body(readBody(db, 'work-system/contract/spec/bom-spec', options))).toMatchObject({
    path: 'docs/bom.md',
    body: '\uFEFF# Title\n\nBody.\n\n',
  });
  // A fragment always reads the record, never its document.
  expect(readBody(db, 'work-system/contract/spec/whole-spec#REQ-NONE', options)).toMatchObject({
    code: 'IA-RUNTIME-READ-FRAGMENT',
  });
  expect([...new Set(asked)].sort()).toEqual(['docs/UPPER.MD', 'docs/bom.md', 'docs/data.json', 'docs/spec.md']);
});

it('refuses an unreachable locator: a missing file or anchor, an anchor outside markdown, bytes that are not UTF-8, a path escape', () => {
  const { root, options, asked } = located(),
    db = database(root);
  const unreachable = (name: string, value: string, reason: string, path?: string) =>
    expect(readBody(db, `work-system/contract/spec/${name}`, options), name).toEqual({
      ok: false,
      code: 'IA-RUNTIME-READ-UNREACHABLE',
      message: `The work.source of work-system/contract/spec/${name}, ${value}, ${reason}`,
      identity: `work-system/contract/spec/${name}`,
      ...(path === undefined ? {} : { path }),
    });
  unreachable(
    'missing-anchor-spec',
    'docs/spec.md#not-a-heading',
    'selects heading #not-a-heading, which docs/spec.md does not have',
    'docs/spec.md',
  );
  unreachable(
    'json-anchor-spec',
    'docs/data.json#top',
    'has an anchor, but only a markdown file has headings to select',
    'docs/data.json',
  );
  unreachable('binary-spec', 'docs/binary.md', 'is not UTF-8 text', 'docs/binary.md');
  // An anchor alone names no file to read.
  unreachable('fileless-spec', '#spec', 'names no file');
  const absent = readBody(db, 'work-system/contract/spec/absent-spec', options);
  expect(absent).toMatchObject({ ok: false, code: 'IA-RUNTIME-READ-UNREACHABLE', path: 'docs/absent.md' });
  expect(absent.ok ? '' : absent.message).toMatch(/^The work\.source of .*, docs\/absent\.md, cannot be read: ENOENT/);
  // No path escape: a locator outside the workspace never reaches the host's reader.
  unreachable('escaping-spec', '../outside.md', 'is outside the workspace');
  unreachable('absolute-spec', '/etc/hosts', 'is outside the workspace');
  // A URL is no workspace path: it is not canonicalized into one, and nothing is fetched or read.
  unreachable('url-spec', 'https://example.com/spec.md', 'is a URL, and a read fetches nothing');
  expect(asked.some((path) => /outside|hosts|example/.test(path))).toBe(false);
});

it('reads the authoring guide reference and the template resource of an adopted mount from the directory bound to it', () => {
  const root = workspace(null),
    vendor = 'vendor/foundation';
  cpSync(resolve(import.meta.dirname, '../../../examples/conformance/native'), resolve(root, vendor, '.ia/src'), {
    recursive: true,
  });
  put(
    root,
    `${vendor}/.ia/src/systems/authoring-system/records/guide.ia`,
    '#! ia 1.0\n@authoring-guide spec-guide\n  meaning\n    says "Guides a spec."\n    answers "How is a spec authored?"\n  reference\n    owner work-system\n    word spec\n    schema @schema spec\n    document "docs/spec-guide.md"\n  guidance\n    select-when "A spec."\n    avoid-when "Not a spec."\n    consider "Fields."\n  relationships\n    cites @schema spec\n',
  );
  put(
    root,
    `${vendor}/.ia/src/systems/template-system/records/template.ia`,
    '#! ia 1.0\n@template located-template\n  meaning\n    says "Renders a captured resource."\n    answers "Which resource does it render?"\n  template\n    filename "out.json"\n    parameters []\n    lines []\n    profile structured-v1\n    resource "templates/located.json"\n',
  );
  const pinned = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = sha256(stableSerialize(pinned));
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'foundation', path: vendor, revision }] }),
  );
  put(root, '.ia/src/systems/agent-system/records/local.ia', '#! ia 1.0\n');
  // The documents live beside the mount's `.ia/src`, where the adopter's files are; nothing is under the label.
  put(root, `${vendor}/docs/spec-guide.md`, '# Guide\n');
  put(root, `${vendor}/templates/located.json`, '{"format": "ia.structured-template.v1"}\n');
  // The workspace's own files at the same relative paths are another tree's, so they are never read.
  put(root, 'docs/spec-guide.md', '# Not this guide\n');
  const db = database(root),
    tree = `.ia/adopted/foundation/${revision}`,
    guide = 'authoring-system/definition/authoring-guide/spec-guide',
    asked: string[] = [];
  const read = (path: string): Uint8Array => {
    asked.push(path);
    return readFileSync(resolve(root, path));
  };
  expect(db.report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  expect(db.get(guide)?.source.path.startsWith(`${tree}/.ia/src/`)).toBe(true);
  const options: ReadBodyOptions = { read, mounts: new Map([[tree, vendor]]) };
  expect(body(readBody(db, guide, options))).toMatchObject({
    kind: 'document',
    path: `${vendor}/docs/spec-guide.md`,
    digest: sha256('# Guide\n'),
    body: '# Guide\n',
  });
  expect(body(readBody(db, 'template-system/template/template/located-template', options))).toMatchObject({
    kind: 'document',
    path: `${vendor}/templates/located.json`,
  });
  expect(asked).toEqual([`${vendor}/docs/spec-guide.md`, `${vendor}/templates/located.json`]);
  // A label is no directory: without a binding for it, or with one for another revision, the read refuses unreached.
  for (const mounts of [undefined, new Map([[`.ia/adopted/foundation/${'0'.repeat(64)}`, vendor]])])
    expect(readBody(db, guide, { read, ...(mounts === undefined ? {} : { mounts }) })).toEqual({
      ok: false,
      code: 'IA-RUNTIME-READ-UNREACHABLE',
      message: `The reference.document of ${guide}, docs/spec-guide.md, is in adopted mount ${tree}, which the read binds to no directory`,
      identity: guide,
    });
  expect(asked).toHaveLength(2);
  // An adopted record without a source locator reads its own body, and needs no binding.
  expect(body(readBody(db, AGENT, { read }))).toMatchObject({ identity: AGENT, kind: 'record' });
  expect(db.get(AGENT)?.source.path.startsWith(`${tree}/`)).toBe(true);
});

it('refuses an identity not admitted, a missing fragment and, unless asked, a record at runtime placement', () => {
  const root = workspace(),
    runtime: Location = { placement: { kind: 'runtime', band: 0, reach: '' }, provenance: 'runtime' },
    principle = 'governance-system/governance/principle/sample-principle';
  const db = database(root, {
    locations: { '.ia/src/systems/governance-system/records/sample-principle.ia': runtime },
  });
  const options: ReadBodyOptions = { read: () => new Uint8Array() };
  expect(readBody(db, 'agent-system/binding/agent/absent', options)).toEqual({
    ok: false,
    code: 'IA-RUNTIME-READ-UNADMITTED',
    message: "agent-system/binding/agent/absent is not in this workspace's sources",
    identity: 'agent-system/binding/agent/absent',
  });
  expect(readBody(db, `${AGENT}#act/Decision`, options)).toEqual({
    ok: false,
    code: 'IA-RUNTIME-READ-FRAGMENT',
    message: `${AGENT} has no cell act/Decision`,
    identity: AGENT,
    path: db.get(AGENT)!.source.path,
    line: db.get(AGENT)!.source.line,
  });
  expect(readBody(db, `${CONTRACT}#REQ-ABSENT`, options)).toEqual({
    ok: false,
    code: 'IA-RUNTIME-READ-FRAGMENT',
    message: `${CONTRACT} has no requirement REQ-ABSENT`,
    identity: CONTRACT,
    path: db.get(CONTRACT)!.source.path,
    line: db.get(CONTRACT)!.source.line,
  });
  expect(db.get(principle)?.band).toBe(0);
  const refused = readBody(db, principle, options);
  expect(refused).toEqual({
    ok: false,
    code: 'IA-RUNTIME-READ-PLACEMENT',
    message: `${principle} is at runtime placement (band 0), which a read includes only when asked to`,
    identity: principle,
    path: '.ia/src/systems/governance-system/records/sample-principle.ia',
    line: db.get(principle)!.source.line,
  });
  expect(Object.isFrozen(refused)).toBe(true);
  // The placement is judged before the fragment, and the flag reads the record as any other.
  expect(readBody(db, `${principle}#REQ-ABSENT`, options)).toMatchObject({ code: 'IA-RUNTIME-READ-PLACEMENT' });
  expect(body(readBody(db, principle, { ...options, includeRuntime: true }))).toMatchObject({
    identity: principle,
    kind: 'record',
    body: 'Sample fixture statement 1.',
  });
  expect(() => readBody(db, 'not a locator', options)).toThrow('IA-RUNTIME-REQUEST-INVALID');
});
