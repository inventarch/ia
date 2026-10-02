import { expect, it } from 'vitest';
import {
  atom,
  blockSymbolWidth,
  contentColumn,
  createProgress,
  document,
  entry,
  entryColumn,
  errorBlock,
  fieldRows,
  headerLine,
  indentOf,
  MAX_WIDTH,
  resolveCapabilities,
  sectionLabel,
  statusSymbol,
  stripMessage,
  style,
  truncateDigest,
  words,
  wrapTokens,
} from '../src/render.js';
import type { Capabilities, Terminal } from '../src/render.js';
import { runBounded } from '@tools/testing/subprocess.js';

const terminal = (env: Record<string, string | undefined>, isTTY = true, columns?: number): Terminal =>
  ({ env, isTTY, ...(columns === undefined ? {} : { columns }) }) satisfies Terminal;
/**
 * §6.4's effective width, which §7's blocks are generated at. An earlier revision of §7 was hand-wrapped at 74;
 * §6.4 is the normative half, so the examples were regenerated rather than the rule bent to fit them.
 */
const REFERENCE_WIDTH = MAX_WIDTH;
const plain = (ascii: boolean): Capabilities => ({ color: false, ascii, width: REFERENCE_WIDTH });
const ansi = /\u001b\[[0-9;]*m/g;

it('resolves every colour precedence branch of section 6.7 from an explicit environment', () => {
  const on = { color: true, ascii: false, width: 80 };
  expect(resolveCapabilities(terminal({ NO_COLOR: '' }), { color: true })).toEqual({ ...on, color: false });
  expect(resolveCapabilities(terminal({ NO_COLOR: '1', FORCE_COLOR: '1' }))).toMatchObject({ color: false });
  expect(resolveCapabilities(terminal({}), { color: false })).toMatchObject({ color: false });
  expect(resolveCapabilities(terminal({}), { json: true })).toMatchObject({ color: false });
  expect(resolveCapabilities(terminal({}, false), { color: true })).toMatchObject({ color: true });
  expect(resolveCapabilities(terminal({ FORCE_COLOR: '1' }, false))).toMatchObject({ color: true });
  expect(resolveCapabilities(terminal({ FORCE_COLOR: '0' }, false))).toMatchObject({ color: false });
  expect(resolveCapabilities(terminal({ FORCE_COLOR: '0' }, true))).toMatchObject({ color: true });
  expect(resolveCapabilities(terminal({}, false))).toMatchObject({ color: false });
  expect(resolveCapabilities(terminal({ TERM: 'dumb' }))).toMatchObject({ color: false });
  expect(resolveCapabilities(terminal({ TERM: 'xterm-256color' }))).toEqual(on);
});

it('selects the symbol set from --ascii, IA_ASCII and the locale variables', () => {
  expect(resolveCapabilities(terminal({}), { ascii: true })).toMatchObject({ ascii: true });
  expect(resolveCapabilities(terminal({ IA_ASCII: '' }))).toMatchObject({ ascii: true });
  expect(resolveCapabilities(terminal({ LANG: 'C' }))).toMatchObject({ ascii: true });
  expect(resolveCapabilities(terminal({ LC_ALL: 'C', LC_CTYPE: 'POSIX' }))).toMatchObject({ ascii: true });
  expect(resolveCapabilities(terminal({ LANG: 'en_US.UTF-8' }))).toMatchObject({ ascii: false });
  expect(resolveCapabilities(terminal({ LC_CTYPE: 'en_US.utf8' }))).toMatchObject({ ascii: false });
  expect(resolveCapabilities(terminal({ LC_ALL: 'C', LANG: 'en_US.UTF-8' }))).toMatchObject({ ascii: false });
  expect(resolveCapabilities(terminal({}))).toMatchObject({ ascii: false });
  expect(resolveCapabilities(terminal({ NO_COLOR: '1' }))).toMatchObject({ ascii: false, color: false });
  expect(resolveCapabilities(terminal({}), { ascii: true, color: true })).toMatchObject({ ascii: true, color: true });
});

it('caps the width at 80 and falls back to 80 whenever columns is absent or unusable', () => {
  expect(resolveCapabilities(terminal({}, true, 120)).width).toBe(80);
  expect(resolveCapabilities(terminal({}, true, 52)).width).toBe(52);
  expect(resolveCapabilities(terminal({}, true)).width).toBe(80);
  expect(resolveCapabilities(terminal({}, false, 120)).width).toBe(80);
  expect(resolveCapabilities(terminal({}, true, 0)).width).toBe(80);
  expect(resolveCapabilities(terminal({}, true, -1)).width).toBe(80);
  expect(resolveCapabilities(terminal({}, true, 52.5)).width).toBe(80);
});

it('reports process.stdout.columns as undefined off a terminal, the case the fallback covers', async () => {
  const probe = await runBounded(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify([process.stdout.isTTY ?? null, process.stdout.columns ?? null]))'],
    { timeoutMs: Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 10_000 },
  );
  expect(probe.status).toBe(0);
  expect(JSON.parse(probe.stdout)).toEqual([null, null]);
  expect(resolveCapabilities({ env: {}, isTTY: false, columns: undefined }).width).toBe(80);
});

