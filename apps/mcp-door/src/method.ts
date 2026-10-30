import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { applyInstallation, cacheArchive, planInstallation } from '@inventarch/distribution/install';
import {
  ENTRIES,
  MethodError,
  checkRoot,
  iaHome,
  laneCatalogue,
  listKits,
  methodRefusal,
  openSession,
  projectOf,
  readRegistry,
  resolveMethod,
  samePath,
} from '@inventarch/runtime/method';
import type { Kit, KitSources } from '@inventarch/runtime/method';

/**
 * The door's method tools: `ia_session`, `ia_catalogue` and `ia_method`. They take structured input only; `subject`
 * is never read as a request and is stored only as its hash. Each acts at the door's launch root or at a root the
 * IA home's workspace registry lists, and only after that workspace's mandates admit the read (Observation). Kits are
 * read from the bundled folder (`--kits`, else `IA_KITS_DIR`) and then the IA home's `kits/`. A kit's read root is
 * restored in process with the language base this package carries; nothing spawns the CLI.
 */
export interface MethodHost {
  /** The door's launch root. */
  readonly root: string;
  /** The bundled kit folder, `--kits` or `IA_KITS_DIR`. */
  readonly kits?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The parent of the per-user kit read-root cache; the system temporary folder by default. */
  readonly cache?: string;
}
export type MethodOperation = 'method:session' | 'method:catalogue' | 'method:method';
type Result = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly value: unknown };

const BASE_URL = new URL('../assets/base.json', import.meta.url);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY = /^([a-z]+)\.([a-z][a-z0-9-]*|\*)$/;
const text = { type: 'string' };
const schema = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const rootProperty = {
  ...text,
  maxLength: 4096,
  description: "An absolute workspace root: the door's launch root or one the IA home's workspace registry lists.",
};

