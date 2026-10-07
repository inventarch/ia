import { KINDS } from '@inventarch/language';
import type { ConditionAxis, EdgeReference, Kind, Phase } from '@inventarch/language';
import { GraphUsageError, validateCoordinate } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import { DbError, open } from '@inventarch/db';
import type { Handle, OpenOptions, ReadOptions, Scope, ScopeRequest } from '@inventarch/db';
import { context } from './context.js';
import { RuntimeError } from './errors.js';
import type { PositionOptions } from './position.js';
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
export class Door {
  #handle: Handle;
  #initial: Scope;
  #tokens = new Set<string>();
  #allowReport: boolean;
  #closed = false;
  constructor(root: string, options: DoorOptions = {}) {
    this.#handle = open(root, options);
    this.#initial = this.#handle.resolveScope(options.boundary);
    this.#tokens.add(this.#initial.token);
    this.#allowReport = options.allowReport ?? false;
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
    try {
      if (this.#closed) throw new DbError('IA-DB-CLOSED', 'This door is closed');
      const envelope = object(input, 'request');
      keys(envelope, ['operation', 'params']);
      const operation = string(envelope['operation'], 'operation'),
        params = envelope['params'] === undefined ? {} : object(envelope['params'], 'params');
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
        default:
          return invalid(
            `Unknown operation '${operation}'; admitted: scope, context, select, get, records, resolve, search, traverse${this.#allowReport ? ', report' : ''}`,
          );
      }
      return freeze({ ok: true, result });
    } catch (error) {
      return freeze({
        ok: false,
        code:
          error instanceof DbError || error instanceof GraphUsageError || error instanceof RuntimeError
            ? error.code
            : 'IA-RUNTIME-REQUEST-INVALID',
        message: error instanceof Error ? error.message : 'Invalid request',
      });
    }
  }
  close(): void {
    this.#closed = true;
    this.#tokens.clear();
    this.#handle.close();
  }
}
