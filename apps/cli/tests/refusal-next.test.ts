/**
 * Design row 27 (position-and-projection §12): every refusal names one next command. The codes are enumerated from
 * their sources — every IA code the CLI and the services it calls spell, and every distribution `fail()` code — and
 * the construction sites from the CLI source itself, each next action resolved through the type checker, so a refusal
 * added later without a runnable next command fails here rather than reaching a user. `--json` carries the command in
 * `next`; human output prints it on the `→` line. `run` (workspace-fixture.ts) holds every refusal any suite provokes
 * to the same rule.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, expect, it } from 'vitest';
import { COMP_CODES, EVIDENCE_CODES } from '@inventarch/compliance';
import { DB_CODES } from '@inventarch/db';
import { HOOK_CODES, RUNTIME_CODES } from '@inventarch/runtime';
import { UsageError } from '../src/args.js';
import { dispatch, Refusal, refusalOf, renderRefusal } from '../src/consumer.js';
import { quote, resolveCapabilities } from '../src/render.js';
import {
  cleanup,
  commandsIn,
  FIXTURE,
  FORMATTABLE,
  makeHost,
  nextArgv,
  nextDefect,
  packable,
  repository,
  run,
  scratch,
  workspace,
} from './workspace-fixture.js';

afterAll(cleanup);

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Every `.ts` file under a source directory, recursively. */
const sources = (directory: string): readonly string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.ts') ? [path] : [];
  });
const CODE = /['"`](IA-[A-Z]+(?:-[A-Z]+)+)['"`]/g;
/** The distribution services spell their codes as `fail('<CODE>', …)`, which raises `IA-DIST-<CODE>`. */
const FAIL = /\bfail\(\s*'([A-Z]+(?:-[A-Z]+)*)'/g;
const cliSources = sources(resolve(repository, 'apps/cli/src'));
/** The services the CLI calls and their workspace dependencies: every code a verb can receive is spelled in them. */
const serviceSources = [
  'apps/distribution',
  'packages/compliance',
  'packages/db',
  'packages/graph',
  'packages/language',
  'packages/runtime',
  'packages/workspace-runtime',
].flatMap((owner) => sources(resolve(repository, owner, 'src')));
const spelled = (paths: readonly string[]): ReadonlySet<string> =>
  new Set(
    paths.flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return [
        ...[...text.matchAll(CODE)].map((match) => match[1]!),
        ...[...text.matchAll(FAIL)].map((m) => `IA-DIST-${m[1]}`),
      ];
    }),
  );
const cliCodes = spelled(cliSources);
const codes = [...new Set([...cliCodes, ...spelled(serviceSources), 'IA-CLI-INTERRUPTED'])].sort();

it('enumerates the codes from their sources, the registered tables included', () => {
  // The scan finds what the service tables register, so it is the larger source of truth, not a sample of it.
  for (const code of [...DB_CODES, ...COMP_CODES, ...EVIDENCE_CODES, ...RUNTIME_CODES, ...HOOK_CODES])
    expect(codes, code).toContain(code);
  for (const code of ['IA-CLI-USAGE', 'IA-CLI-FAILED', 'IA-CLI-CONFLICT', 'IA-DIST-INSTALL-BUSY', 'IA-DIST-PLAN-STALE'])
    expect(codes, code).toContain(code);
  expect(codes.length).toBeGreaterThan(150);
});

