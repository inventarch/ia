import { readFileSync, realpathSync } from 'node:fs';
import { RENAMED, PHASES, findWorkspace, readBindings, renamedMessage, scopeKey, selectBinding } from './bindings.js';
import type { SelectedBinding } from './bindings.js';
import { MethodError, objectAt } from './errors.js';
import { assertReadable, kitReadRoot } from './kit-root.js';
import type { KitRestore } from './kit-root.js';
import {
  assertPinnedKit,
  findKit,
  identityOf,
  implementationDigest,
  installedKit,
  kitBindings,
  kitChecks,
  kitDelivery,
  listKits,
  sourcesDigest,
} from './kits.js';
import type { Kit, KitSources } from './kits.js';
import { restoreRefusal, workspaceKits } from './installed-kits.js';
import type { LockedKit } from './installed-kits.js';
import { assemblePacket } from './packet.js';
import type { MethodPacket } from './packet.js';
import { kitUpdate, pinRootFor, readPin, writePin } from './pin.js';
import type { Pin } from './pin.js';
import { WorkspaceReader } from './reader.js';
import type { JsonRecord, PositionAnswer } from './reader.js';
import { closureStore, retainKit, retainedKit } from './retained.js';

/**
 * The method resolver: an entry point's activity to the packet an agent acts on, from the repository's bindings, the
 * task's pin and the bound kit's records, read in process. The order and the packet are the `ia` plugin's
 * `resolve.mjs`: bindings, the pin, the retained kit, its read root, the position at the scope key, the capability's
 * playbooks, checks and effects, the instructions, the packet, then the pin's next revision.
 */
export const RESOLVER = 'inventarch/resolve 0.1.0';
const VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export interface MethodRequest {
  readonly entry: string;
  readonly activity: string;
  readonly subject?: string;
  readonly seat?: string;
  readonly root?: string;
  readonly shape?: string;
  readonly phase?: string;
  readonly project?: string;
  readonly task?: string;
  readonly run?: string;
  readonly pin?: boolean;
  readonly noPin?: boolean;
  readonly rebind?: boolean;
  readonly host?: string;
  readonly kit?: string;
  readonly capability?: string;
  readonly profile?: string;
}
export interface MethodContext {
  /** Where kits are found: the bundled folder and the IA home's kit store. */
  readonly kits: KitSources;
  /** The native restore of a kit's language base into a read root. */
  readonly restore: KitRestore;
  readonly env?: NodeJS.ProcessEnv;
  /** The closure store; `closureStore(env)` by default. */
  readonly store?: string;
  /** The parent of the per-user read-root cache; `<IA home>/kit-roots-v1` (`kitCache(env)`) by default. */
  readonly cache?: string;
  readonly cwd?: string;
}

type Missing = Record<string, unknown> & { readonly kind: string };

function field(record: JsonRecord | null, section: string, key: string): string | (string | null)[] | null | undefined {
  const sections = (record?.['sections'] ?? []) as { name?: string; fields?: { key?: string; value?: JsonRecord }[] }[];
  const value = sections.find((s) => s.name === section)?.fields?.find((f) => f.key === key)?.value;
  const plain = (v: JsonRecord | undefined): string | null =>
    v?.['kind'] === 'ref' ? (v['name'] as string) : ((v?.['text'] as string | undefined) ?? null);
  if (!value) return undefined;
  return value['kind'] === 'list' ? ((value['items'] ?? []) as JsonRecord[]).map(plain) : plain(value);
}
const list = (value: ReturnType<typeof field>): string[] =>
  Array.isArray(value) ? (value as string[]) : value === undefined || value === null ? [] : [value];

function bound(workspaceRoot: string, entry: string, activity: string, kits: () => Kit[]): SelectedBinding {
  try {
    return selectBinding(readBindings(workspaceRoot), entry, activity);
  } catch (error) {
    if (!(error instanceof MethodError) || error.code !== 'IA-CORE-NO-METHOD') throw error;
    const key = `${entry}.${activity}`,
      wildcard = `${entry}.*`;
    let carried: Kit[] = [];
    try {
      carried = kits();
    } catch {
      carried = [];
    }
    const recommending = carried.flatMap((kit) => {
      let recommend: ReturnType<typeof kitBindings>['recommend'];
      try {
        ({ recommend } = kitBindings(kit));
      } catch {
        return [];
      }
      const hit = recommend[key] ?? recommend[wildcard];
      return hit ? [{ kit: kit.id, capability: hit.capability, key: recommend[key] ? key : wildcard }] : [];
    });
    if (recommending.length)
      throw new MethodError(
        `${error.message}. Carried kits recommend it: ${recommending.map((r) => `${r.kit} (${r.key} -> ${r.capability})`).join(', ')}; bind.mjs recommend <kit> shows a kit's keys and --apply writes the ones this repository does not bind yet`,
        error.code,
        { key, candidates: recommending },
      );
    throw error;
  }
}

