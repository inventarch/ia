/**
 * A doctor check's structured fix (consumer CLI contract §2.12): the flow derived from the parsed form under the
 * grammar of the action it names, and the two forms the console runs, `previewArgv` and `confirmedArgv`.
 */
import { expect, it } from 'vitest';
import { findCommand, ownedOptions } from '../src/commands.js';
import type { Fix } from '../src/fix.js';
import { actionGrammar, confirmedArgv, deriveFlow, displayFix, externalFix, iaFix, previewArgv } from '../src/fix.js';
import { OWNED } from '../src/workspaces.js';

const ia = (argv: readonly string[], flow: Fix['flow'], writesTo: Fix['writesTo'] = 'repo'): Fix => ({
  program: 'ia',
  argv,
  flow,
  writesTo,
});
const WORKSPACES = findCommand('workspaces')!;

it('an option that conflicts with apply makes the form confirm (rule 1)', () => {
  expect(deriveFlow(['init', '--forget-decline'])).toBe('confirm');
});
it('a required apply makes the form confirm (rule 2)', () => {
  expect(deriveFlow(['restore', '--apply'])).toBe('confirm');
});
it('an optional apply makes the form preview-apply (rule 3)', () => {
  expect(deriveFlow(['install'])).toBe('preview-apply');
});
it('a form that already holds --apply keeps its argv and is still preview-apply', () => {
  expect(deriveFlow(['host', 'claude', '--user', '--apply'])).toBe('preview-apply');
  const { remedy, fix } = iaFix(['host', 'claude', '--user', '--apply'], 'user');
  expect(fix).toEqual(ia(['host', 'claude', '--user', '--apply'], 'preview-apply', 'user'));
  expect(remedy).toBe('ia host claude --user --apply');
});
it('a preview option makes the form preview-flag (rule 4)', () => {
  expect(deriveFlow(['capture'])).toBe('preview-flag');
});
it("recover's declared flow is confirm, and its required root is added when given and missing (rule 5)", () => {
  expect(deriveFlow(['recover', 'installation', '--root', '/r'])).toBe('confirm');
  const { remedy, fix } = iaFix(['recover', 'installation'], 'repo', 'C:\\My Repo');
  expect(fix).toEqual(ia(['recover', 'installation', '--root', 'C:\\My Repo'], 'confirm'));
  expect(remedy).toBe('ia recover installation --root "C:\\\\My Repo"');
  // Already rooted: nothing is added.
  expect(iaFix(['recover', 'installation', '--root', '/r'], 'repo', '/other').fix!.argv).toEqual([
    'recover',
    'installation',
    '--root',
    '/r',
  ]);
});
it('a read or validate catalog mode is immediate (rule 6)', () => {
  expect(deriveFlow(['validate'])).toBe('immediate');
});
it('no flow derives for doctor, inspect, vocabulary and format --check (rule 7)', () => {
  for (const argv of [['doctor'], ['inspect'], ['vocabulary'], ['format', '--check']])
    expect(deriveFlow(argv), argv.join(' ')).toBeNull();
  expect(iaFix(['doctor'], 'none').fix).toBeNull();
  expect(iaFix(['doctor'], 'none').remedy).toBe('ia doctor');
});
it('an unparseable argv has no flow', () => {
  expect(deriveFlow(['install', '--nope'])).toBeNull();
  expect(deriveFlow(['no-such-command'])).toBeNull();
  expect(deriveFlow([])).toBeNull();
  expect(iaFix(['validate', '--severity', 'loud'], 'none').fix).toBeNull();
});
it('an external fix is always confirm and displays as its argv', () => {
  expect(externalFix(['npm', 'install'], 'repo')).toEqual({
    remedy: 'npm install',
    fix: { program: 'external', argv: ['npm', 'install'], flow: 'confirm', writesTo: 'repo' },
  });
});
it('displayFix round-trips a Windows path with a space through quote', () => {
  const fix = ia(['recover', 'installation', '--root', 'C:\\Program Files\\repo'], 'confirm');
  expect(displayFix(fix)).toBe('ia recover installation --root "C:\\\\Program Files\\\\repo"');
  expect(displayFix({ ...fix, program: 'external', argv: ['npm', 'install', '--prefix', 'C:\\a b'] })).toBe(
    'npm install --prefix "C:\\\\a b"',
  );
});

// Action-specific grammar: each action reads only its own options.
it('workspaces derives its flow per action', () => {
  expect(deriveFlow(['workspaces', 'add', 'R'])).toBe('confirm');
  expect(deriveFlow(['workspaces', 'remove', 'R'])).toBe('confirm');
  expect(deriveFlow(['workspaces', 'find', 'F'])).toBe('preview-apply');
  expect(deriveFlow(['workspaces', 'list'])).toBeNull();
});
it('an option another action owns does not parse under this one', () => {
  expect(deriveFlow(['workspaces', 'add', 'R', '--apply'])).toBeNull();
  expect(deriveFlow(['workspaces', 'add', 'R', '--depth', '2'])).toBeNull();
  expect(deriveFlow(['workspaces', 'nope'])).toBeNull();
});
it('actionGrammar removes the options other actions own, and knows no other action', () => {
  const add = actionGrammar(WORKSPACES, 'add')!;
  expect(add.options.map((option) => option.name)).not.toContain('apply');
  expect(add.options.map((option) => option.name)).toContain('id');
  expect(actionGrammar(WORKSPACES, 'find')!.options.map((option) => option.name)).toContain('apply');
  expect(actionGrammar(WORKSPACES, 'nope')).toBeNull();
  expect(actionGrammar(WORKSPACES, undefined)).toBeNull();
});
it('a command with no actions is unaffected', () => {
  const install = findCommand('install')!;
  expect(actionGrammar(install, undefined)).toBe(install.grammar);
  expect(actionGrammar(install, 'kit-a')).toBe(install.grammar);
  expect(deriveFlow(['install', 'kit-a'])).toBe('preview-apply');
});
it("workspaces' owned options are derived from the command spec (one source)", () => {
  expect(OWNED).toEqual(ownedOptions(WORKSPACES));
  expect(OWNED).toEqual({ id: 'add', label: 'add', depth: 'find', apply: 'find' });
});

