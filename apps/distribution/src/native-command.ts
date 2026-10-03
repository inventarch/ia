import { isAbsolute } from 'node:path';
import {
  canonicalDistributionJson as json,
  decodeDistributionLock,
  decodeDistributionRequests,
  DISTRIBUTION_ENGINE_VERSION,
  DISTRIBUTION_LIMITS,
  INSTALL_PATHS,
  readInstalledGeneration,
} from '@inventarch/db/distribution';
import type { DistributionLock } from '@inventarch/db/distribution';
import {
  readCachedArchiveSelection,
  cacheArchive,
  applyInstallation,
  collectInstallationGarbage,
  planInstallation,
  recoverInstallation,
} from './install.js';
import { resolveReleases } from './resolve.js';
import { verifyArchive } from './archive.js';
import { applyHost, planHost, recoverHost } from './host.js';
import { asWorkspaceHost } from './hosts.js';
import { recoverGuardRegistration } from './guard-registration.js';
import {
  applyLifecycleRegistration,
  planLifecycleRegistration,
  recoverLifecycleRegistration,
} from './lifecycle-registration.js';
import type { LifecycleRegistrationRequest } from './lifecycle-registration.js';
import {
  packToDirectory,
  planRestore,
  pruneLockRequest,
  readInstalledState,
  readWorkspaceFile,
  readWorkspaceJson,
  readWorkspaceLock,
  resolveCatalog,
  writeWorkOutput,
} from './services.js';
import { bytes, fail, utf8, workspace } from './files.js';
import { registryAdd, registryWithdraw } from './registry-build.js';
import { refreshUpdates, UPDATE_CHANNELS } from './updates.js';
import type { UpdateChannel } from './updates.js';