function playbookCells(reader: WorkspaceReader, kitRoot: string, playbooks: readonly string[]): JsonRecord[] {
  const cells: JsonRecord[] = [];
  for (const playbook of playbooks) {
    const record = reader.record(playbook);
    if (!record)
      throw new MethodError(
        `required playbook ${playbook} is not admitted at ${kitRoot}`,
        'IA-CORE-COMPOSITION-MISSING',
      );
    const declared = (Array.isArray(record['cells']) ? record['cells'] : []) as { phase: string; primitive: string }[];
    if (!declared.length)
      throw new MethodError(`required playbook ${playbook} declares no cell`, 'IA-CORE-COMPOSITION-MISSING');
    for (const phase of PHASES)
      for (const cell of declared.filter((c) => c.phase === phase)) {
        const address = `${playbook}#${cell.phase}/${cell.primitive}`;
        const read = reader.read(address);
        if (!('body' in read))
          throw new MethodError(
            `required cell ${address} could not be read: ${read.message}`,
            'IA-CORE-COMPOSITION-MISSING',
          );
        cells.push({ playbook, address, text: read.body, digest: read.digest ?? null, source: 'playbook' });
      }
  }
  return cells;
}

const refusal = (answer: PositionAnswer): string =>
  `ia position refused: ${answer.message ?? 'no output'}${answer.next ? ` (next: ${answer.next})` : ''}`;