it('carries both symbol sets with their declared display widths', () => {
  const unicode = (['success', 'error', 'warning', 'unknown', 'info', 'step'] as const).map((name) =>
    statusSymbol(name, false),
  );
  expect(unicode.map((symbol) => symbol.text)).toEqual(['\u2714', '\u2716', '\u25b2', '?', '\u2022', '\u2192']);
  expect(unicode.map((symbol) => symbol.width)).toEqual([1, 1, 1, 1, 1, 1]);
  const ascii = (['success', 'error', 'warning', 'unknown', 'info', 'step'] as const).map((name) =>
    statusSymbol(name, true),
  );
  expect(ascii.map((symbol) => symbol.text)).toEqual(['[ok]', '[error]', '[warn]', '[?]', '*', '->']);
  expect(ascii.map((symbol) => symbol.width)).toEqual([4, 7, 6, 3, 1, 2]);
  expect((['added', 'removed', 'updated'] as const).map((name) => statusSymbol(name, true).text)).toEqual([
    '+',
    '-',
    '~',
  ]);
  expect(statusSymbol('info', true).text).not.toBe(statusSymbol('removed', true).text);
});

it('rule 1: indents a block by two spaces per depth', () => {
  expect([indentOf(0), indentOf(1), indentOf(2)]).toEqual([0, 2, 4]);
  expect(entry([words('at depth zero')], { depth: 0 }, plain(false))).toEqual(['at depth zero']);
  expect(entry([words('at depth one')], { depth: 1 }, plain(false))).toEqual(['  at depth one']);
  expect(entry([words('at depth two')], { depth: 2 }, plain(false))).toEqual(['    at depth two']);
});

it('rule 2: places content at 2·d + width + 2, taking width from the widest symbol in the block', () => {
  expect(contentColumn(indentOf(0), statusSymbol('error', false))).toBe(3);
  expect(contentColumn(indentOf(1), statusSymbol('error', false))).toBe(5);
  expect(contentColumn(indentOf(0), statusSymbol('error', true))).toBe(9);
  expect(contentColumn(indentOf(1), statusSymbol('error', true))).toBe(11);
  expect(entryColumn({ depth: 1 }, false)).toBe(2);
  expect(entry([words('two facts'), words('hang here')], { depth: 1, symbol: 'warning' }, plain(true))).toEqual([
    '  [warn]  two facts',
    '          hang here',
  ]);
  // A mixed-symbol block shares one content column: [error] is the widest, so [ok], [warn] and [?] pad out to it.
  expect(blockSymbolWidth(['success', 'error', 'warning', 'unknown'], true)).toBe(7);
  expect(blockSymbolWidth(['success', 'error', 'warning', 'unknown'], false)).toBe(1);
  const mixed = [
    { symbol: 'success' as const, label: 'Node', value: words('v22.22.0') },
    { symbol: 'error' as const, label: 'Pending state', value: words('interrupted') },
    { symbol: 'warning' as const, label: 'Root', value: words('absent') },
    { symbol: 'unknown' as const, label: 'Host', value: words('unreported') },
  ];
  expect(fieldRows(mixed, { depth: 1 }, plain(true))).toEqual([
    '  [ok]     Node           v22.22.0',
    '  [error]  Pending state  interrupted',
    '  [warn]   Root           absent',
    '  [?]      Host           unreported',
  ]);
  expect(
    new Set(fieldRows(mixed, { depth: 1 }, plain(true)).map((row) => row.length - row.trimStart().length)),
  ).toEqual(new Set([2]));
  expect(fieldRows(mixed, { depth: 1 }, plain(false))).toEqual([
    '  ✔  Node           v22.22.0',
    '  ✖  Pending state  interrupted',
    '  ▲  Root           absent',
    '  ?  Host           unreported',
  ]);
  // The block width never reaches a nested action, which keeps rule 3's own formula.
  expect(entryColumn({ column: 5, symbol: 'step' }, false)).toBe(8);
  expect(entryColumn({ column: 11, symbol: 'step' }, true)).toBe(15);
});