it('gives a service refusal of every code one next command, in --json and in human output', () => {
  const caps = resolveCapabilities({ env: {}, isTTY: false }, {});
  for (const code of codes) {
    const raised = code === 'IA-CLI-USAGE' ? new UsageError('sample') : Object.assign(new Error('sample'), { code });
    const refusal = refusalOf(raised, { command: 'install', root: '/w' });
    const machine = JSON.parse(renderRefusal(refusal, caps, true).stdout) as { code: string; next: unknown };
    expect(machine.code, code).toBe(code);
    expect(typeof machine.next, code).toBe('string');
    const next = machine.next as string;
    expect(nextDefect(next), `${code}: ${next}`).toBeNull();
    // The fallback names the verb's help for usage, `ia validate` for a record finding and `ia doctor` otherwise,
    // rooted as the refused invocation was.
    const [command] = commandsIn(next);
    const area = code.split('-')[1]!;
    expect(command, code).toBe(
      code === 'IA-CLI-USAGE'
        ? 'ia install --help'
        : ['COMP', 'GRAPH', 'LANG'].includes(area)
          ? 'ia validate --root /w'
          : 'ia doctor --root /w',
    );
    const human = renderRefusal(refusal, caps, false);
    expect(human.stdout, code).toBe('');
    expect(flat(human.stderr), code).toContain(`→ ${flat(next)}`);
  }
  // With no verb or root known, the fallback is the binary's own help or a bare `ia doctor`.
  expect(refusalOf(new UsageError('x')).next).toBe('Run "ia --help" for the accepted syntax.');
  expect(commandsIn(refusalOf(new Error('x')).next)).toEqual(['ia doctor']);
});

it('keeps the command a next action quotes on one terminal line, however long, and wraps the prose around it', () => {
  const caps = resolveCapabilities({ env: { NO_COLOR: '1' }, isTTY: true, columns: 60 }, {});
  const command = `ia install acme/app@1.0.0 --root ${quote(`/workspaces/a b/${'nested/'.repeat(6)}ws`)}`;
  const next = `Once the workspace holds an installation to update, run "${command}" first, then plan the update again.`;
  const human = renderRefusal(
    new Refusal('IA-DIST-INPUT-INVALID', 'Update requires an existing installation', 3, null, next),
    caps,
    false,
  );
  const lines = human.stderr.split('\n');
  // The command and the punctuation touching it are one run, past the width; the prose still wraps within it.
  expect(lines.filter((line) => line.includes(`"${command}"`))).toHaveLength(1);
  expect(lines.filter((line) => !line.includes(command)).every((line) => line.length <= 60)).toBe(true);
  expect(flat(human.stderr)).toContain(`→ ${next}`);
});

/**
 * Every construction site's next action, resolved by the type checker down to its string literals and templates: a
 * constant, a helper's return values with its parameters bound to the call's arguments, each branch of a conditional
 * or a fallback (`??`). An interpolation it cannot resolve to text keeps a placeholder — a command where it is quoted
 * (`"${rerun}"`), another refusal's whole next action where it names one (`${refusal.next}`), an argument otherwise —
 * so each text is checked for exactly one command and no option in prose. A parameter that reaches the site unbound
 * (`located`'s `next`) is checked at every call that supplies it. Only a `next` read from a `Refusal` or an
 * `Interrupted` stands for a next action checked where it was built; one read from any other type (a machine protocol
 * row, a mandate refusal) is not, so a site that forwards one fails.
 */
