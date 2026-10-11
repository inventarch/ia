import { KINDS } from '@inventarch/language';
import type { ConditionAxis, EdgeReference, Kind, Phase } from '@inventarch/language';
import { GraphUsageError, validateCoordinate } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import { DbError, adoptedBindings, open, readWorkspaceBytes } from '@inventarch/db';
import type { Handle, OpenOptions, ReadOptions, Scope, ScopeRequest } from '@inventarch/db';
import { DISTRIBUTION_LIMITS } from '@inventarch/db/distribution';
import { context } from './context.js';
import { RuntimeError } from './errors.js';
import { readBody } from './locator.js';
import { MACHINE_PROTOCOL } from './machine-protocol.js';
import { deliveryView } from './next.js';
import { position } from './position.js';
import type { ScopeKey } from './scope-key.js';
import { select } from './select.js';
import { freeze } from './types.js';
import type { Budget, ContextRequest, Refusal } from './types.js';

export interface DoorOptions extends OpenOptions {
  readonly boundary?: Omit<ScopeRequest, 'within'>;
  readonly allowReport?: boolean;
  /**
   * The reader `read` hands the canonical workspace-relative path of a document to (`ReadBodyOptions.read`); by
   * default db `readWorkspaceBytes` over the door's root, bounded as the CLI's workspace file reader is.
   */
  readonly read?: (path: string) => Uint8Array;
  /**
   * The MACHINE_PROTOCOL version the door serves, by default the table's: an operation a later version adds (its row's
   * `since`) is refused as an unknown operation, and that refusal names only the operations served, so a door serving
   * version 1, as the CLI's machine routes do (plan amendment A2), refuses `read`, `next` and `position` with the bytes
   * 1.1.0's door did.
   */
  readonly protocol?: number;
}
/**
 * A version 1 operation's refusal keeps its 1.1.0 shape. A later version's operation answers with the refusal its
 * runtime function returns, which may carry more: `read` the `ReadRefusal` fields, `next` the `NextRefusal`'s `next`
 * command, `plans` and `cycle`, and `position` a key's `next` command (R12).
 */
export type DoorResponse = { readonly ok: true; readonly result: unknown } | Refusal;
type Params = Record<string, unknown>;
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
/** `position`: the scope token and the six parts of the scope key K, which normalizeScopeKey completes (R14). */
const POSITION = ['within', 'seat', 'shape', 'phase', 'depth', 'budget', 'word'];
/** The bound on one document `read` returns: the CLI's workspace file reader's, so the two readers agree. */
const READ_LIMIT = DISTRIBUTION_LIMITS.metadata;
/**
 * Version 1 records omit the per-record digest, as the published 1.2.0 Door does. Authored edge spelling shipped in
 * 1.2.0 and remains on get, records, traverse and context at every protocol version. New operations are additive.
 */
