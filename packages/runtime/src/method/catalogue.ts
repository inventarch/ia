import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRIES, SCOPE_KEYS, readBindings } from './bindings.js';
import type { Entry } from './bindings.js';
import { MethodError } from './errors.js';
import { kitBindings, kitDelivery } from './kits.js';
import type { Kit } from './kits.js';

/**
 * A lane's catalogue: the activities a model can map a request to, each a key it then hands to `resolveMethod`. Its
 * sources are each kit's `bindings.json` recommendations for the lane, the workspace's `.ia/bindings.json`, and each
 * lane kit's `delivery.json` whole capabilities no key yet names. An item is `bound` when the workspace binds its key,
 * else `installed`; `entitled` is an account connector's and never this catalogue's. No free text is read: the lane,
 * word and phase are closed tokens.
 */
export type CatalogueState = 'bound' | 'installed' | 'entitled';
export interface CatalogueItem {
  readonly key: string;
  readonly display: string;
  readonly kit: string;
  readonly version: string | null;
  readonly capability?: string;
  readonly profile?: string;
  readonly description: string;
  readonly state: CatalogueState;
}
export interface Catalogue {
  readonly lane: Entry;
  readonly items: readonly CatalogueItem[];
}
export const DESCRIPTION_LIMIT = 200;

/** `ia-<lane>:<activity>`, and `ia-<lane>` for the lane's own `<lane>.*` key. */
export const displayName = (key: string): string => {
  const [lane, activity] = key.split('.') as [string, string];
  return activity === '*' ? `ia-${lane}` : `ia-${lane}:${activity}`;
};

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= DESCRIPTION_LIMIT) return flat;
  const sentence = flat.slice(0, DESCRIPTION_LIMIT).match(/^.*?[.!?](?=\s|$)/)?.[0];
  return sentence && sentence.length >= 40 ? sentence : `${flat.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…`;
};

/** Each `@capability` record's `meaning.says` in a kit's sources, by name, read as text without opening the kit. */
export function capabilityDescriptions(kitDir: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const systems = join(kitDir, '.ia', 'src', 'systems');
  if (!existsSync(systems)) return found;
  for (const system of readdirSync(systems).sort()) {
    const records = join(systems, system, 'records');
    const files = [
      join(systems, system, 'system.ia'),
      ...(existsSync(records) ? readdirSync(records).map((file) => join(records, file)) : []),
    ].filter((file) => file.endsWith('.ia') && existsSync(file));
    for (const file of files) {
      const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      for (const block of text.split(/^(?=@)/m)) {
        const head = /^@capability ([a-z0-9][a-z0-9-]*)/.exec(block);
        const says = /^\s+says "((?:[^"\\]|\\.)*)"/m.exec(block);
        if (head && says && !found.has(head[1]!)) found.set(head[1]!, says[1]!.replace(/\\(.)/g, '$1'));
      }
    }
  }
  return found;
}

/** The phase an activity states to the position (`SCOPE_KEYS`), its lane's default when the table names none. */
const phaseOf = (lane: Entry, activity: string): string =>
  (SCOPE_KEYS[lane][activity] ?? SCOPE_KEYS[lane]['default']!)[1];

/** The catalogue of one lane, for a workspace root (or none) and the kits a resolve can read. */
export function laneCatalogue(
  request: { readonly lane: string; readonly word?: string; readonly phase?: string },
  context: { readonly root: string | null; readonly kits: readonly Kit[] },
): Catalogue {
  if (!(ENTRIES as readonly string[]).includes(request.lane))
    throw new MethodError(`lane must be one of ${ENTRIES.join(', ')}`, 'IA-CORE-USAGE');
  const lane = request.lane as Entry;
  const byId = new Map(context.kits.map((kit) => [kit.id, kit]));
  const descriptions = new Map<string, ReadonlyMap<string, string>>();
  const describe = (kitId: string, capability: string): string => {
    const kit = byId.get(kitId);
    if (kit === undefined) return '';
    if (!descriptions.has(kitId)) descriptions.set(kitId, capabilityDescriptions(kit.dir));
    return oneLine(descriptions.get(kitId)!.get(capability) ?? '');
  };
  const versionOf = (kitId: string): string | null => {
    const kit = byId.get(kitId);
    return kit === undefined ? null : (kit.latest?.version ?? kit.version ?? null);
  };
  const items = new Map<string, CatalogueItem>();
  const add = (
    key: string,
    row: { readonly kit: string; readonly capability: string; readonly profile?: string | undefined },
    state: CatalogueState,
  ): void => {
    items.set(key, {
      key,
      display: displayName(key),
      kit: row.kit,
      version: versionOf(row.kit),
      capability: row.capability,
      ...(row.profile === undefined ? {} : { profile: row.profile }),
      description: describe(row.kit, row.capability),
      state,
    });
  };
  for (const kit of context.kits) {
    let recommend: ReturnType<typeof kitBindings>['recommend'];
    try {
      ({ recommend } = kitBindings(kit));
    } catch {
      continue;
    }
    const own = Object.entries(recommend).filter(([key]) => key.startsWith(`${lane}.`));
    for (const [key, row] of own) if (!items.has(key)) add(key, row, 'installed');
    if (own.length === 0) continue;
    let whole: readonly string[] = [];
    try {
      whole = kitDelivery(kit).whole;
    } catch {
      whole = [];
    }
    const named = new Set(own.map(([, row]) => row.capability));
    for (const capability of whole) {
      const key = `${lane}.${capability}`;
      if (!named.has(capability) && !items.has(key)) add(key, { kit: kit.id, capability }, 'installed');
    }
  }
  const bound = context.root === null ? null : readBindings(context.root);
  if (bound !== null)
    for (const [key, rows] of Object.entries(bound.bindings)) {
      if (!key.startsWith(`${lane}.`)) continue;
      const ranked = rows.length === 1 ? rows[0] : (rows.find((row) => bound.precedence.includes(row.kit)) ?? rows[0]);
      if (ranked !== undefined) add(key, ranked, 'bound');
    }
  const listed = [...items.values()]
    .filter((item) => {
      const activity = item.key.slice(lane.length + 1);
      if (request.word !== undefined && activity !== request.word) return false;
      if (request.phase !== undefined && activity !== '*' && phaseOf(lane, activity) !== request.phase) return false;
      return true;
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { lane, items: listed };
}