const consumerSource = resolve(repository, 'apps/cli/src/consumer.ts');
/** Sites the scan must fail, and one it must pass, so the scan is shown to catch a next action that runs no command. */
const PROBE = [
  `import { Refusal } from ${JSON.stringify(consumerSource.replaceAll('\\', '/').replace(/\.ts$/, '.js'))};`,
  'declare const row: { readonly next: string };',
  'declare const refused: Refusal;',
  'export const sites = [',
  "  new Refusal('IA-X-PROSE', 'm', 3, null, 'Pass --root <path> with an existing workspace.'),",
  "  new Refusal('IA-X-BARE', 'm', 3, null, 'Run ia inspect --edges both.'),",
  `  new Refusal('IA-X-TWO', 'm', 3, null, 'Run "ia validate" or "ia doctor".'),`,
  "  new Refusal('IA-X-FOREIGN', 'm', 3, null, row.next),",
  "  new Refusal('IA-X-QUOTED', 'm', 3, null, `Run \"${row.next}\".`),",
  "  new Refusal('IA-X-CARRIED', 'm', 3, null, refused.next),",
  '];',
];
const probe = resolve(scratch('refusal-probe'), 'probe.ts');
writeFileSync(probe, `${PROBE.join('\n')}\n`);
const program = ts.createProgram([...cliSources, probe], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  skipLibCheck: true,
  types: [],
});
const checker = program.getTypeChecker();
const ours = new Set(cliSources.map((path) => resolve(path)));
/** The two classes whose `next` a site may carry on unchanged, because their own construction sites are checked here. */
const carriers: ReadonlySet<ts.Node> = new Set(
  program
    .getSourceFile(consumerSource)!
    .statements.filter(
      (statement) =>
        ts.isClassDeclaration(statement) && ['Refusal', 'Interrupted'].includes(statement.name?.text ?? ''),
    ),
);
/** Whether a `.next` is read from a `Refusal` or an `Interrupted`, every member of a union included. */
function carried(access: ts.PropertyAccessExpression): boolean {
  const type = checker.getTypeAtLocation(access.expression);
  return (type.isUnion() ? type.types : [type]).every(
    (member) => member.getSymbol()?.declarations?.some((declaration) => carriers.has(declaration)) === true,
  );
}
/** A `.next` read from any other type, anywhere in an expression. */
const foreignNext = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) && node.name.text === 'next' && !carried(node)) ||
  ts.forEachChild(node, foreignNext) === true;
type Bindings = ReadonlyMap<ts.ParameterDeclaration, { readonly argument: ts.Expression; readonly bindings: Bindings }>;
/** Text, or the parameter an unbound value came from, or nothing the checker can resolve. */
type Resolved = { readonly texts: readonly string[] } | { readonly parameter: ts.ParameterDeclaration } | null;
const STRING_METHODS = new Set(['replace', 'replaceAll', 'trim', 'trimEnd']);
const LIMIT = 256;
/** What another refusal's next action, carried into this one, stands for: one command, checked where it was built. */
const CARRIED = 'Run "ia ‹next›".';

function declarationOf(node: ts.Node): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}
/** A function this source declares, by its declaration or the `const` it initializes. */
function functionOf(declaration: ts.Declaration | undefined): ts.FunctionLikeDeclaration | undefined {
  if (declaration === undefined || !ours.has(resolve(declaration.getSourceFile().fileName))) return undefined;
  if (ts.isFunctionDeclaration(declaration) && declaration.body !== undefined) return declaration;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
  )
    return declaration.initializer;
  return undefined;
}
/** The expressions a function can return, nested functions excluded. */
function returned(fn: ts.FunctionLikeDeclaration): readonly ts.Expression[] {
  if (fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (node.expression !== undefined) found.push(node.expression);
    } else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}
const union = (parts: readonly Resolved[]): Resolved =>
  parts.every((part) => part !== null && 'texts' in part)
    ? { texts: parts.flatMap((part) => (part as { texts: readonly string[] }).texts).slice(0, LIMIT) }
    : null;