const versionOne = ({ digest: _digest, ...record }: Node): Omit<Node, 'digest'> => record;
export class Door {
  #handle: Handle;
  #initial: Scope;
  #tokens = new Set<string>();
  #allowReport: boolean;
  #protocol: number;
  #read: (path: string) => Uint8Array;
  #mounts: ReadonlyMap<string, string>;
  #closed = false;
  constructor(root: string, options: DoorOptions = {}) {
    const protocol = options.protocol ?? MACHINE_PROTOCOL.version;
    if (!Number.isSafeInteger(protocol) || protocol < 1 || protocol > MACHINE_PROTOCOL.version)
      throw new TypeError(`A door serves a MACHINE_PROTOCOL version from 1 to ${MACHINE_PROTOCOL.version}`);
    this.#handle = open(root, options);
    this.#initial = this.#handle.resolveScope(options.boundary);
    this.#tokens.add(this.#initial.token);
    this.#allowReport = options.allowReport ?? false;
    this.#protocol = protocol;
    const canonical = this.#handle.root;
    // The default reader names a document by its workspace-relative path alone, never by where the server keeps the
    // workspace (R12): its link, escape and file refusals already do, and the one that names the root, a root that can
    // no longer be opened, as when the workspace moves while the door serves, is answered without it.
    this.#read =
      options.read ??
      ((path) => {
        try {
          return readWorkspaceBytes(canonical, path, READ_LIMIT);
        } catch (error) {
          if (error instanceof DbError && error.code === 'IA-DB-ROOT-INVALID')
            throw new DbError(error.code, `The workspace can no longer be opened to read ${path}`, path);
          throw error;
        }
      });
    // The directory each adopted mount's tree label is bound to, bound once from the manifest `open` has just read, so
    // the mounts match the handle's snapshot as `ia read`'s match its session. Explicit captures replace the manifest
    // and name no directory, and a door that serves no `read` binds none.
    this.#mounts =
      options.adopted === undefined && protocol >= 2
        ? new Map(adoptedBindings(canonical).map((binding) => [binding.tree, binding.path]))
        : new Map();
    Object.freeze(this);
  }
  /** The refusal of an operation this door does not serve, naming the ones it does in table order. */
  #unknown(operation: string): never {
    return invalid(
      `Unknown operation '${operation}'; admitted: scope, context, select, get, records, resolve, search, traverse${this.#allowReport ? ', report' : ''}${this.#protocol >= 2 ? ', read, next, position' : ''}`,
    );
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
        case 'get': {
          keys(params, [...BINDINGS, 'identity']);
          const record = this.#handle.get(string(params['identity'], 'identity'), this.#bindings(params));
          result = record === undefined ? null : versionOne(record);
          break;
        }
        case 'records': {
          keys(params, BINDINGS);
          // Database D02a membership is read through the handle; the version 1 snapshot keeps its four fields.
          const { membership: _membership, ...snapshot } = this.#handle.snapshot(this.#bindings(params));
          result = { ...snapshot, records: snapshot.records.map(versionOne) };
          break;
        }
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
        case 'read': {
          // MACHINE_PROTOCOL version 2: always read through a token, so a locator outside a narrowed scope reads as one
          // plain refusal that discloses nothing beyond it, and only a whole-workspace token names a record admission
          // refused (R12, db PT5). A door serving version 1 knows no such operation.
          if (this.#protocol < 2) this.#unknown(operation);
          keys(params, ['within', 'locator', 'includeRuntime']);
          if (params['includeRuntime'] !== undefined && typeof params['includeRuntime'] !== 'boolean')
            invalid('includeRuntime must be a boolean');
          const got = readBody(this.#handle, string(params['locator'], 'locator'), {
            within: this.#within(params),
            read: this.#read,
            mounts: this.#mounts,
            includeRuntime: params['includeRuntime'] === true,
          });
          if (!got.ok) return got;
          result = got.body;
          break;
        }
        case 'next': {
          // MACHINE_PROTOCOL version 2: one plan's delivery view through a token, so a narrowed scope reads only what it
          // admits; the refusal is deliveryView's own, with the one command it names (R12, R18).
          if (this.#protocol < 2) this.#unknown(operation);
          keys(params, ['within', 'seat']);
          const seat = params['seat'] === undefined ? undefined : string(params['seat'], 'seat');
          const got = deliveryView(this.#handle, this.#within(params), seat);
          if (!got.ok) return got;
          result = got.view;
          break;
        }
        case 'position': {
          // MACHINE_PROTOCOL version 2: body(K) for the key the parts complete, read through a token, with its digest
          // and the host note (R12, R16). The parameters are closed and the token the Door's, as for every operation;
          // a refusal of the key itself names the one command to run (design row 27).
          if (this.#protocol < 2) this.#unknown(operation);
          keys(params, POSITION);
          const within = this.#within(params),
            { within: _within, ...partial } = params;
          try {
            result = position(this.#handle, within, partial as Partial<ScopeKey>);
          } catch (error) {
            // A refusal of the key (R14) or of its seat (R15) names the one command to run as the error's `next`.
            if (!(error instanceof RuntimeError) || error.next === undefined) throw error;
            return freeze({ ok: false, code: error.code, message: error.message, next: error.next });
          }
          break;
        }
        default:
          return this.#unknown(operation);
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