export const NATIVE_HELP = `Native distribution commands:
  pack --source-root <absolute directory> --descriptor <file> --out <absolute directory>
  inspect --root <workspace> --archive <file>
  cache --root <workspace> --archive <file>
  list | doctor --root <workspace>
  plan install --root <workspace> --catalog <file> --requests <file> [--out <draft>]
  plan update --root <workspace> --catalog <file> --id <provider/name> --to <range> [--out <draft>]
  plan remove --root <workspace> --id <provider/name> [--out <draft>]
  plan rollback --root <workspace> --generation <digest> [--out <draft>]
  plan host --root <workspace> --host claude|codex --cache <absolute cache> [--out <draft>]
  plan host-remove --root <workspace> --host claude|codex --id <plugin> [--out <draft>]
  plan lifecycle --root <workspace> --cache <absolute cache> --binding <file> [--out <draft>]
  plan lifecycle-remove --root <workspace> --id <plugin> [--out <draft>]
  apply --root <workspace> --plan <file>
  restore --root <workspace> --offline | --catalog <file> [--allow-withdrawn]
  recover --root <workspace>
  recover-host --root <workspace>
  recover-lifecycle --root <workspace>
  recover-guard --root <workspace>
  gc --root <workspace> [--apply]
  registry add --registry <absolute directory> --archive <absolute file> [--name <text>] [--selection-root <absolute workspace>]
  registry withdraw --registry <absolute directory> --id <provider/name> --version <semver>
  refresh-updates --home <absolute IA home> --channel checkout|npm|unknown --current <version> [--name <package>] [--checkout <absolute directory>]
Catalog entries are {path,withdrawn} or {url,digest,withdrawn}; immutable HTTPS
locations end in /<sha256>.ia.tgz. Workspace paths stay inside the explicit root;
registry commands take absolute paths. refresh-updates writes only the IA home's
update cache; it never fetches git, and asks npm only for the npm channel.
Plans are reviewable data; apply rechecks all inputs and writes only install state.
Host activation and public publication are separate operations.
`;
const commands = new Set([
  'pack',
  'inspect',
  'cache',
  'list',
  'doctor',
  'plan',
  'apply',
  'restore',
  'recover',
  'recover-host',
  'recover-lifecycle',
  'recover-guard',
  'gc',
  'registry',
  'refresh-updates',
]);
function parse(argv: readonly string[]): { command: string; flags: Map<string, string> } {
  let command = argv[0]!,
    at = 1;
  if (command === 'plan' || command === 'registry') {
    command += ` ${argv[1] ?? ''}`;
    at++;
  }
  const shape: Record<string, readonly string[]> = {
    pack: ['source-root', 'descriptor', 'out'],
    inspect: ['root', 'archive'],
    cache: ['root', 'archive'],
    list: ['root'],
    doctor: ['root'],
    'plan install': ['root', 'catalog', 'requests', 'out', 'offline'],
    'plan update': ['root', 'catalog', 'id', 'to', 'out', 'offline'],
    'plan remove': ['root', 'id', 'out'],
    'plan rollback': ['root', 'generation', 'out'],
    apply: ['root', 'plan'],
    restore: ['root', 'offline', 'catalog', 'allow-withdrawn'],
    recover: ['root'],
    gc: ['root', 'apply'],
  };
  shape['plan host'] = ['root', 'host', 'cache', 'out'];
  shape['plan host-remove'] = ['root', 'host', 'id', 'out'];
  shape['recover-host'] = ['root'];
  shape['plan lifecycle'] = ['root', 'cache', 'binding', 'out'];
  shape['plan lifecycle-remove'] = ['root', 'id', 'out'];
  shape['recover-lifecycle'] = ['root'];
  shape['recover-guard'] = ['root'];
  shape['registry add'] = ['registry', 'archive', 'name', 'selection-root'];
  shape['registry withdraw'] = ['registry', 'id', 'version'];
  shape['refresh-updates'] = ['home', 'channel', 'current', 'name', 'checkout'];
  if (!Object.hasOwn(shape, command)) fail('INPUT-INVALID', 'Unknown native command');
  const flags = new Map<string, string>();
  for (; at < argv.length; at++) {
    const flag = argv[at]!,
      name = flag.slice(2);
    if (!flag.startsWith('--') || !shape[command]!.includes(name) || flags.has(name))
      fail('INPUT-INVALID', 'Unknown/duplicate native argument');
    const value = ['offline', 'allow-withdrawn', 'apply'].includes(name) ? 'true' : argv[++at];
    if (value === undefined || value.startsWith('--')) fail('INPUT-INVALID', `Missing ${flag}`);
    flags.set(name, value);
  }
  return { command, flags };
}
export async function runNative(argv: readonly string[]): Promise<{ result: unknown; exitCode: number } | undefined> {
  if (!commands.has(argv[0] ?? '')) return undefined;
  const { command, flags } = parse(argv),
    need = (name: string): string => {
      const value = flags.get(name);
      if (!value) fail('INPUT-INVALID', `Missing --${name}`);
      return value;
    };
  // Registry commands write a registry directory, not a workspace: `--registry` replaces `--root`.
  if (command === 'registry add') {
    let selection;
    if (flags.has('selection-root')) {
      const source = need('selection-root');
      if (!isAbsolute(source)) fail('INPUT-INVALID', '--selection-root must be absolute');
      const lock = readWorkspaceLock({ root: workspace(source) });
      selection = { lock, archives: readCachedArchiveSelection(source, lock) };
    }
    return {
      result: registryAdd({
        dir: need('registry'),
        archive: need('archive'),
        name: flags.get('name'),
        ...(selection ? { selection } : {}),
      }),
      exitCode: 0,
    };
  }
  if (command === 'registry withdraw')
    return {
      result: registryWithdraw({ dir: need('registry'), id: need('id'), version: need('version') }),
      exitCode: 0,
    };
  // Host plugin distribution spec §11.1 and Amendment item 4: no workspace; `ia doctor --host` names this argv and the session hook starts it detached.
  if (command === 'refresh-updates') {
    const home = need('home'),
      channel = need('channel'),
      checkout = flags.get('checkout') ?? null;
    if (!isAbsolute(home)) fail('INPUT-INVALID', '--home must be absolute');
    if (!(UPDATE_CHANNELS as readonly string[]).includes(channel))
      fail('INPUT-INVALID', `--channel must be one of ${UPDATE_CHANNELS.join(', ')}`);
    if (checkout !== null && !isAbsolute(checkout)) fail('INPUT-INVALID', '--checkout must be absolute');
    return {
      result: refreshUpdates({
        home,
        channel: channel as UpdateChannel,
        current: need('current'),
        name: flags.get('name') ?? null,
        checkout,
        now: new Date(),
      }),
      exitCode: 0,
    };
  }
  const root = workspace(need(command === 'pack' ? 'source-root' : 'root'));
  const read = (path: string, limit: number = DISTRIBUTION_LIMITS.metadata): Buffer =>
    readWorkspaceFile({ root, path, limit });
  const decode = (path: string): unknown => readWorkspaceJson({ root, path });
  const save = (plan: unknown): void => {
    if (flags.has('out')) writeWorkOutput({ root, path: need('out'), content: () => Buffer.from(json(plan)) });
  };
  let result: unknown;
  if (command === 'pack')
    result = packToDirectory({ sourceRoot: root, descriptorPath: need('descriptor'), outputRoot: () => need('out') });
  else if (command === 'inspect' || command === 'cache') {
    const content = read(need('archive'), DISTRIBUTION_LIMITS.compressed),
      release = command === 'cache' ? cacheArchive(root, content) : verifyArchive(content);
    result = {
      status: command === 'cache' ? 'cached' : 'verified',
      archive: release.archiveDigest,
      manifestDigest: release.manifestDigest,
      manifest: release.manifest,
    };
  } else if (command === 'list' || command === 'doctor') {
    const state = readInstalledState({ root });
    result =
      state.status === 'installed'
        ? { status: 'installed', pointer: state.pointer, lock: state.lock, inputs: state.inputs, host: 'pending' }
        : { status: 'uninstalled' };
  } else if (command === 'recover') result = recoverInstallation(root);
  else if (command === 'recover-host') result = recoverHost(root);
  else if (command === 'recover-lifecycle') result = recoverLifecycleRegistration(root);
  else if (command === 'recover-guard') result = recoverGuardRegistration(root);
  else if (command === 'gc') result = collectInstallationGarbage(root, flags.has('apply'));
  else if (command === 'apply') {
    const plan = decode(need('plan'));
    if (!plan || typeof plan !== 'object' || !('root' in plan) || plan.root !== root)
      fail('INPUT-INVALID', 'Saved plan must match the explicit root');
    result =
      'format' in plan && plan.format === 'ia.host-plan.v1'
        ? applyHost(plan)
        : 'format' in plan && plan.format === 'ia.lifecycle-registration-plan.v1'
          ? applyLifecycleRegistration(plan)
          : applyInstallation(plan);
  } else if (command === 'plan lifecycle' || command === 'plan lifecycle-remove') {
    const request: LifecycleRegistrationRequest =
      command === 'plan lifecycle-remove'
        ? { remove: need('id') }
        : {
            cache: need('cache'),
            binding: decode(need('binding')) as Extract<LifecycleRegistrationRequest, { cache: string }>['binding'],
          };
    const plan = planLifecycleRegistration(root, request);
    save(plan);
    result = plan;
  } else if (command === 'plan host' || command === 'plan host-remove') {
    const host = asWorkspaceHost(need('host'));
    const plan = planHost(
      root,
      host,
      command === 'plan host' ? need('cache') : null,
      command === 'plan host-remove' ? need('id') : undefined,
    );
    save(plan);
    result = plan;
  } else if (command === 'restore') {
    const lock = readWorkspaceLock({ root }),
      offline = flags.has('offline');
    const planned = await planRestore({
      root,
      lock,
      offline,
      allowWithdrawn: flags.has('allow-withdrawn'),
      withdrawnRefusalPrefix: 'Explicit --allow-withdrawn is required for',
      ...(offline ? {} : { catalog: decode(need('catalog')) }),
    });
    result = { ...applyInstallation(planned.plan), withdrawn: planned.withdrawn };
  } else {
    let lock: DistributionLock;
    if (command === 'plan install' || command === 'plan update') {
      const previousBytes = bytes(root, INSTALL_PATHS.lock, DISTRIBUTION_LIMITS.metadata),
        previous = previousBytes ? decodeDistributionLock(utf8(previousBytes)) : undefined;
      let requests =
        command === 'plan install' ? decodeDistributionRequests(decode(need('requests'))) : previous?.requests;
      if (!requests) fail('INPUT-INVALID', 'Update requires an existing installation');
      if (command === 'plan update') {
        const id = need('id');
        if (!requests.some((r) => r.id === id)) fail('INPUT-INVALID', 'Update requires a direct request');
        requests = requests.map((r) => (r.id === id ? { id, range: need('to') } : r));
      }
      const choices = await resolveCatalog({ root, entries: decode(need('catalog')), offline: flags.has('offline') });
      const preference =
        previous && command === 'plan update'
          ? { ...previous, packages: previous.packages.filter((p) => p.id !== need('id')) }
          : previous;
      lock = resolveReleases(requests, choices, DISTRIBUTION_ENGINE_VERSION, preference).lock;
    } else if (command === 'plan remove')
      lock = pruneLockRequest({ lock: readWorkspaceLock({ root }), id: need('id') });
    else {
      const generation = need('generation');
      if (!/^[a-f0-9]{64}$/.test(generation)) fail('INPUT-INVALID', 'Invalid retained generation');
      lock = decodeDistributionLock(decode(`${INSTALL_PATHS.generations}/${generation}/lock.json`));
      const retained = readInstalledGeneration(root, { formatVersion: 1, generation, previous: null, counter: 1 });
      if (!retained) fail('INPUT-INVALID', 'Retained generation is unavailable');
    }
    const plan = planInstallation(root, lock, command.slice(5) as 'install' | 'update' | 'remove' | 'rollback');
    save(plan);
    result = plan;
  }
  return { result, exitCode: 0 };
}
