import { KINDS } from '@inventarch/language';
import type { ConditionAxis, EdgeReference, Kind, Phase } from '@inventarch/language';
import { GraphUsageError, validateCoordinate } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import { DbError, digestIndex, open, readCapturedSnapshot } from '@inventarch/db';
import type { DigestIndex, Handle, OpenOptions, ReadOptions, Scope, ScopeRequest } from '@inventarch/db';
import { context } from './context.js';
import { RuntimeError } from './errors.js';
import { parseLocator, readBody } from './locator.js';
import { MACHINE_PROTOCOL } from './machine-protocol.js';
import { DeliveryRefusal, next as deliveryView } from './next.js';
import { position } from './position.js';
import type { PositionOptions } from './position.js';
import { normalizeScopeKey, SCOPE_KEY_PARTS } from './scope-key.js';
import { select } from './select.js';
import { freeze } from './types.js';
import type { Budget, ContextRequest, Refusal } from './types.js';

export interface DoorOptions extends OpenOptions, PositionOptions {
  readonly boundary?: Omit<ScopeRequest, 'within'>;
  readonly allowReport?: boolean;
}
export type DoorResponse = { readonly ok: true; readonly result: unknown } | Refusal;
type Params = Record<string, unknown>;
/** The released record shape of the frozen get/records results: the per-record digest (graph G13) stays off the wire. */
function released(node: Node): Omit<Node, 'digest'> {
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'digest')) as Omit<Node, 'digest'>;
}
function invalid(message: string): never {
  throw new RuntimeError('IA-RUNTIME-REQUEST-INVALID', message);
}
function object(value: unknown, label: string): Params {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(`${label} must be an object`);
  return value as Params;
}
function keys(params: Params, allowed: readonly string[]): void {
  for (const key of Object.keys(params))
    if (!allowed.includes(key)) invalid(`Unknown parameter '${key}'; admitted: ${allowed.join(', ')}`);
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string') return invalid(`${label} must be a string`);
  return value;
}
function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    return invalid(`${label} must be an array of strings`);
  return value as string[];
}
function reference(value: unknown): EdgeReference {
  const ref = object(value, 'reference');
  if (ref['kind'] === 'identity') {
    keys(ref, ['kind', 'identity', 'fragment']);
    return {
      kind: 'identity',
      identity: string(ref['identity'], 'identity'),
      ...(ref['fragment'] === undefined ? {} : { fragment: string(ref['fragment'], 'fragment') }),
    };
  }
  if (ref['kind'] === 'ref') {
    keys(ref, ['kind', 'discriminator', 'name', 'fragment']);
    return {
      kind: 'ref',
      discriminator: string(ref['discriminator'], 'discriminator'),
      name: string(ref['name'], 'name'),
      ...(ref['fragment'] === undefined ? {} : { fragment: string(ref['fragment'], 'fragment') }),
    };
  }
  return invalid('reference.kind must be identity or ref');
}
const BINDINGS = ['within', 'root', 'phase', 'revision'];
const CONTEXT = ['within', 'text', 'coordinate', 'subject', 'follow', 'revision'];
/**
 * The next action of each refusal the operations protocol version 2 added can give, from their protocol rows: the
 * table describes, the Door still decides. Version-1 operations are not listed, so their refusals carry no next.
 */
/** A version-2 refusal the protocol row does not list still names a next action. */
const NO_NEXT = "Compare the request with this operation's description: its parameters and refusals.";
const NEXT: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  MACHINE_PROTOCOL.operations
    .filter((operation) => operation.since !== undefined)
    .map((operation) => [operation.name, new Map(operation.refusals.map((refusal) => [refusal.code, refusal.next]))]),
);
/**
 * The snapshot a Door's handle retains when its host names none: the capture store's current snapshot at `root`
 * (`readCapturedSnapshot`, which needs no cache), the one a later process compares against. A store that is absent or
 * unreadable, or a root that cannot be read, seeds nothing; opening the workspace then decides the root's refusal. Only
 * the delivery view reads the retained snapshot; the nine routes and position never do.
 */
