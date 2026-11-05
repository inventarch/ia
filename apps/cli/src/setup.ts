/** Guided `ia init`: compose the existing initializer, package installer and portable host bootstrap. */
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { planBootstrap } from '@inventarch/distribution/bootstrap';
import { applyInstallation, cacheArchive, cachePath, planInstallation } from '@inventarch/distribution/install';
import { createFile, readWorkspaceFile, readWorkspaceLock, replace } from '@inventarch/distribution/services';
import {
  installedPackageKits,
  kitBindings,
  MethodError,
  readBindings,
  selectBinding,
  resolveMethod,
  iaHome,
} from '@inventarch/runtime/method';
import type { Binding, Kit } from '@inventarch/runtime/method';
import { UsageError } from './args.js';
import { confirm, dispatch, Refusal } from './consumer.js';
import type { Context, Result } from './consumer.js';
import { sessionGate } from './profile.js';
import { openSession } from './session.js';
import { terminalText } from './render.js';
import { hasWorkspaceSource, requireAdmitted } from './workspace-state.js';

export const DEFAULT_METHODS_PACKAGE = '@inventarch/public-kits';
const DEFAULT_METHODS_SELECTOR = `${DEFAULT_METHODS_PACKAGE}@1.0.2`;
const DEFAULT_KITS = ['inventarch/ia-method-kit', 'inventarch/ia-kb-kit', 'inventarch/ia-authoring-kit'];
const BINDINGS = '.ia/bindings.json';
const LABELS = { codex: 'Codex', claude: 'Claude Code', none: 'CLI only' } as const;
type Agent = keyof typeof LABELS;
const safeText = (text: string): string => text.split('\n').map(terminalText).join('\n');

/** Explicit flags keep the existing plan/apply contract. Only a plain interactive invocation opens the guide. */
export function wantsSetup({ args, host, json }: Context): boolean {
  return (
    args.flag('setup') ||
    (host.interaction.interactive &&
      !json &&
      !host.env['CI'] &&
      !['apply', 'yes', 'system', 'migrate', 'forget-decline'].some((name) => args.flag(name)) &&
      !['host', 'from', 'adopt', 'registry', 'decline'].some((name) => args.value(name) !== undefined))
  );
}

async function chooseAgent(context: Context): Promise<Agent | null> {
  const supplied = context.args.value('host') as Agent | undefined;
  if (supplied !== undefined) return supplied;
  if (context.json || !context.host.interaction.interactive || context.args.flag('yes') || context.host.env['CI'])
    throw new UsageError(
      'Agent setup requires --host codex, --host claude or --host none without an interactive choice',
    );
  const { interaction, signal } = context.host;
  interaction.write(
    'Which agent will you use in this repository?\n  1. Codex\n  2. Claude Code\n  3. CLI only (no agent setup)\n',
  );
  for (;;) {
    signal?.throwIfAborted();
    interaction.write('Choose 1, 2 or 3 (Enter cancels): ');
    const answer = (await interaction.read())?.trim().toLowerCase();
    signal?.throwIfAborted();
    if (!answer) return null;
    const choices: Readonly<Record<string, Agent>> = {
      '1': 'codex',
      codex: 'codex',
      '2': 'claude',
      claude: 'claude',
      '3': 'none',
      none: 'none',
    };
    const agent = choices[answer];
    if (agent) return agent;
    interaction.write('Choose Codex, Claude Code or CLI only.\n');
  }
}

const bindingBytes = (root: string): Buffer | null => {
  if (lstatSync(join(root, BINDINGS), { throwIfNoEntry: false }) === undefined) return null;
  return readWorkspaceFile({ root, path: BINDINGS });
};

/** Keep every effective user choice, including wildcards and defaults. Fill only unbound activities. */
export function recommendedBindings(
  root: string,
  kits: readonly Kit[],
): { before: Buffer | null; after: Buffer; added: string[] } {
  const before = bindingBytes(root);
  const current = readBindings(root);
  const document = before === null ? { format: 1, bindings: {} } : JSON.parse(before.toString('utf8'));
  const recommendations = new Map<string, Binding>();
  for (const id of DEFAULT_KITS) {
    const kit = kits.find((candidate) => candidate.id === id);
    if (!kit) throw new Error(`The public workflows package is missing ${id}`);
    const { recommend, undeclared } = kitBindings(kit);
    if (undeclared.length) throw new Error(`${id} recommends undeclared methods: ${undeclared.join(', ')}`);
    for (const [key, binding] of Object.entries(recommend)) {
      const previous = recommendations.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(binding))
        throw new Error(`The public workflows disagree on ${key}`);
      recommendations.set(key, binding);
    }
  }
  const added: string[] = [];
  for (const [key, binding] of recommendations) {
    const [lane, activity] = key.split('.');
    try {
      selectBinding(current, lane!, activity!);
    } catch (error) {
      if (!(error instanceof MethodError) || error.code !== 'IA-CORE-NO-METHOD') throw error;
      document.bindings[key] = binding;
      added.push(key);
    }
  }
  // Each lane must be usable; a package with no recommendations is not a complete installation.
  const candidate = {
    format: 1 as const,
    path: BINDINGS,
    bindings: Object.fromEntries(
      Object.entries(document.bindings).map(([key, value]) => [key, Array.isArray(value) ? value : [value as Binding]]),
    ),
    defaults: current?.defaults ?? {},
    precedence: current?.precedence ?? [],
  };
  for (const [lane, activity] of [
    ['work', 'task'],
    ['knowledge', 'explain'],
    ['delivery', 'change'],
  ])
    selectBinding(candidate, lane!, activity!);
  return {
    before,
    after: added.length || before === null ? Buffer.from(JSON.stringify(document, null, 2) + '\n') : before,
    added,
  };
}