it('rule 3: hangs every continuation at the entry content column, and an action one level down', () => {
  const caps = plain(false);
  expect(
    entry(
      [words('a fact that is long enough to wrap when the width is small'), words('a second fact')],
      { depth: 1, symbol: 'info' },
      { ...caps, width: 40 },
    ),
  ).toEqual(['  •  a fact that is long enough to wrap', '     when the width is small', '     a second fact']);
  // A value that wraps hangs at the content column, not at the value column.
  expect(
    fieldRows(
      [
        {
          symbol: 'error',
          label: 'Pending state',
          value: words('.ia/distributions/pending.json exists; an apply was interrupted'),
          action: words('ia-distribution recover'),
        },
      ],
      { depth: 1 },
      caps,
    ),
  ).toEqual([
    '  ✖  Pending state  .ia/distributions/pending.json exists; an apply was',
    '     interrupted',
    '     →  ia-distribution recover',
  ]);
  expect(entry([words('nested at the parent content column')], { column: 5, symbol: 'step' }, caps)).toEqual([
    '     →  nested at the parent content column',
  ]);
  expect(
    entry(
      [words('one two three four five six seven')],
      { column: 11, symbol: 'step' },
      { ...caps, ascii: true, width: 30 },
    ),
  ).toEqual(['           ->  one two three', '               four five six', '               seven']);
});

it('rule 4: aligns one value column per block at max(len(label)) + 2', () => {
  const rows = fieldRows(
    [
      { symbol: 'success', label: 'Node', value: words('v22.22.0 on win32 x64') },
      { symbol: 'success', label: 'Support target', value: words('win32 x64 on Node 22 matches the declared target') },
      { symbol: 'success', label: 'Vocabulary', value: words('39 words, source digest 21307d3dd83d') },
    ],
    { depth: 1 },
    plain(false),
  );
  expect(rows).toEqual([
    '  \u2714  Node            v22.22.0 on win32 x64',
    '  \u2714  Support target  win32 x64 on Node 22 matches the declared target',
    '  \u2714  Vocabulary      39 words, source digest 21307d3dd83d',
  ]);
  // max(len(label)) is 14, so every value in the block starts at content column 5 plus 16.
  expect([rows[0]?.indexOf('v22.22.0'), rows[1]?.indexOf('win32 x64 on'), rows[2]?.indexOf('39 words')]).toEqual([
    21, 21, 21,
  ]);
  const fields = [
    { label: 'Pending state', value: words('interrupted apply'), symbol: 'error' as const },
    { label: 'Host', value: words('Not reported'), symbol: 'unknown' as const },
  ];
  expect(fieldRows(fields, { depth: 1 }, { color: false, ascii: false, width: 34 })).toEqual([
    '  \u2716  Pending state  interrupted',
    '     apply',
    '  ?  Host  Not reported',
  ]);
  expect(fieldRows(fields, { depth: 1 }, { color: false, ascii: false, width: 60 })).toEqual([
    '  \u2716  Pending state  interrupted apply',
    '  ?  Host           Not reported',
  ]);
});

it('wraps prose at word boundaries and never breaks an identifier that overruns the width', () => {
  const identity = 'compliance-system/contract/signature/foundation-authoring-contract#REQ-FOUNDATION-INPUT:';
  const lines = entry(
    [[atom('IA-COMP-NOT-EVALUATED', null, 0), ...words(`${identity} No structural evaluator is supplied`, null, 2)]],
    { depth: 1, symbol: 'warning' },
    plain(false),
  );
  expect(lines).toEqual([
    '  \u25b2  IA-COMP-NOT-EVALUATED',
    `     ${identity}`,
    '     No structural evaluator is supplied',
  ]);
  expect(lines[1]?.length).toBeGreaterThan(REFERENCE_WIDTH);
  expect(wrapTokens(words('one two three four'), 0, { color: false, ascii: false, width: 9 })).toEqual([
    'one two',
    'three',
    'four',
  ]);
});

