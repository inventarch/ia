import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MethodError } from './errors.js';
import type { Kit, KitOrigin } from './kits.js';
import { RESTORE_NEEDED, STORE } from './installed-kits.js';
import type { LockedKit } from './installed-kits.js';
import { samePath } from './registry.js';

/**
 * A public session: one id, a line per event in `<IA home>/sessions-v1/<id>.jsonl`, and the briefing a host shows at
 * the start (at most `BRIEFING_LIMIT` characters): the workspace, the kits, the three lanes and the task pin last
 * written for this workspace. A claim is advisory: recorded, never fenced. Fenced claims, judging and sealing are
 * private governance's.
 */
export const BRIEFING_LIMIT = 2500;
export const SESSION_DIRECTORY = 'sessions-v1';
/** The three lanes, in the order a briefing names them. */
export const LANES = ['work', 'knowledge', 'delivery'] as const;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionKit {
  readonly kit: string;
  readonly version: string | null;
  readonly source: KitOrigin;
}
export interface SessionPin {
  readonly task: string;
  readonly key: string;
  readonly revision: number;
}
/** The kits the workspace lock installs that its store lacks, so the workspace needs `ia restore` (contract C7b). */
export interface SessionRestore {
  readonly kits: readonly string[];
  readonly message: string;
}
export interface SessionClaim {
  readonly path: string;
  readonly mode: 'read' | 'write';
}
export interface Session {
  readonly sessionId: string;
  readonly root: string;
  readonly workspace: string | null;
  readonly kits: readonly SessionKit[];
  readonly lanes: readonly string[];
  readonly pin?: SessionPin;
  /** Present only when the workspace lock installs kits its store lacks. */
  readonly restore?: SessionRestore;
  readonly briefing: string;
}

/** The restore notice for kits the lock installs that the store lacks, or none. */
export const sessionRestore = (missing: readonly LockedKit[]): SessionRestore | undefined =>
  missing.length === 0
    ? undefined
    : {
        kits: missing.map((kit) => `${kit.id}@${kit.version}`),
        message: `The lock installs ${missing.map((kit) => `${kit.id}@${kit.version} (from ${kit.package})`).join(', ')}, which ${STORE} does not hold: ${RESTORE_NEEDED} in this workspace to install them.`,
      };
export const sessionKits = (kits: readonly Kit[]): SessionKit[] =>
  kits.map((kit) => ({ kit: kit.id, version: kit.latest?.version ?? kit.version ?? null, source: kit.origin }));

/** The task pin most recently written for the workspace at root, under `<IA home>/work-v1/<project>/<task>/`. */
export function currentPin(home: string, root: string): SessionPin | undefined {
  const work = join(home, 'work-v1');
  if (!existsSync(work)) return undefined;
  let found: { pin: SessionPin; at: number } | undefined;
  for (const project of readdirSync(work)) {
    const projectDir = join(work, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const task of readdirSync(projectDir)) {
      const path = join(projectDir, task, 'binding.json');
      if (!existsSync(path)) continue;
      let pin: { workspace?: { root?: string }; revision?: number; keys?: Record<string, unknown> };
      try {
        pin = JSON.parse(readFileSync(path, 'utf8')) as typeof pin;
      } catch {
        continue;
      }
      const keys = Object.keys(pin.keys ?? {});
      if (!pin.workspace?.root || !samePath(pin.workspace.root, root) || keys.length === 0) continue;
      const at = statSync(path).mtimeMs;
      if (found === undefined || at > found.at)
        found = { pin: { task: `${project}/${task}`, key: keys.at(-1)!, revision: pin.revision ?? 0 }, at };
    }
  }
  return found?.pin;
}

/** The briefing: who, what is carried, how to ask, and where the task stands, cut to `BRIEFING_LIMIT`. */
export function briefing(session: Omit<Session, 'briefing' | 'sessionId'>): string {
  const lines = [
    `IA workspace ${session.workspace ?? '(no @workspace)'} at ${session.root}.`,
    `Kits: ${session.kits.length ? session.kits.map((kit) => `${kit.kit}@${kit.version ?? '?'} (${kit.source})`).join(', ') : 'none found'}.`,
    // Kits the lock installs but the store lacks are said before the lanes, never left as a shorter list.
    ...(session.restore === undefined ? [] : [`Kits not restored: ${session.restore.message}`]),
    `Lanes: ${session.lanes.map((lane) => `ia:${lane}`).join(', ')}. For a task, pick the lane, call ia_catalogue {lane} and map the request to one item's key, then call ia_method {key} and follow the packet it returns.`,
    session.pin
      ? `Current pin: task ${session.pin.task}, ${session.pin.key}, revision ${session.pin.revision}. After a context loss, call ia_method {key: "${session.pin.key}"} with that task to re-read it.`
      : 'No task pin is recorded for this workspace yet.',
  ];
  const text = lines.join('\n');
  return text.length <= BRIEFING_LIMIT ? text : `${text.slice(0, BRIEFING_LIMIT - 1)}…`;
}

/** Opens a session: its id, briefing and first log line. A parent names the session that started this one. */
export function openSession(
  home: string,
  context: {
    readonly root: string;
    readonly workspace: string | null;
    readonly kits: readonly Kit[];
    /** The kits the lock installs that the store lacks, as `workspaceKits` reported them. */
    readonly missing?: readonly LockedKit[];
    /** A restore notice the caller already has, such as an installation that needs restoring before it opens. */
    readonly restore?: SessionRestore;
    readonly parent?: string;
    readonly claim?: SessionClaim;
  },
  now: Date = new Date(),
): Session {
  if (context.parent !== undefined && !SESSION_ID.test(context.parent))
    throw new MethodError(`parent must be a session id: ${context.parent}`, 'IA-CORE-USAGE');
  if (context.claim !== undefined && !['read', 'write'].includes(context.claim.mode))
    throw new MethodError('a claim mode is read or write', 'IA-CORE-USAGE');
  const sessionId = randomUUID();
  const pin = currentPin(home, context.root);
  const restore = context.restore ?? sessionRestore(context.missing ?? []);
  const body = {
    root: context.root,
    workspace: context.workspace,
    kits: sessionKits(context.kits),
    lanes: [...LANES],
    ...(pin === undefined ? {} : { pin }),
    ...(restore === undefined ? {} : { restore }),
  };
  const session: Session = { sessionId, ...body, briefing: briefing(body) };
  appendSessionEvent(home, sessionId, {
    event: 'start',
    at: now.toISOString(),
    ...(context.parent === undefined ? {} : { parent: context.parent }),
    ...body,
    ...(context.claim === undefined ? {} : { claim: { ...context.claim, advisory: true } }),
  });
  return session;
}

/** Appends one event line to a session's log. */
export function appendSessionEvent(home: string, sessionId: string, event: Record<string, unknown>): string {
  if (!SESSION_ID.test(sessionId)) throw new MethodError(`not a session id: ${sessionId}`, 'IA-CORE-USAGE');
  const dir = join(home, SESSION_DIRECTORY);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sessionId}.jsonl`);
  appendFileSync(path, JSON.stringify({ sessionId, ...event }) + '\n');
  return path;
}