/** Inner commands use the normal dispatcher, including its admission and mandate checks, but never prompt twice. */
interface CommandBody {
  readonly code?: string;
  readonly message?: string;
  readonly where?: { path?: string; line?: number; identity?: string };
  readonly next?: string;
  readonly plan?: { state: string; conflicts: unknown };
}
async function command(context: Context, argv: string[]): Promise<CommandBody> {
  const { onConsumerRoute: _route, ...nestedHost } = context.host;
  const result = await dispatch(
    [...argv, '--json'],
    {
      ...nestedHost,
      interaction: { interactive: false, write: () => {}, read: async () => null },
    },
    () => {
      throw new Error('Setup invoked a non-consumer command');
    },
    context.extensions ?? [],
  );
  const body = JSON.parse(result.stdout) as CommandBody;
  if (result.exitCode !== 0)
    throw new Refusal(
      body.code ?? 'IA-CLI-SETUP-FAILED',
      body.message ?? 'Setup verification failed',
      result.exitCode,
      body.where ?? null,
      body.next ?? 'Run "ia doctor".',
    );
  return body;
}

export async function runSetup(context: Context, root: string): Promise<Result> {
  const { args, host, json } = context;
  const agent = await chooseAgent(context);
  const output = (body: Record<string, unknown>, text: string): Result => ({
    exitCode: 0,
    stdout: json
      ? JSON.stringify({ version: 1, command: 'init', mode: 'setup', root, ...body }) + '\n'
      : safeText(text),
    stderr: '',
  });
  if (agent === null) return output({ applied: false, cancelled: true }, 'Setup cancelled. Nothing was written.\n');
  const resume = `ia init --setup --host ${agent}${args.value('id') ? ` --id ${args.value('id')}` : ''} --apply --yes`;
  const init = ['init', root, '--host', 'none'];
  if (args.value('id')) init.push('--id', args.value('id')!);
  const initial = await command(context, init);
  const state = initial.plan!.state;
  let initialized = false;
  if (hasWorkspaceSource(root)) {
    try {
      const session = openSession(root);
      try {
        requireAdmitted(session, root);
        initialized = session.reader
          .records()
          .some(
            (record) =>
              record.discriminator === 'workspace' &&
              record.source.path.startsWith('.ia/src/') &&
              !record.source.path.startsWith('.ia/src/floor/'),
          );
      } finally {
        session.close();
      }
    } catch (error) {
      // An interrupted initializer may already have written some sources. Its own plan decides whether it can resume.
      if (state !== 'fresh' && state !== 'resumable') throw error;
    }
  }
  if (!initialized && state !== 'fresh' && state !== 'resumable')
    throw new Refusal(
      'IA-CLI-CONFLICT',
      `Initialization conflicts: ${JSON.stringify(initial.plan!.conflicts)}`,
      3,
      { path: root },
      'Run "ia init --host none" from the target directory to inspect the conflicts.',
    );
  // Inspect the destination before installing anything. The portable bootstrap appends to existing instruction files.
  const discovery = agent === 'none' || !existsSync(root) ? undefined : planBootstrap(root, agent, host.version);
  if (initialized) {
    bindingBytes(root);
    readBindings(root);
  }
  const steps =
    agent === 'none'
      ? ['Initialize the workspace']
      : [
          initialized ? 'Use the existing workspace' : 'Initialize the workspace',
          'Download and install the public workflows from npm',
          'Configure work, knowledge and delivery methods, preserving existing choices',
          `Add ${LABELS[agent]} instructions and MCP discovery, preserving other configuration`,
          'Validate the workspace',
        ];
  const summary =
    `Set up IA for ${LABELS[agent]} in ${root}\n${steps.map((step) => `  - ${step}`).join('\n')}\n` +
    (agent === 'none'
      ? ''
      : 'No separate plugin install is needed. The agent may ask you to trust this repository and enable its MCP server.\n');
  const plan = { host: agent, steps, files: discovery?.files.map(({ path, action }) => ({ path, action })) ?? [] };
  // --setup is a reproducible plan/apply route; bare interactive init offers to apply in this invocation.
  if (args.flag('setup') && !args.flag('apply'))
    return output(
      { applied: false, plan },
      summary +
        `${existsSync(root) ? 'From' : 'Create and enter'} the target directory${existsSync(root) ? ', apply with' : ', then run'}: ${resume}\n`,
    );
  if (!args.flag('yes') && !(await confirm(host.interaction, safeText(summary), 'Set up this repository? [y/N] ')))
    return output({ applied: false, cancelled: true, plan }, 'Setup cancelled. Nothing was written.\n');
  const completed: string[] = [];
  let step = 'workspace';
  const progress = (message: string): void => {
    if (!json && !args.flag('quiet')) host.interaction.write(`${message}\n`);
  };
  try {
    if (!initialized) {
      progress('Initializing the workspace…');
      await command(context, [...init, '--apply', '--yes']);
    }
    completed.push('workspace');
    if (agent !== 'none') {
      step = 'workflows';
      progress('Installing the public workflows…');
      // A retry restores the recorded package, rather than silently selecting a newer release.
      const locked = readWorkspaceLock({ root }).entries?.find((entry) => entry.name === DEFAULT_METHODS_PACKAGE);
      await command(
        context,
        locked
          ? ['restore', '--root', root, '--offline', '--apply', '--yes']
          : ['install', '--root', root, '--package', DEFAULT_METHODS_SELECTOR, '--apply', '--yes'],
      );
      completed.push(step);
      step = 'methods';
      const session = openSession(root);
      try {
        sessionGate(context, 'effect')(session);
      } finally {
        session.close();
      }
      const env = { ...host.env, IA_HOME: host.env['IA_HOME'] ?? host.env['IA_HOST_HOME'] };
      const installed = installedPackageKits(root, env);
      if (installed.missing.length) throw new Error('Some public workflows are missing from the installed store');
      const bindings = recommendedBindings(root, installed.kits);
      const fresh = bindingBytes(root);
      if (fresh?.toString('hex') !== bindings.before?.toString('hex'))
        throw new Error('Method bindings changed during setup; retry');
      if (bindings.before === null) createFile(root, BINDINGS, bindings.after, 0o644);
      else if (!bindings.before.equals(bindings.after)) replace(root, BINDINGS, bindings.after, 0o644);
      // Resolve the same representative activities the agent will request, from the installed packages alone.
      // This catches unavailable custom choices without replacing them or claiming setup is complete.
      for (const [entry, activity] of [
        ['work', 'task'],
        ['knowledge', 'explain'],
        ['delivery', 'change'],
      ]) {
        host.signal?.throwIfAborted();
        const packet = resolveMethod(
          { root, entry: entry!, activity: activity!, host: agent },
          {
            kits: { home: join(iaHome(env), 'kits') },
            env,
            cwd: root,
            restore: (kitRoot) => {
              const lock = readWorkspaceLock({ root: kitRoot });
              for (const dependency of lock.packages)
                cacheArchive(
                  kitRoot,
                  readWorkspaceFile({ root, path: cachePath(dependency.archive), limit: 64 * 1024 * 1024 }),
                  dependency.archive,
                );
              applyInstallation(planInstallation(kitRoot, lock, 'restore'));
            },
          },
        );
        if (packet.instructions.length === 0) throw new Error(`The selected ${entry} method supplies no instructions`);
      }
      completed.push(step);
      step = 'discovery';
      progress(`Configuring ${LABELS[agent]} discovery…`);
      await command(context, ['host', agent, '--commit', '--root', root, '--apply', '--yes']);
      completed.push(step);
    }
    step = 'validation';
    await command(context, ['validate', '--root', root]);
    completed.push(step);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Refusal(
      error instanceof Refusal ? error.code : 'IA-CLI-SETUP-FAILED',
      `Setup stopped at ${step}. Completed: ${completed.join(', ') || 'none'}. ${cause}`,
      error instanceof Refusal ? error.exit : 3,
      { path: root },
      `Fix the reported problem, then from the target directory run "${resume}" to resume.`,
      null,
      undefined,
      { completed, step, causeNext: error instanceof Refusal ? error.next : null },
    );
  }
  return output(
    { applied: true, host: agent, completed, hostLoaded: false },
    `IA setup is complete for ${LABELS[agent]}.\n` +
      (agent === 'none'
        ? 'Read the workspace with ia position.\n'
        : `Open or restart ${LABELS[agent]} in this repository and enable its ia MCP server when prompted.\nThe workspace, public workflows and method bindings are configured; no separate plugin install is needed.\n`),
  );
}