export const METHOD_TOOLS = [
  {
    name: 'ia_session',
    operation: 'method:session',
    description:
      'Start an IA session: returns its id, the workspace, the kits found (bundled or home), the three lanes, the current task pin and a briefing of at most 2,500 characters, and appends a line to the public session log under the IA home. A claim is advisory and never fenced.',
    inputSchema: schema({
      root: rootProperty,
      parent: { ...text, maxLength: 128, description: 'The id of the session that started this one.' },
      claim: schema(
        {
          path: { ...text, maxLength: 1024, description: 'A workspace-relative path the session means to work in.' },
          mode: { enum: ['read', 'write'] },
        },
        ['path', 'mode'],
      ),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ia_catalogue',
    operation: 'method:catalogue',
    description:
      "List one lane's activities: each item's key, display name, kit, version, capability, profile, one-line description and state (bound or installed). Map the request to one key and pass it to ia_method; no free text is read.",
    inputSchema: schema(
      {
        lane: { enum: [...ENTRIES] },
        word: { ...text, maxLength: 64, description: 'Keep only the activity of this name, such as decision.' },
        phase: { enum: ['orient', 'plan', 'act', 'learn'] },
        root: rootProperty,
      },
      ['lane'],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'ia_method',
    operation: 'method:method',
    description:
      "Resolve one activity key (from ia_catalogue) to its method packet: the bound kit's capability, its instructions, references, role brief, required checks and digest, exactly as the ia plugin's resolver prints it. With task, the task pin is written under the IA home with the subject's hash, never its text.",
    inputSchema: schema(
      {
        key: { ...text, maxLength: 96, description: '<lane>.<activity>, such as work.brainstorm.' },
        root: rootProperty,
        subject: {
          ...text,
          maxLength: 4096,
          description: 'What the task is about; stored and returned only as its sha256.',
        },
        task: { ...text, maxLength: 128, description: 'A task slug: pins the resolution under that task.' },
      },
      ['key'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
] as const;

interface BasePin {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
}
/** Restores a kit's read root in process: the language base this package carries, cached, planned and installed. */
export function restoreKit(root: string, kit: Kit): void {
  let pin: BasePin;
  try {
    pin = JSON.parse(readFileSync(BASE_URL, 'utf8')) as BasePin;
  } catch {
    throw new MethodError('this door carries no language base; reinstall @inventarch/mcp-door', 'IA-CORE-CLI-MISSING');
  }
  const lock = JSON.parse(readFileSync(join(root, '.ia', 'distributions.lock.json'), 'utf8')) as {
    packages?: { id: string; version: string; archive: string }[];
  };
  const language = lock.packages?.find((pkg) => pkg.id === pin.id);
  if (language?.archive !== pin.archive)
    throw new MethodError(
      `kit ${kit.id} ${kit.latest?.version ?? kit.version} locks ${pin.id} ${language?.version ?? 'an unknown version'}, and this door carries ${pin.version}: use the @inventarch/mcp-door release that ships it`,
      'IA-CORE-CLI-UNSUPPORTED',
    );
  cacheArchive(root, readFileSync(new URL(`../assets/base/${pin.archive}.ia.tgz`, import.meta.url)), pin.archive);
  applyInstallation(planInstallation(root, lock, 'restore'));
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
function usage(message: string): never {
  throw new MethodError(message, 'IA-CORE-USAGE');
}
function optional(args: Record<string, unknown>, name: string, limit: number): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > limit)
    usage(`${name} must be a string of 1 to ${limit} characters`);
  return value;
}
function only(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) usage(`unknown argument ${key}`);
}

export class MethodTools {
  readonly #host: MethodHost;
  constructor(host: MethodHost) {
    this.#host = host;
  }
  get #env(): NodeJS.ProcessEnv {
    return this.#host.env ?? process.env;
  }
  get #home(): string {
    return iaHome(this.#env);
  }
  get #sources(): KitSources {
    const env = this.#env;
    const bundled = this.#host.kits ?? env['IA_KITS_DIR'];
    const home = env['IA_CORE_NO_HOME_KITS'] === '1' ? null : join(this.#home, 'kits');
    return { ...(bundled ? { bundled: resolve(bundled) } : {}), home };
  }
  /** The root a call names: the launch root, or a registered one, once its mandates admit the read. */
  #root(value: string | undefined): { readonly root: string; readonly workspace: string | null } {
    let root = resolve(this.#host.root);
    if (value !== undefined) {
      if (!isAbsolute(value)) usage(`root must be an absolute path: ${value}`);
      const registered = readRegistry(this.#home).workspaces.find((row) => samePath(row.root, value));
      if (!samePath(value, root) && registered === undefined)
        throw new MethodError(
          `${value} is neither this door's root nor a workspace the IA home's registry lists`,
          'IA-CORE-ROOT-UNREGISTERED',
        );
      root = resolve(value);
    }
    if (!existsSync(join(root, '.ia', 'src'))) return { root, workspace: null };
    return { root, workspace: checkRoot(root, 'read').workspace };
  }
  #kits(): Kit[] {
    return listKits(this.#sources);
  }
  call(operation: MethodOperation, input: unknown): Result {
    try {
      const args = object(input);
      if (operation === 'method:session') return { ok: true, value: this.#session(args) };
      if (operation === 'method:catalogue') return { ok: true, value: this.#catalogue(args) };
      return { ok: true, value: this.#method(args) };
    } catch (error) {
      return { ok: false, value: methodRefusal(error) };
    }
  }
  #session(args: Record<string, unknown>): unknown {
    only(args, ['root', 'parent', 'claim']);
    const parent = optional(args, 'parent', 128);
    const claim = args['claim'] === undefined ? undefined : object(args['claim']);
    if (claim !== undefined) {
      only(claim, ['path', 'mode']);
      if (typeof claim['path'] !== 'string' || claim['path'].length === 0 || isAbsolute(claim['path']))
        usage('claim.path must be a workspace-relative path');
      if (claim['mode'] !== 'read' && claim['mode'] !== 'write') usage('claim.mode is read or write');
    }
    const { root, workspace } = this.#root(optional(args, 'root', 4096));
    return openSession(this.#home, {
      root,
      workspace,
      kits: this.#kits(),
      ...(parent === undefined ? {} : { parent }),
      ...(claim === undefined
        ? {}
        : { claim: { path: claim['path'] as string, mode: claim['mode'] as 'read' | 'write' } }),
    });
  }
  #catalogue(args: Record<string, unknown>): unknown {
    only(args, ['lane', 'word', 'phase', 'root']);
    const lane = optional(args, 'lane', 16) ?? usage('lane is required');
    const word = optional(args, 'word', 64);
    const phase = optional(args, 'phase', 16);
    if (word !== undefined && !/^[a-z][a-z0-9-]*$/.test(word)) usage('word must be a lowercase word');
    if (phase !== undefined && !['orient', 'plan', 'act', 'learn'].includes(phase))
      usage('phase must be orient, plan, act or learn');
    const { root } = this.#root(optional(args, 'root', 4096));
    return laneCatalogue(
      { lane, ...(word === undefined ? {} : { word }), ...(phase === undefined ? {} : { phase }) },
      { root: existsSync(join(root, '.ia', 'src')) ? root : null, kits: this.#kits() },
    );
  }
  #method(args: Record<string, unknown>): unknown {
    only(args, ['key', 'root', 'subject', 'task']);
    const key = optional(args, 'key', 96) ?? usage('key is required');
    const matched = KEY.exec(key) ?? usage(`key must be <lane>.<activity>: ${key}`);
    const task = optional(args, 'task', 128);
    if (task !== undefined && !SLUG.test(task)) usage(`task must be a slug: ${task}`);
    const subject = optional(args, 'subject', 4096);
    const { root } = this.#root(optional(args, 'root', 4096));
    const project = projectOf(root);
    return resolveMethod(
      {
        entry: matched[1]!,
        activity: matched[2]!,
        root,
        host: 'mcp-door',
        ...(subject === undefined
          ? {}
          : { subject: `sha256:${createHash('sha256').update(subject, 'utf8').digest('hex')}` }),
        ...(task === undefined ? {} : { project, task }),
      },
      {
        kits: this.#sources,
        restore: restoreKit,
        env: this.#env,
        ...(this.#host.cache === undefined ? {} : { cache: this.#host.cache }),
      },
    );
  }
}