function captured(root: string): DigestIndex | undefined {
  try {
    const current = readCapturedSnapshot(root).current;
    return current === undefined ? undefined : digestIndex(current);
  } catch {
    return undefined;
  }
}
export class Door {
  #handle: Handle;
  #initial: Scope;
  #tokens = new Set<string>();
  #allowReport: boolean;
  #position: PositionOptions;
  #closed = false;
  constructor(root: string, options: DoorOptions = {}) {
    const previous = options.previous ?? captured(root);
    this.#handle = open(root, previous === undefined ? options : { ...options, previous });
    this.#initial = this.#handle.resolveScope(options.boundary);
    this.#tokens.add(this.#initial.token);
    this.#allowReport = options.allowReport ?? false;
    this.#position = options.hostFacts === undefined ? {} : { hostFacts: options.hostFacts };
    Object.freeze(this);
  }
  #within(params: Params): string {
    const token = params['within'] === undefined ? this.#initial.token : string(params['within'], 'within');
    if (!this.#tokens.has(token)) throw new DbError('IA-DB-SCOPE-UNAVAILABLE', 'Token was not issued by this door');
    return token;
  }
  #bindings(params: Params): ReadOptions {
    const phase =
      params['phase'] === undefined || params['phase'] === null
        ? params['phase']
        : (validateCoordinate({ phase: params['phase'] }).phase as Phase);
    return {
      within: this.#within(params),
      ...(params['root'] === undefined ? {} : { root: string(params['root'], 'root') }),
      ...(phase === undefined ? {} : { phase }),
      ...(params['revision'] === undefined ? {} : { revision: string(params['revision'], 'revision') }),
    };
  }
  #context(params: Params): ContextRequest {
    return {
      within: this.#within(params),
      text: string(params['text'], 'text'),
      coordinate: params['coordinate'] === undefined ? {} : object(params['coordinate'], 'coordinate'),
      ...(params['subject'] === undefined
        ? {}
        : { subject: typeof params['subject'] === 'string' ? params['subject'] : reference(params['subject']) }),
      ...(params['follow'] === undefined ? {} : { follow: strings(params['follow'], 'follow') }),
      ...(params['revision'] === undefined ? {} : { revision: string(params['revision'], 'revision') }),
    };
  }
  request(input: unknown): DoorResponse {
    let operation: string | undefined;
    try {
      if (this.#closed) throw new DbError('IA-DB-CLOSED', 'This door is closed');
      const envelope = object(input, 'request');
      keys(envelope, ['operation', 'params']);
      operation = string(envelope['operation'], 'operation');
      const params = envelope['params'] === undefined ? {} : object(envelope['params'], 'params');
      let result: unknown;
      switch (operation) {
        case 'scope': {
          keys(params, [...BINDINGS, 'identities']);
          const scope = this.#handle.resolveScope({
            ...this.#bindings(params),
            ...(params['identities'] === undefined ? {} : { identities: strings(params['identities'], 'identities') }),
          });
          this.#tokens.add(scope.token);
          result = scope;
          break;
        }
        case 'context': {
          keys(params, [...CONTEXT, 'budget', 'ranking']);
          if (params['ranking'] !== undefined && params['ranking'] !== 'native' && params['ranking'] !== 'topical')
            invalid('Context ranking must be native or topical');
          const budget =
            params['budget'] === undefined ? { tokens: 4000, records: 50 } : object(params['budget'], 'budget');
          keys(budget, ['tokens', 'records']);
          const got = context(this.#handle, this.#context(params), budget as unknown as Budget, {
            purpose: true,
            ...(params['ranking'] === 'topical' ? { ranking: 'topical' as const } : {}),
          });
          if (!got.ok) return got;
          this.#tokens.add(got.packet.scope.token);
          result = got.packet;
          break;
        }
        case 'select': {
          keys(params, [...CONTEXT, 'candidates', 'requiredAxes']);
          const got = select(this.#handle, this.#context(params), strings(params['candidates'], 'candidates'), {
            ...(params['requiredAxes'] === undefined
              ? {}
              : { requiredAxes: strings(params['requiredAxes'], 'requiredAxes') as ConditionAxis[] }),
          });
          if (!got.ok) return got;
          this.#tokens.add(got.selection.scope.token);
          result = got.selection;
          break;
        }
        case 'get':
          keys(params, [...BINDINGS, 'identity']);
          {
            const node = this.#handle.get(string(params['identity'], 'identity'), this.#bindings(params));
            result = node === undefined ? null : released(node);
          }
          break;
        case 'records':
          keys(params, BINDINGS);
          {
            const snapshot = this.#handle.snapshot(this.#bindings(params));
            result = { ...snapshot, records: snapshot.records.map(released) };
          }
          break;
        case 'resolve':
          keys(params, [...BINDINGS, 'reference']);
          result = this.#handle.resolve(reference(params['reference']), this.#bindings(params));
          break;
        case 'search':
          keys(params, [...BINDINGS, 'text']);
          result = this.#handle.search(string(params['text'], 'text'), this.#bindings(params));
          break;
        case 'traverse': {
          keys(params, [...BINDINGS, 'start', 'follow', 'direction', 'depth', 'filter', 'coordinate']);
          const filter = params['filter'] === undefined ? {} : object(params['filter'], 'filter');
          keys(filter, ['kind', 'discriminator', 'system']);
          if (filter['kind'] !== undefined && !(KINDS as readonly unknown[]).includes(filter['kind']))
            invalid('Unknown filter.kind');
          if (params['depth'] !== undefined && typeof params['depth'] !== 'number') invalid('depth must be a number');
          if (
            params['direction'] !== undefined &&
            !['out', 'in', 'both'].includes(string(params['direction'], 'direction'))
          )
            invalid('direction must be out, in or both');
          result = this.#handle.traverse({
            ...this.#bindings(params),
            start: strings(params['start'], 'start'),
            ...(params['follow'] === undefined ? {} : { follow: strings(params['follow'], 'follow') }),
            ...(params['direction'] === undefined ? {} : { direction: params['direction'] as 'out' | 'in' | 'both' }),
            ...(params['depth'] === undefined ? {} : { depth: params['depth'] as number }),
            ...(params['coordinate'] === undefined
              ? {}
              : { coordinate: validateCoordinate(object(params['coordinate'], 'coordinate')) }),
            filter: {
              ...(filter['kind'] === undefined ? {} : { kind: filter['kind'] as Kind }),
              ...(filter['discriminator'] === undefined
                ? {}
                : { discriminator: string(filter['discriminator'], 'discriminator') }),
              ...(filter['system'] === undefined ? {} : { system: string(filter['system'], 'system') }),
            },
          });
          break;
        }
        case 'report':
          keys(params, []);
          if (!this.#allowReport) invalid('This host has not enabled privileged report inspection');
          result = this.#handle.report;
          break;
        // Protocol version 2. None issues a scope token; each reads through the one `within` names.
        case 'position': {
          keys(params, ['within', ...SCOPE_KEY_PARTS]);
          const within = this.#within(params),
            key = normalizeScopeKey(Object.fromEntries(Object.entries(params).filter(([name]) => name !== 'within')));
          result = position(this.#handle, within, key, this.#position);
          break;
        }
        case 'read': {
          keys(params, ['within', 'locator']);
          const within = this.#within(params);
          result = readBody(this.#handle, parseLocator(string(params['locator'], 'locator')), { within });
          break;
        }
        case 'next': {
          keys(params, ['within', 'seat']);
          const within = this.#within(params);
          result = deliveryView(
            this.#handle,
            within,
            params['seat'] === undefined ? {} : { seat: string(params['seat'], 'seat') },
          );
          break;
        }
        default:
          return invalid(
            `Unknown operation '${operation}'; admitted: scope, context, select, get, records, resolve, search, traverse${this.#allowReport ? ', report' : ''}, position, read, next`,
          );
      }
      return freeze({ ok: true, result });
    } catch (error) {
      const code =
          error instanceof DbError || error instanceof GraphUsageError || error instanceof RuntimeError
            ? error.code
            : 'IA-RUNTIME-REQUEST-INVALID',
        next = operation === undefined ? undefined : NEXT.get(operation);
      return freeze({
        ok: false,
        code,
        message: error instanceof Error ? error.message : 'Invalid request',
        // A refusal of the delivery view names the command for its own cause, which the row's one next cannot.
        ...(next === undefined
          ? {}
          : { next: error instanceof DeliveryRefusal ? error.next : (next.get(code) ?? NO_NEXT) }),
      });
    }
  }
  close(): void {
    this.#closed = true;
    this.#tokens.clear();
    this.#handle.close();
  }
}