/** Resolves one method packet; a refusal throws a `MethodError` whose `methodRefusal` payload the plugin prints. */
export function resolveMethod(request: MethodRequest, context: MethodContext): MethodPacket {
  const started = Date.now();
  const env = context.env ?? process.env;
  const store = context.store ?? closureStore(env);
  if (!request.entry || !request.activity)
    throw new MethodError('resolve needs --entry <work|delivery|knowledge> and --activity <activity>', 'IA-CORE-USAGE');
  if (RENAMED[request.entry]) throw new MethodError(renamedMessage(request.entry), 'IA-CORE-USAGE');
  if (request.pin && request.noPin) throw new MethodError('--pin and --no-pin exclude each other', 'IA-CORE-USAGE');
  const missing: Missing[] = [];
  const note = (message: string, extra: Record<string, unknown> = {}): void => {
    missing.push({ kind: 'note', message, ...extra } as Missing);
  };

  const unbound = request.kit !== undefined || request.capability !== undefined || request.profile !== undefined;
  if (unbound && (!request.kit || !request.capability))
    throw new MethodError('--kit and --capability go together (--profile is optional)', 'IA-CORE-USAGE');
  const pinRoot = pinRootFor({ env, project: request.project, task: request.task, run: request.run });
  if (request.pin && !pinRoot)
    throw new MethodError('--pin needs a task folder: IA_CORE_RUN_ROOT, or --project and --task', 'IA-CORE-USAGE');
  const startRoot = request.root ?? realpathSync.native(context.cwd ?? process.cwd());
  const workspaceRoot = findWorkspace(startRoot);
  // A workspace's kits include those its lock's package entries install, read from its store; outside one, listKits.
  let listed: { readonly kits: Kit[]; readonly missing: readonly LockedKit[] } | undefined;
  const at = (): NonNullable<typeof listed> => (listed ??= workspaceKits(context.kits, workspaceRoot, env));
  const kits = (): Kit[] => (workspaceRoot === null ? listKits(context.kits) : at().kits);
  if (!workspaceRoot && !unbound)
    throw new MethodError(
      `${startRoot} is not inside an IA workspace (no .ia/src at or above it); a capability its kit resolves outside one (kit.mjs list: its unbound list, or any when the kit declares none) resolves with --kit <kit> --capability <capability>`,
      'IA-CORE-NO-WORKSPACE',
    );
  if (workspaceRoot && unbound)
    throw new MethodError(
      `${workspaceRoot} is an IA workspace, and its .ia/bindings.json chooses the method: bind the kit there (bind.mjs set ${request.entry}.${request.activity} ${request.kit} ${request.capability}, or bind.mjs recommend ${request.kit} --apply for the keys it recommends) instead of naming it with --kit`,
      'IA-CORE-UNBOUND-IN-WORKSPACE',
    );
  const activityKey = `${request.entry}.${request.activity}`;
  const binding: SelectedBinding & { readonly via: string } = unbound
    ? {
        kit: request.kit!,
        capability: request.capability!,
        ...(request.profile ? { profile: request.profile } : {}),
        key: activityKey,
        via: 'unbound',
      }
    : bound(workspaceRoot!, request.entry, request.activity, kits);
  if (unbound) {
    const declared = kitBindings(findKit(binding.kit, kits())).unbound;
    if (declared && !declared.includes(binding.capability))
      throw new MethodError(
        `${binding.kit} does not resolve ${binding.capability} outside an IA workspace; it declares ${declared.length ? declared.join(', ') : 'none'} (its bindings.json unbound list). Resolve it from an IA workspace that binds it`,
        'IA-CORE-UNBOUND-UNDECLARED',
      );
  }

  if (unbound && pinRoot) note('not pinned: an unbound resolve has no workspace to pin the task to', { kind: 'pin' });
  const pin: Pin | null = unbound ? null : readPin(pinRoot, workspaceRoot!);
  const legacyKey = request.entry === 'delivery' ? `development.${request.activity}` : null;
  const legacyPin = legacyKey !== null && Object.hasOwn(pin?.keys ?? {}, legacyKey);
  if (legacyPin && (!request.rebind || request.noPin))
    throw new MethodError(
      `the task pins ${legacyKey} (revision ${pin!.revision}); pass --rebind without --no-pin to replace it with ${activityKey} in a new revision`,
      'IA-CORE-REBIND-REQUIRED',
      { key: legacyKey },
    );

  const keyPin = pin?.keys?.[activityKey] ?? null;
  const savedKit = pin?.kits?.[binding.kit] ?? null;
  let carried: Kit | undefined;
  // A kit a package entry installs is read from the store: one the store lacks refuses, never read from another copy.
  const unrestored = workspaceRoot === null ? undefined : at().missing.find((row) => row.id === binding.kit);
  try {
    if (unrestored !== undefined) throw restoreRefusal(unrestored);
    carried = findKit(binding.kit, kits());
  } catch (error) {
    if (!savedKit?.retained || request.rebind) throw error;
  }
  const kit =
    savedKit?.retained && !request.rebind ? retainedKit(savedKit.retained, store) : retainKit(carried!, store);
  // `installed`: the repository vendored the kit as a locked release, so its laws are the repository's own position's.
  const installed = workspaceRoot ? installedKit(workspaceRoot, kit.id) : null;
  const available = carried
    ? { version: carried.latest?.version ?? carried.version ?? null, archive: carried.latest?.archive ?? null }
    : { version: kit.latest?.version, archive: kit.latest?.archive };
  const sources = sourcesDigest(kit.dir);
  const kitPin = pin?.kits?.[kit.id] ?? null;
  let effective: {
    kit: {
      id: string;
      version: string | null | undefined;
      archive: string | null;
      sources: string | null;
      implementation: string | null;
      retained: string | null;
    };
    capability: string;
  };
  let rebound = false,
    pinChange = !pin;
  if (keyPin && !request.rebind) {
    if (
      keyPin.kit !== kit.id ||
      keyPin.capability !== binding.capability ||
      (keyPin.profile ?? null) !== (binding.profile ?? null)
    )
      throw new MethodError(
        `the task pins ${activityKey} to ${keyPin.kit}#${keyPin.capability} (revision ${pin!.revision}), and the repository now binds it to ${kit.id}#${binding.capability}: pass --rebind to write a new revision, or keep the pin`,
        'IA-CORE-REBIND-REQUIRED',
        { key: activityKey },
      );
    effective = {
      kit: {
        id: kit.id,
        version: kitPin!.version,
        archive: kitPin!.archive ?? null,
        sources: kitPin!.sources ?? null,
        implementation: kitPin!.implementation ?? null,
        retained: kitPin!.retained ?? null,
      },
      capability: keyPin.capability,
    };
  } else if (kitPin && !request.rebind) {
    effective = {
      kit: {
        id: kit.id,
        version: kitPin.version,
        archive: kitPin.archive ?? null,
        sources: kitPin.sources ?? null,
        implementation: kitPin.implementation ?? null,
        retained: kitPin.retained ?? null,
      },
      capability: binding.capability,
    };
    pinChange = true;
  } else {
    effective = {
      kit: {
        id: kit.id,
        version: kit.latest?.version ?? kit.version,
        archive: kit.latest?.archive ?? null,
        sources,
        implementation: implementationDigest(kit),
        retained: kit.retained ?? null,
      },
      capability: binding.capability,
    };
    rebound = Boolean(pin && request.rebind);
    pinChange = true;
  }
  const update = kitPin && !request.rebind ? kitUpdate(kitPin, available) : null;
  if (update)
    note(
      `kit ${kit.id} ${update.available.version} is available; the task stays pinned to ${update.pinned.version} (pass --rebind to move)`,
      { kind: 'kit-update' },
    );
  if (effective.kit.version !== available.version)
    note(`the records readable now are kit ${kit.id} ${available.version}, not the pinned ${effective.kit.version}`, {
      kind: 'kit-version',
    });
  assertPinnedKit(kit, effective.kit);

  const readerInfo = { version: VERSION, source: 'in-process' };
  assertReadable(kit, readerInfo);
  const kitRoot = kitReadRoot(kit, context.restore, context.cache === undefined ? { env } : { base: context.cache });
  const key = scopeKey(request.entry, request.activity, { shape: request.shape, phase: request.phase });
  if (request.seat)
    note(
      `--seat ${request.seat} selects the consumer's position${installed ? ', whose laws and mandates the packet carries' : ' for scope only; the laws come from the kit'}; method instructions come from the isolated kit`,
      { kind: 'seat' },
    );
  const reader = new WorkspaceReader(kitRoot);
  const subject = workspaceRoot ? new WorkspaceReader(workspaceRoot) : null;
  try {
    const answer = reader.position({ shape: key.shape, phase: key.phase });
    if (!answer.ok || !answer.body) throw new MethodError(refusal(answer), 'IA-CORE-POSITION');
    const body = answer.body;
    const subjectPosition = subject
      ? subject.position({ shape: key.shape, phase: key.phase, seat: request.seat })
      : null;
    const subjectOk = Boolean(subjectPosition?.ok && subjectPosition.body);
    if (subjectPosition && !subjectOk && installed) throw new MethodError(refusal(subjectPosition), 'IA-CORE-POSITION');
    if (subjectPosition && !subjectOk)
      note(`the repository's own position is unavailable, so scope comes from the kit: ${refusal(subjectPosition)}`, {
        kind: 'position',
      });
    const subjectBody = subjectOk ? subjectPosition!.body! : body;
    const governance = installed ? subjectBody : body;

    const capabilityId = identityOf('capability', effective.capability)!;
    const cap = reader.record(capabilityId);
    if (!cap)
      throw new MethodError(
        `capability record ${capabilityId} is not admitted at ${kitRoot}`,
        'IA-CORE-CAPABILITY-UNAVAILABLE',
      );
    const playbooks = list(field(cap, 'composition', 'playbooks')).map((n) => identityOf('playbook', n)!);
    const checkNames = list(field(cap, 'composition', 'checks'));
    const effects = list(field(cap, 'execution', 'effects'));
    let profileId = binding.profile ? identityOf('agent-profile', binding.profile)! : null;
    if (!profileId) {
      const inbound = reader.inbound(capabilityId);
      if (!inbound)
        throw new MethodError(
          `profile composition of ${capabilityId} could not be inspected`,
          'IA-CORE-COMPOSITION-MISSING',
        );
      const profiles = [
        ...new Set(
          inbound
            .filter(
              (d) =>
                d['field'] === 'composition.capabilities' &&
                /\/agent-profile\//.test(String(d['declaredOn'] ?? d['identity'] ?? '')),
            )
            .map((d) => String(d['declaredOn'] ?? d['identity'])),
        ),
      ];
      if (profiles.length === 1) profileId = profiles[0]!;
      else if (profiles.length > 1)
        throw new MethodError(
          `${profiles.length} agent-profiles compose ${capabilityId}; name one in the binding: ${profiles.join(', ')}`,
          'IA-CORE-PROFILE-AMBIGUOUS',
        );
    }
    const profile = profileId ? reader.record(profileId) : null;
    if (profileId && !profile)
      throw new MethodError(
        `required agent-profile ${profileId} is not admitted at ${kitRoot}`,
        'IA-CORE-COMPOSITION-MISSING',
      );
    const mandateName = profile ? (field(profile, 'composition', 'mandate') as string | null | undefined) : null;
    const mandateId = mandateName ? identityOf('mandate', mandateName)! : null;
    const mandate = mandateId ? reader.record(mandateId) : null;
    if (mandateId && !mandate)
      throw new MethodError(
        `required mandate ${mandateId} of ${profileId} is not admitted at ${kitRoot}`,
        'IA-CORE-COMPOSITION-MISSING',
      );
    const briefParts = [profile && field(profile, 'meaning', 'says'), field(cap, 'meaning', 'says')].filter(Boolean);
    const role = { profile: profile ? profileId : null, brief: briefParts.length ? briefParts.join('\n\n') : null };
    if (!role.brief) note('no role brief: neither an agent-profile nor the capability states one', { kind: 'role' });

    const delivery = kitDelivery(kit);
    if (delivery.undeclared.length)
      note(
        `delivery.json names capabilities that are not @capability records of the kit: ${delivery.undeclared.join(', ')}`,
        { kind: 'delivery' },
      );
    const whole = delivery.whole.includes(effective.capability);
    let cells: JsonRecord[] = ((body['cells'] ?? []) as JsonRecord[]).map((c) => ({
      playbook: c['playbook'],
      address: c['address'],
      text: c['text'],
      source: 'position',
    }));
    if (playbooks.length) {
      const completeCells = playbookCells(reader, kitRoot, playbooks);
      const own = cells.filter((c) => playbooks.includes(c['playbook'] as string));
      cells = whole || !own.length ? completeCells : own;
      if (!cells.length)
        note(`no cell of the capability's playbooks (${playbooks.join(', ')}) could be read at ${kitRoot}`, {
          kind: 'instructions',
        });
    } else if (checkNames.length) cells = [];
    else
      throw new MethodError(
        'the capability declares neither playbooks nor checks; inspection-only execution is not supported by this packet contract',
        'IA-CORE-COMPOSITION-MISSING',
      );
    const ref = (r: JsonRecord, when: string): JsonRecord => ({
      identity: r['identity'],
      digest: r['digest'] ?? null,
      when,
    });
    const references = [
      ...((governance['rules'] ?? []) as JsonRecord[]).map((r) => ref(r, 'always')),
      ...((governance['mandates'] ?? []) as JsonRecord[]).map((r) => ref(r, 'seat')),
      ...(mandate ? [ref(mandate, 'role')] : []),
      ...((body['loaded'] ?? []) as JsonRecord[])
        .filter((r) => (r['hop'] as number) > 0)
        .slice(0, 32)
        .map((r) => ref(r, 'as-needed')),
    ];
    const { checks: runnerChecks, undeclared } = kitChecks(kit);
    if (undeclared.length)
      note(`checks.json names checks that are not @check records of the kit: ${undeclared.join(', ')}`, {
        kind: 'checks',
      });
    const evaluators: Record<string, string | null> = {};
    for (const name of checkNames) {
      const record = reader.record(identityOf('check', name)!);
      if (!record) throw new MethodError(`required check record ${name} is not admitted`, 'IA-CORE-CHECK-UNAVAILABLE');
      evaluators[name] = (field(record, 'check', 'runs') as string | null | undefined) ?? null;
    }
    const iaEvaluated = checkNames.filter(
      (name) => !Object.hasOwn(runnerChecks, name) && evaluators[name] && evaluators[name] !== 'COMP-CHECK',
    );
    for (const name of iaEvaluated)
      missing.push({
        kind: 'ia-evaluated',
        check: name,
        runs: evaluators[name],
        message: `required check ${name} runs ${evaluators[name]}: ia validate evaluates it, not scripts/check.mjs, so its evidence is the ia validate verdict`,
      });
    const hostRun = checkNames.filter((name) => !Object.hasOwn(runnerChecks, name) && !iaEvaluated.includes(name));
    if (hostRun.length && hostRun.length === checkNames.length - iaEvaluated.length)
      throw new MethodError(
        `required check${hostRun.length === 1 ? '' : 's'} ${hostRun.join(', ')} ha${hostRun.length === 1 ? 's' : 've'} no declared runner`,
        'IA-CORE-CHECK-UNAVAILABLE',
      );
    for (const name of hostRun)
      missing.push({
        kind: 'check-unavailable',
        check: name,
        message: `required check ${name} has no runner in the kit's checks.json: scripts/check.mjs cannot run it, so its evidence is host-run and stays unverified until the host reports it`,
      });
    const runner = [...new Set([...checkNames, ...Object.keys(runnerChecks)])].sort();
    if (checkNames.length && env['IA_CORE_HOST_ENFORCES_CHECKS'] !== '1')
      missing.push({
        kind: 'enforcement',
        requirement: 'constrained-checks',
        via: 'scripts/check.mjs',
        checks: [...checkNames].sort(),
        message: `the capability requires that checks run only as ${checkNames.join(', ')}; this host does not enforce it, so run them only through node scripts/check.mjs <check-name> (the checker agent is restricted to it)`,
      });
    const records = [
      ...new Set([
        capabilityId,
        ...playbooks,
        ...(profile ? [profileId!] : []),
        ...(mandate ? [mandateId!] : []),
        ...runner.map((n) => identityOf('check', n)!),
      ]),
    ];

    const bodyKey = objectAt(body['key']) ?? {};
    const seat = (objectAt(subjectBody['seat'])?.['identity'] as string | undefined) ?? null;
    const scope = {
      entry: request.entry,
      activity: request.activity,
      subject: request.subject ?? null,
      key: body['key'],
      seat,
      word: null,
      mapped: key.mapped,
      workspace: workspaceRoot ? { root: workspaceRoot, revision: subjectBody['revision'] } : null,
    };
    const packet = assemblePacket({
      resolver: RESOLVER,
      binding: null,
      closure: {
        kit: effective.kit.id,
        version: effective.kit.version,
        archive: effective.kit.archive,
        sources: effective.kit.sources,
        implementation: effective.kit.implementation,
        retained: effective.kit.retained,
        records,
      },
      scope,
      instructions: cells,
      references,
      role,
      requestedOperations: effects,
      runner,
      required: [...checkNames].sort(),
      missing,
      kitUpdateAvailable: update,
      envelope: {
        host: request.host ?? env['IA_CORE_HOST'] ?? (env['CLAUDE_PLUGIN_ROOT'] ? 'claude-code' : 'unknown'),
        cliVersion: readerInfo.version,
        cliSource: readerInfo.source,
        kitRoot,
        kitInstalled: Boolean(installed),
        run: request.run ?? null,
        latencyMs: 0,
      },
    });
    let written: Pin | null = pin ?? null;
    if (pinRoot && !unbound && !request.noPin && (pinChange || request.rebind)) {
      const retainedKeys: Record<string, unknown> = { ...(pin?.keys ?? {}) };
      if (legacyPin) delete retainedKeys[legacyKey!];
      written = writePin(
        pinRoot,
        {
          workspace: { root: workspaceRoot!, revision: subjectBody['revision'] as string },
          task: request.task ?? pin?.task ?? null,
          kits: {
            ...(pin?.kits ?? {}),
            [kit.id]: {
              version: effective.kit.version ?? null,
              archive: effective.kit.archive,
              sources: effective.kit.sources,
              implementation: effective.kit.implementation,
              retained: effective.kit.retained,
            },
          },
          keys: {
            ...(retainedKeys as Pin['keys']),
            [activityKey]: {
              kit: kit.id,
              capability: effective.capability,
              profile: binding.profile ?? null,
              records,
              scopeKey: { shape: bodyKey['shape'], phase: bodyKey['phase'], seat, word: null },
              intent: { entry: request.entry, activity: request.activity, subject: request.subject ?? null },
            },
          },
        },
        pin ?? undefined,
      );
    }
    packet.binding = {
      key: binding.key,
      via: binding.via,
      kit: binding.kit,
      capability: binding.capability,
      revision: written ? written.revision : null,
      supersedes: written ? (written.supersedes ?? null) : null,
      pin: written ? { root: pinRoot, path: written.path, key: activityKey } : null,
      run: request.run ?? null,
      rebound: rebound && Boolean(written),
    };
    packet.envelope['latencyMs'] = Date.now() - started;
    return packet;
  } finally {
    reader.close();
    subject?.close();
  }
}