function resolveText(expression: ts.Expression, bindings: Bindings, depth = 0): Resolved {
  if (depth > 24) return null;
  const next = (inner: ts.Expression, scope: Bindings = bindings): Resolved => resolveText(inner, scope, depth + 1);
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression))
    return next(expression.expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return { texts: [expression.text] };
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { texts: [] };
  // Another refusal's own next action, carried on unchanged: it was checked where that refusal was built.
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'next')
    return carried(expression) ? { texts: [CARRIED] } : null;
  if (ts.isConditionalExpression(expression)) return union([next(expression.whenTrue), next(expression.whenFalse)]);
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  )
    return union([next(expression.left), next(expression.right)]);
  if (ts.isTemplateExpression(expression)) {
    let texts: readonly string[] = [expression.head.text];
    let before = expression.head.text;
    for (const span of expression.templateSpans) {
      const resolved = next(span.expression);
      // Another type's next action is never taken for a command, quoted or not.
      if (resolved === null && foreignNext(span.expression)) return null;
      const pieces =
        resolved !== null && 'texts' in resolved && resolved.texts.length > 0
          ? resolved.texts
          : [before.endsWith('"') ? 'ia ‹command›' : '‹value›'];
      texts = texts.flatMap((text) => pieces.map((piece) => text + piece + span.literal.text)).slice(0, LIMIT);
      before = span.literal.text;
    }
    return { texts };
  }
  if (ts.isIdentifier(expression)) {
    const declaration = declarationOf(expression);
    if (declaration !== undefined && ts.isParameter(declaration)) {
      const bound = bindings.get(declaration);
      return bound === undefined ? { parameter: declaration } : next(bound.argument, bound.bindings);
    }
    if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined)
      return functionOf(declaration) === undefined ? next(declaration.initializer) : null;
    return null;
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee) && STRING_METHODS.has(callee.name.text)) return next(callee.expression);
    const fn = functionOf(declarationOf(callee));
    if (fn === undefined) return null;
    const scope = new Map(bindings);
    fn.parameters.forEach((parameter, index) => {
      const argument = expression.arguments[index];
      if (argument !== undefined) scope.set(parameter, { argument, bindings });
    });
    const results = returned(fn).map((value) => next(value, scope));
    return results.length === 0 ? null : union(results);
  }
  return null;
}