// The normalisation contract.
it('previewArgv strips apply and yes from a preview-apply form', () => {
  expect(previewArgv(ia(['host', 'claude', '--user', '--apply'], 'preview-apply'))).toEqual([
    'host',
    'claude',
    '--user',
  ]);
  expect(previewArgv(ia(['install', 'kit-a', '--apply', '--yes'], 'preview-apply'))).toEqual(['install', 'kit-a']);
  expect(previewArgv(ia(['install', 'kit-a', '--apply', '-y'], 'preview-apply'))).toEqual(['install', 'kit-a']);
});
it('previewArgv adds --preview to a preview-flag form and has nothing for confirm and immediate', () => {
  expect(previewArgv(ia(['capture'], 'preview-flag'))).toEqual(['capture', '--preview']);
  expect(previewArgv(ia(['capture', '--preview'], 'preview-flag'))).toEqual(['capture', '--preview']);
  expect(previewArgv(ia(['recover', 'installation', '--root', 'R'], 'confirm'))).toBeNull();
  expect(previewArgv(ia(['validate'], 'immediate', 'none'))).toBeNull();
});
it('confirmedArgv completes a preview-apply form with --apply --yes', () => {
  expect(confirmedArgv(ia(['host', 'claude', '--user'], 'preview-apply'))).toEqual([
    'host',
    'claude',
    '--user',
    '--apply',
    '--yes',
  ]);
  expect(confirmedArgv(ia(['host', 'claude', '--user', '--apply'], 'preview-apply'))).toEqual([
    'host',
    'claude',
    '--user',
    '--apply',
    '--yes',
  ]);
  const both = ia(['host', 'claude', '--user', '--apply', '--yes'], 'preview-apply');
  expect(confirmedArgv(both)).toEqual(both.argv);
  expect(confirmedArgv(ia(['install', '--apply', '-y'], 'preview-apply'))).toEqual(['install', '--apply', '-y']);
});
it('confirmedArgv adds --yes to a required apply', () => {
  expect(confirmedArgv(ia(['restore', '--apply'], 'confirm'))).toEqual(['restore', '--apply', '--yes']);
});
it('confirmedArgv leaves a confirm form without apply unchanged and never adds --apply', () => {
  for (const argv of [
    ['recover', 'installation', '--root', 'R'],
    ['init', '--forget-decline'],
    ['workspaces', 'add', 'R'],
    ['workspaces', 'remove', 'R'],
  ])
    expect(confirmedArgv(ia(argv, 'confirm'))).toEqual(argv);
});
it('workspaces previews and confirms per action', () => {
  expect(previewArgv(iaFix(['workspaces', 'add', 'R'], 'user').fix!)).toBeNull();
  const find = iaFix(['workspaces', 'find', 'F', '--apply', '--yes'], 'user').fix!;
  expect(find.flow).toBe('preview-apply');
  expect(previewArgv(find)).toEqual(['workspaces', 'find', 'F']);
  expect(confirmedArgv(iaFix(['workspaces', 'find', 'F'], 'user').fix!)).toEqual([
    'workspaces',
    'find',
    'F',
    '--apply',
    '--yes',
  ]);
});
it('confirmedArgv leaves an external fix unchanged', () => {
  const { fix } = externalFix(['npm', 'install', '--apply'], 'repo');
  expect(confirmedArgv(fix)).toEqual(['npm', 'install', '--apply']);
});
it('confirmedArgv is idempotent', () => {
  for (const fix of [
    ia(['host', 'claude', '--user'], 'preview-apply', 'user'),
    ia(['restore', '--apply'], 'confirm'),
    ia(['recover', 'installation', '--root', 'R'], 'confirm'),
    ia(['workspaces', 'find', 'F'], 'preview-apply', 'user'),
    ia(['validate'], 'immediate', 'none'),
  ]) {
    const once = confirmedArgv(fix);
    expect(confirmedArgv({ ...fix, argv: once })).toEqual(once);
  }
});
it("an extension's preview-apply fix previews as given and confirms with --apply exactly once", () => {
  // An extension's own command, which the core grammar does not know.
  const fix = ia(['acme', 'repair'], 'preview-apply', 'user');
  expect(previewArgv(fix)).toEqual(['acme', 'repair']);
  expect(confirmedArgv(fix)).toEqual(['acme', 'repair', '--apply']);
  expect(confirmedArgv({ ...fix, argv: ['acme', 'repair', '--apply'] })).toEqual(['acme', 'repair', '--apply']);
  expect(confirmedArgv({ ...fix, argv: confirmedArgv(fix) }).filter((token) => token === '--apply')).toHaveLength(1);
  // Its other flows run as given.
  expect(confirmedArgv(ia(['acme', 'login'], 'confirm', 'user'))).toEqual(['acme', 'login']);
});