it('truncates a bare digest field and never a digest inside a URL or a path', () => {
  const value = '4b7d9e21c08a3f5d6e2b9014c7a8d35f0e1b62497acd8035fe91b2d4a607c8e3';
  expect(truncateDigest(value, false)).toBe('4b7d9e21c08a\u2026');
  expect(truncateDigest(value, true)).toBe('4b7d9e21c08a...');
  expect(truncateDigest(`https://dist.example.invalid/artifacts/${value}.ia.tgz`, false)).toBe(
    `https://dist.example.invalid/artifacts/${value}.ia.tgz`,
  );
  expect(truncateDigest(`.ia/distributions/store/${value}/`, false)).toBe(`.ia/distributions/store/${value}/`);
  expect(truncateDigest('4b7d9e21c08a', false)).toBe('4b7d9e21c08a');
});

it('strips the prefixes each error family adds before the cause element is printed', () => {
  expect(
    stripMessage('IA-RUNTIME-REQUEST-INVALID: Request must be an object', { code: 'IA-RUNTIME-REQUEST-INVALID' }),
  ).toBe('Request must be an object');
  expect(
    stripMessage(
      'IA-DB-SOURCE-UNAVAILABLE: Distribution recovery-required: Run explicit distribution recovery before reading',
      {
        code: 'IA-DB-SOURCE-UNAVAILABLE',
      },
    ),
  ).toBe('Distribution recovery-required: Run explicit distribution recovery before reading');
  expect(stripMessage('Artifact request returned 503', { code: 'IA-DIST-ARTIFACT-UNAVAILABLE' })).toBe(
    'Artifact request returned 503',
  );
  expect(
    stripMessage('a.ia:14: system/definition/scenario/x: Fragment #F is absent', {
      location: 'a.ia:14',
      identity: 'system/definition/scenario/x',
    }),
  ).toBe('Fragment #F is absent');
});

it('renders the error block elements in order and names the whole workspace when a finding has no location', () => {
  expect(
    errorBlock(
      { location: '', check: 'COMP-FIXTURES', code: 'IA-COMP-NOT-EVALUATED', message: 'evidence was not supplied' },
      { depth: 1 },
      plain(false),
    ),
  ).toEqual(['  \u2716  (whole workspace)  COMP-FIXTURES', '     IA-COMP-NOT-EVALUATED  evidence was not supplied']);
  expect(
    errorBlock(
      {
        location: 'Z:\\work\\demo',
        code: 'IA-DB-SOURCE-UNAVAILABLE',
        message:
          'IA-DB-SOURCE-UNAVAILABLE: Distribution recovery-required: Run explicit distribution recovery before reading',
        next: [
          ...words('Run "ia doctor" for the full state, then', null, 0),
          atom('"ia-distribution recover --root Z:\\work\\demo".'),
        ],
      },
      { depth: 0 },
      plain(false),
    ),
  ).toEqual([
    '\u2716  Z:\\work\\demo',
    '   IA-DB-SOURCE-UNAVAILABLE  Distribution recovery-required: Run explicit',
    '   distribution recovery before reading',
    '   \u2192  Run "ia doctor" for the full state, then',
    '      "ia-distribution recover --root Z:\\work\\demo".',
  ]);
});