interface Scan {
  readonly sites: number;
  readonly texts: number;
  /** The parameters a site passed through, each checked at the calls that supply it. */
  readonly parameters: number;
  /** `<file>:<line>: <why>` for each next action that breaks design row 27 or that the checker cannot resolve. */
  readonly defects: readonly string[];
}
/** Every `Refusal` and `Interrupted` construction site in `paths`, its next action checked. */
function scanSites(paths: readonly string[]): Scan {
  let sites = 0,
    texts = 0;
  const defects: string[] = [];
  const pending = new Map<ts.ParameterDeclaration, string>();
  /** One next action at `at`: each branch checked on its own, an unbound parameter checked at its callers. */
  const check = (expression: ts.Expression, at: string): void => {
    if (ts.isParenthesizedExpression(expression)) return check(expression.expression, at);
    if (ts.isConditionalExpression(expression)) {
      check(expression.whenTrue, at);
      check(expression.whenFalse, at);
      return;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      check(expression.left, at);
      check(expression.right, at);
      return;
    }
    if (expression.kind === ts.SyntaxKind.NullKeyword) return;
    if (ts.isIdentifier(expression)) {
      const declaration = declarationOf(expression);
      if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined)
        return check(declaration.initializer, at);
    }
    const resolved = resolveText(expression, new Map());
    if (resolved !== null && 'texts' in resolved) {
      if (resolved.texts.length === 0) defects.push(`${at}: no next action in ${expression.getText()}`);
      for (const text of resolved.texts) {
        texts += 1;
        const defect = nextDefect(text);
        if (defect !== null) defects.push(`${at}: ${defect}: ${text}`);
      }
    } else if (resolved !== null) pending.set(resolved.parameter, at);
    else defects.push(`${at}: the checker cannot resolve the next action ${expression.getText()}`);
  };
  const calls: ts.CallExpression[] = [];
  for (const path of paths) {
    const file = program.getSourceFile(path)!;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        const kind = node.expression.text;
        if (kind === 'Refusal' || kind === 'Interrupted') {
          sites += 1;
          const at = `${path}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          const next = kind === 'Refusal' ? node.arguments?.[4] : node.arguments?.[0];
          if (next === undefined) defects.push(`${at}: no next argument`);
          else check(next, at);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  // A parameter a site passes through is a next action wherever a caller supplies it, and may pass through again.
  const done = new Set<ts.ParameterDeclaration>();
  for (let progress = true; progress; ) {
    progress = false;
    for (const [parameter, site] of [...pending]) {
      if (done.has(parameter)) continue;
      done.add(parameter);
      progress = true;
      const fn = parameter.parent as ts.FunctionLikeDeclaration,
        index = fn.parameters.indexOf(parameter);
      const callers = calls.filter((call) => functionOf(declarationOf(call.expression)) === fn);
      if (callers.length === 0) defects.push(`${site}: ${parameter.getText()} has no caller`);
      for (const call of callers) {
        const file = call.getSourceFile();
        const at = `${file.fileName}:${file.getLineAndCharacterOfPosition(call.getStart()).line + 1}`;
        if (call.arguments[index] !== undefined) check(call.arguments[index]!, at);
      }
    }
  }
  return { sites, texts, parameters: done.size, defects };
}

it('passes a one-command next action at every Refusal and Interrupted construction site', () => {
  const scan = scanSites(cliSources);
  expect(scan.defects).toEqual([]);
  expect(scan.sites).toBeGreaterThan(60);
  expect(scan.parameters).toBeGreaterThan(0);
  expect(scan.texts).toBeGreaterThan(scan.sites);
});

it("fails a site whose next action is prose, an unquoted or second command, or another type's next action", () => {
  const lineOf = (code: string): number => PROBE.findIndex((line) => line.includes(`'${code}'`)) + 1;
  const scan = scanSites([probe]);
  expect(scan.sites).toBe(6);
  // The next action carried from a `Refusal` passes; each of the other five fails at its own line.
  expect(scan.defects.map((defect) => Number(/:(\d+): /.exec(defect)?.[1]))).toEqual(
    ['IA-X-PROSE', 'IA-X-BARE', 'IA-X-TWO', 'IA-X-FOREIGN', 'IA-X-QUOTED'].map(lineOf),
  );
});

/**
 * One invocation per kind of refusal the consumer verbs raise before they open a registry or a network, with the one
 * command its `--json` next action names: the arguments the invocation supplied are filled in, and a rerun of the
 * refused verb leaves out an optional `--apply` and the output flags. `human` is the command human output names where
 * it differs: a near command keeps the invocation as typed, `--json` included.
 */
function invocations(): readonly {
  readonly code: string;
  readonly argv: readonly string[];
  readonly command: string;
  readonly human?: string;
  readonly cwd?: string;
}[] {
  const empty = scratch('refusal-empty'),
    bare = resolve(scratch('refusal-bare'), 'workspace'),
    file = resolve(empty, 'file.txt'),
    absent = resolve(empty, 'absent'),
    compiled = workspace(),
    refused = workspace({ foreign: true }),
    linked = workspace(),
    undecodable = workspace();
  mkdirSync(resolve(bare, '.ia/src'), { recursive: true });
  // A source whose bytes are not UTF-8: the db cannot read it, and no installation is involved.
  writeFileSync(resolve(undecodable, '.ia/src/undecodable.ia'), Buffer.from([0x40, 0xff, 0xfe, 0x0a]));
  writeFileSync(file, 'not a directory\n');
  // Initialized for `ia host`, which then finds the workspace's deliberate defect.
  writeFileSync(resolve(refused, '.ia/release.json'), '{}\n');
  // An initialized workspace with a source directory reached through a junction (a symbolic link elsewhere), which
  // the db refuses to read.
  writeFileSync(resolve(linked, '.ia/release.json'), '{}\n');
  symlinkSync(scratch('refusal-link-target'), resolve(linked, '.ia/src/linked'), 'junction');
  const root = quote(FIXTURE),
    unreadable = quote(realpathSync(linked));
  return [
    { code: 'IA-CLI-USAGE', argv: ['frobnicate'], command: 'ia --help' },
    {
      code: 'IA-CLI-USAGE',
      argv: ['validte', '--root', FIXTURE],
      command: `ia validate --root ${root} --json`,
      human: `ia validate --root ${root}`,
    },
    // A machine route admits only `--root` and `--params`, so the near command keeps only those.
    { code: 'IA-CLI-USAGE', argv: ['scop', '--root', FIXTURE], command: `ia scope --root ${root}` },
    { code: 'IA-CLI-USAGE', argv: ['agent', 'scope'], command: 'ia --help' },
    // A usage refusal the parser raises has no remedy of its own: the verb's help.
    { code: 'IA-CLI-USAGE', argv: ['validate', '--severity', 'none'], command: 'ia validate --help' },
    {
      code: 'IA-CLI-USAGE',
      argv: ['inspect', 'Not/An/Identity/X', '--root', FIXTURE],
      command: `ia inspect --root ${root}`,
    },
    {
      code: 'IA-CLI-USAGE',
      argv: ['vocabulary', 'playbok', '--schema'],
      command: 'ia vocabulary playbook --schema',
    },
    // An init target that cannot be one keeps the host and the id the invocation gave.
    {
      code: 'IA-CLI-USAGE',
      argv: ['init', file, '--host', 'claude'],
      command: 'ia init <directory> --host claude',
    },
    {
      code: 'IA-CLI-USAGE',
      argv: ['init', resolve(empty, 'a', 'b'), '--id', 'acme/thing', '--host', 'codex', '--apply', '--yes'],
      command: `ia init ${quote(resolve(empty, 'a', 'b'))} --id acme/thing --host codex`,
    },
    // A root that is not a directory keeps every other argument the invocation gave, and reruns as a plan.
    {
      code: 'IA-DB-ROOT-INVALID',
      argv: ['validate', '--root', absent, '--quiet', '--no-color'],
      command: 'ia validate --root <directory>',
    },
    {
      code: 'IA-DB-ROOT-INVALID',
      argv: ['pack', '--descriptor', '.ia/work/descriptor.json', '--root', absent],
      command: 'ia pack --descriptor .ia/work/descriptor.json --root <directory>',
    },
    {
      code: 'IA-DB-ROOT-INVALID',
      argv: ['install', 'acme/app', '--catalog', 'c.json', '--apply', '--yes', '--root', absent],
      command: 'ia install acme/app --catalog c.json --root <directory>',
    },
    // `ia restore` has no preview, so its rerun is the apply, confirmed.
    {
      code: 'IA-DB-ROOT-INVALID',
      argv: ['restore', '--apply', '--yes', '--root', absent],
      command: 'ia restore --apply --yes --root <directory>',
    },
    {
      code: 'IA-DB-ROOT-INVALID',
      argv: ['host', 'claude', '--root', absent],
      command: 'ia host claude --root <directory>',
    },
    { code: 'IA-DB-ROOT-INVALID', argv: ['inspect'], cwd: empty, command: 'ia init' },
    {
      code: 'IA-DB-SOURCE-UNAVAILABLE',
      argv: ['inspect', 'no-such/definition/procedure/record', '--root', FIXTURE],
      command: `ia validate --root ${root}`,
    },
    // A workspace whose sources the db does not read names the repair, then the check that it opens; never `ia init`.
    { code: 'IA-DB-PATH-UNSAFE', argv: ['validate', '--root', linked], command: `ia validate --root ${unreadable}` },
    // An unreadable source is not an interrupted installation: no recovery is named, only the repair and the check.
    {
      code: 'IA-DB-SOURCE-UNAVAILABLE',
      argv: ['validate', '--root', undecodable],
      command: `ia validate --root ${quote(realpathSync(undecodable))}`,
    },
    { code: 'IA-DB-PATH-UNSAFE', argv: ['inspect', '--root', linked], command: `ia validate --root ${unreadable}` },
    { code: 'IA-DB-PATH-UNSAFE', argv: ['compile', '--root', linked], command: `ia validate --root ${unreadable}` },
    {
      code: 'IA-DB-PATH-UNSAFE',
      argv: ['host', 'claude', '--apply', '--yes', '--root', linked],
      command: `ia validate --root ${unreadable}`,
    },
    {
      code: 'IA-DIST-PATH-UNSAFE',
      argv: ['format', '../outside.ia', '--check', '--root', FIXTURE],
      command: `ia format <path> --check --root ${root}`,
    },
    {
      code: 'IA-DIST-HOST-UNSUPPORTED',
      argv: ['host', 'cursor', '--root', FIXTURE],
      command: `ia host claude --root ${root}`,
    },
    { code: 'IA-DIST-HOST-UNSUPPORTED', argv: ['host', 'codex', '--user'], command: 'ia host claude --user' },
    {
      code: 'IA-CLI-CONFLICT',
      argv: ['host', 'claude', '--root', bare],
      command: `ia init ${quote(realpathSync(bare))}`,
    },
    {
      code: 'IA-CLI-CONFLICT',
      argv: ['host', 'claude', '--root', refused],
      command: `ia validate --root ${quote(realpathSync(refused))}`,
    },
    // `update` with nothing installed names the install that comes first, its range and root included.
    {
      code: 'IA-DIST-INPUT-INVALID',
      argv: ['update', 'acme/app', '--to', '1.0.0', '--root', bare],
      command: `ia install acme/app@1.0.0 --root ${quote(bare)}`,
    },
    // A service refusal with no remedy of its own names `ia doctor` for the root the parser understood.
    {
      code: 'IA-DIST-INPUT-INVALID',
      argv: ['install', 'acme/app', '--root', FIXTURE, '--catalog', 'missing.json'],
      command: `ia doctor --root ${root}`,
    },
    {
      code: 'IA-DIST-INPUT-INVALID',
      argv: ['install', 'acme/app', `--root=${FIXTURE}`, '--catalog', 'missing.json'],
      command: `ia doctor --root ${root}`,
    },
    {
      code: 'IA-DIST-LOCAL-MODIFICATION',
      argv: ['compile', '--root', compiled],
      command: `ia compile --force --root ${quote(compiled)}`,
    },
  ];
}

it('prints one next command for every kind of consumer refusal, in --json and in human output', async () => {
  const rows = invocations();
  // The compile row refuses only once its artifact exists.
  const compiled = rows.find((row) => row.code === 'IA-DIST-LOCAL-MODIFICATION')!;
  expect((await run(compiled.argv)).exitCode).toBe(0);
  for (const row of rows) {
    const label = row.argv.join(' ');
    const machine = await run([...row.argv, '--json'], row.cwd === undefined ? {} : { cwd: row.cwd });
    expect(machine.exitCode, label).toBeGreaterThan(0);
    expect(machine.stderr, label).toBe('');
    const body = JSON.parse(machine.stdout) as { ok: boolean; code: string; next: string };
    expect(body, label).toMatchObject({ ok: false, code: row.code });
    expect(nextDefect(body.next), `${label}: ${body.next}`).toBeNull();
    expect(commandsIn(body.next), label).toEqual([row.command]);
    const human = await run(row.argv, row.cwd === undefined ? {} : { cwd: row.cwd });
    expect(human.exitCode, label).toBe(machine.exitCode);
    // The same next action on the `→` line, with its command whole on one line, so it is copied and run as printed.
    const shown = row.human ?? row.command;
    expect(flat(human.stderr).split('→ ')[1], label).toBe(flat(body.next).replace(row.command, shown));
    expect(
      human.stderr.split('\n').some((line) => line.includes(`"${shown}"`)),
      label,
    ).toBe(true);
  }
});

it('names commands that run as printed once their one placeholder is filled in', async () => {
  const outside = scratch('refusal-outside'),
    absent = resolve(outside, 'absent');
  // A bad root's rerun keeps the required descriptor, so the named command packs.
  const pack = JSON.parse(
    (await run(['pack', '--descriptor', '.ia/work/descriptor.json', '--root', absent, '--json'])).stdout,
  ) as { next: string };
  const packed = nextArgv(pack.next).map((token) => (token === '<directory>' ? packable() : token));
  expect((await run(packed)).exitCode, packed.join(' ')).toBe(0);
  // update's install carries the root, so from a cwd outside any workspace it plans against the one that refused.
  const bare = resolve(scratch('refusal-update'), 'workspace');
  mkdirSync(resolve(bare, '.ia/src'), { recursive: true });
  const update = JSON.parse((await run(['update', 'acme/app', '--root', bare, '--json'], { cwd: outside })).stdout) as {
    next: string;
  };
  const install = JSON.parse((await run([...nextArgv(update.next), '--json'], { cwd: outside })).stdout);
  expect(install.code).not.toBe('IA-DB-ROOT-INVALID');
  expect(install.exit).not.toBe(2);
  // A format rerun names the root it was given, here an absolute one, so it opens that workspace from a cwd outside it.
  const format = JSON.parse(
    (await run(['format', '../outside.ia', '--root', workspace(), '--json'], { cwd: outside })).stdout,
  ) as { next: string };
  const formatted = nextArgv(format.next).map((token) => (token === '<path>' ? FORMATTABLE : token));
  expect((await run(formatted, { cwd: outside })).exitCode, formatted.join(' ')).toBeLessThan(2);
  // An init target whose parent is missing names the init it refused, so once the parent exists that command plans
  // the workspace with the host and the id the invocation gave.
  const nested = resolve(outside, 'parent', 'demo');
  const init = JSON.parse(
    (await run(['init', nested, '--host', 'claude', '--id', 'acme/thing', '--json'], { cwd: outside })).stdout,
  ) as { next: string };
  mkdirSync(resolve(outside, 'parent'));
  const planned = JSON.parse((await run([...nextArgv(init.next), '--json'], { cwd: outside })).stdout) as {
    plan: { starter: { id: string }; host: { selected: string } };
  };
  expect(planned.plan).toMatchObject({ starter: { id: 'acme/thing' }, host: { selected: 'claude' } });
});

it('names the init target, which --root cannot carry, in the fallback for an init service refusal', async () => {
  const parent = scratch('refusal-init'),
    cwd = resolve(parent, 'elsewhere'),
    target = resolve(parent, 'target');
  mkdirSync(cwd);
  // A directory where the starter's system declaration belongs: the plan resumes it, and the apply refuses at admission.
  mkdirSync(resolve(target, '.ia/src/systems/target/system.ia'), { recursive: true });
  const refused = await run(['init', '../target', '--apply', '--yes', '--json'], { cwd });
  expect(refused.exitCode, refused.stdout).toBe(3);
  const body = JSON.parse(refused.stdout) as { next: string };
  const rooted = `ia doctor --root ${quote(realpathSync(target))}`;
  expect(commandsIn(body.next)).toEqual([rooted]);
  // Run from the same cwd, the named command reports the directory that refused and its failing records, not that cwd.
  const doctor = JSON.parse((await run([...nextArgv(body.next), '--json'], { cwd })).stdout) as {
    checks: readonly { id: string; status: string; detail: string }[];
  };
  expect(doctor.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'root', status: 'ok', detail: realpathSync(target) }),
      expect.objectContaining({ id: 'records', status: 'fail' }),
    ]),
  );
});

it('names the rerun when a consumer verb is interrupted, in the --json object and on the stderr line', async () => {
  const argv = ['validate', '--root', FIXTURE];
  const host = { ...makeHost(), signal: AbortSignal.abort() };
  const unexpected = () => {
    throw new Error('Unexpected machine route');
  };
  const rerun = ['ia', ...argv].map(quote).join(' ');
  const machine = await dispatch([...argv, '--json'], host, unexpected, []);
  expect(machine.exitCode).toBe(130);
  expect(JSON.parse(machine.stdout)).toEqual({
    version: 1,
    ok: false,
    code: 'IA-CLI-INTERRUPTED',
    message: 'Interrupted.',
    exit: 130,
    next: `Run "${rerun} --json" again.`,
  });
  expect(machine.stderr).toBe(`Interrupted. Run "${rerun} --json" again.\n`);
  const human = await dispatch(argv, host, unexpected, []);
  expect(human).toEqual({ exitCode: 130, stdout: '', stderr: `Interrupted. Run "${rerun}" again.\n` });
});