it('never leaves a styled run open across a newline and changes nothing but the sequences', () => {
  expect(style('one\ntwo', 'cyan', true)).toBe('\u001b[36mone\u001b[0m\n\u001b[36mtwo\u001b[0m');
  expect(style('one\ntwo', 'cyan', false)).toBe('one\ntwo');
  const coloured = errorBlock(
    {
      location: 'a.ia:14',
      identity: 'system/definition/scenario/x',
      code: 'IA-COMP-FRAGMENT-MISSING',
      message: 'Fragment #F is absent',
      next: words('Restore #F.'),
    },
    { depth: 1 },
    { color: true, ascii: false, width: REFERENCE_WIDTH },
  );
  for (const line of coloured) {
    expect(line).not.toContain('\n');
    expect((line.match(/\u001b\[0m/g) ?? []).length).toBe((line.match(/\u001b\[(?!0m)/g) ?? []).length);
    // Every opened run closes within its own line, so nothing can be inherited by the next one.
    expect(line.replace(/\u001b\[(?:1|2|31|32|33|36)m[^\u001b]*\u001b\[0m/g, '')).not.toContain('\u001b');
  }
  expect(coloured.map((line) => line.replace(ansi, ''))).toEqual(
    errorBlock(
      {
        location: 'a.ia:14',
        identity: 'system/definition/scenario/x',
        code: 'IA-COMP-FRAGMENT-MISSING',
        message: 'Fragment #F is absent',
        next: words('Restore #F.'),
      },
      { depth: 1 },
      plain(false),
    ),
  );
});

const failingValidate = (caps: Capabilities): string =>
  document(
    [
      headerLine('Workspace', 'Z:\\scratch\\broken-copy', [{ text: 'revision e19c01790798', column: 50 }], caps),
      entry(
        [words('Refused. 398 records, 2 errors, 5 warnings.'), words('5 warnings hidden by --severity error.')],
        { depth: 1, symbol: 'error' },
        caps,
      ),
      [
        sectionLabel('Errors', caps),
        ...errorBlock(
          {
            location: '.ia/src/systems/compliance-system/cases/valid-native-record.ia:14',
            identity: 'compliance-system/definition/scenario/valid-native-record',
            code: 'IA-COMP-FRAGMENT-MISSING',
            message:
              '.ia/src/systems/compliance-system/cases/valid-native-record.ia:14: compliance-system/definition/scenario/valid-native-record: Fragment #REQ-FOUNDATION-INPUTS is absent on compliance-system/contract/signature/foundation-authoring-contract',
          },
          { depth: 1 },
          caps,
        ),
        ...errorBlock(
          {
            location: '.ia/src/systems/compliance-system/contracts/foundation-authoring-contract.ia:11',
            identity: 'compliance-system/contract/signature/foundation-authoring-contract',
            code: 'IA-COMP-COVERAGE-MISSING',
            message:
              '.ia/src/systems/compliance-system/contracts/foundation-authoring-contract.ia:11: compliance-system/contract/signature/foundation-authoring-contract: Requirement REQ-FOUNDATION-INPUT has no unconditional implementing case',
            next: words(
              'Both errors come from one edit. Restore #REQ-FOUNDATION-INPUT at valid-native-record.ia:14, or declare REQ-FOUNDATION-INPUTS as an output of the contract.',
            ),
          },
          { depth: 1 },
          caps,
        ),
      ],
    ],
    { leadingBlank: true },
  );

it('reproduces the failing-validate reference block of section 7.5 in Unicode', () => {
  expect(failingValidate(plain(false))).toBe(`
Workspace  Z:\\scratch\\broken-copy                 revision e19c01790798

  ✖  Refused. 398 records, 2 errors, 5 warnings.
     5 warnings hidden by --severity error.

Errors
  ✖  .ia/src/systems/compliance-system/cases/valid-native-record.ia:14
     compliance-system/definition/scenario/valid-native-record
     IA-COMP-FRAGMENT-MISSING  Fragment #REQ-FOUNDATION-INPUTS is absent on
     compliance-system/contract/signature/foundation-authoring-contract
  ✖  .ia/src/systems/compliance-system/contracts/foundation-authoring-contract.ia:11
     compliance-system/contract/signature/foundation-authoring-contract
     IA-COMP-COVERAGE-MISSING  Requirement REQ-FOUNDATION-INPUT has no
     unconditional implementing case
     →  Both errors come from one edit. Restore #REQ-FOUNDATION-INPUT at
        valid-native-record.ia:14, or declare REQ-FOUNDATION-INPUTS as an output
        of the contract.
`);
});

it('reproduces the same block with ASCII symbols, where the content column moves from 5 to 11', () => {
  expect(failingValidate(plain(true))).toBe(`
Workspace  Z:\\scratch\\broken-copy                 revision e19c01790798

  [error]  Refused. 398 records, 2 errors, 5 warnings.
           5 warnings hidden by --severity error.

Errors
  [error]  .ia/src/systems/compliance-system/cases/valid-native-record.ia:14
           compliance-system/definition/scenario/valid-native-record
           IA-COMP-FRAGMENT-MISSING  Fragment #REQ-FOUNDATION-INPUTS is absent
           on compliance-system/contract/signature/foundation-authoring-contract
  [error]  .ia/src/systems/compliance-system/contracts/foundation-authoring-contract.ia:11
           compliance-system/contract/signature/foundation-authoring-contract
           IA-COMP-COVERAGE-MISSING  Requirement REQ-FOUNDATION-INPUT has no
           unconditional implementing case
           ->  Both errors come from one edit. Restore #REQ-FOUNDATION-INPUT at
               valid-native-record.ia:14, or declare REQ-FOUNDATION-INPUTS as an
               output of the contract.
`);
  expect(failingValidate({ color: true, ascii: true, width: REFERENCE_WIDTH }).replace(ansi, '')).toBe(
    failingValidate(plain(true)),
  );
});

it('rule 5: shares a header line between pairs and splits them below 60 columns', () => {
  const pairs: readonly [string, string, { readonly text: string; readonly column: number }] = [
    'Workspace',
    'Z:\\work\\demo',
    { text: 'revision 3ad9e05b7c14', column: 50 },
  ];
  expect(headerLine(pairs[0], pairs[1], [pairs[2]], plain(false))).toEqual([
    'Workspace  Z:\\work\\demo                           revision 3ad9e05b7c14',
  ]);
  expect(headerLine(pairs[0], pairs[1], [pairs[2]], { color: false, ascii: false, width: 50 })).toEqual([
    'Workspace  Z:\\work\\demo',
    'revision 3ad9e05b7c14',
  ]);
  // A requested column never collapses the four-space minimum gap of rule 5.
  expect(headerLine('Plan', 'install', [{ text: 'format 1', column: 4 }], plain(false))).toEqual([
    'Plan  install    format 1',
  ]);
});

it('rule 6: separates blocks with exactly one blank line and emits no trailing blank or tab', () => {
  const caps = plain(false);
  const rendered = document(
    [
      [sectionLabel('Findings', caps), ...entry([words('first entry')], { depth: 1, symbol: 'error' }, caps)],
      [],
      [sectionLabel('Checks', caps), ...entry([words('second entry')], { depth: 1, symbol: 'success' }, caps)],
      entry([words('3 ok, 1 failed.', 'dim')], { depth: 0 }, caps),
    ],
    { leadingBlank: true },
  );
  expect(rendered).toBe('\nFindings\n  ✖  first entry\n\nChecks\n  ✔  second entry\n\n3 ok, 1 failed.\n');
  expect(rendered).not.toContain('\n\n\n');
  expect(rendered).not.toContain('\t');
  expect(rendered.split('\n').some((line) => line !== line.trimEnd())).toBe(false);
  expect(document([[], []])).toBe('');
  expect(document([['a'], [], ['b']])).toBe('a\n\nb\n');
  // The §7 fixtures obey the same rule, but the assertions above do not depend on them.
  expect(failingValidate(plain(false))).not.toContain('\n\n\n');
});

it('writes progress to the supplied stderr sink only and states completion as text', () => {
  const out: string[] = [],
    err: string[] = [];
  const sink = (isTTY: boolean) => ({ write: (text: string) => void err.push(text), isTTY });
  const tty = createProgress(sink(true), { enabled: true });
  tty.phase('Reading workspace');
  tty.phase('Checking records');
  tty.done('Checked 398 records.');
  expect(err).toEqual(['Reading workspace', '\r\u001b[K', 'Checking records', '\r\u001b[K', 'Checked 398 records.\n']);
  expect(out).toEqual([]);
  err.length = 0;
  const piped = createProgress(sink(false), { enabled: true });
  piped.phase('Reading workspace');
  piped.clear();
  piped.done('Checked 398 records.');
  expect(err).toEqual(['Reading workspace\n', 'Checked 398 records.\n']);
  err.length = 0;
  const quiet = createProgress(sink(true), { enabled: false });
  quiet.phase('Reading workspace');
  quiet.done('Checked 398 records.');
  expect(err).toEqual([]);
});
