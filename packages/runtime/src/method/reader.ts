import { adoptedBindings, open, readWorkspaceBytes } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { DISTRIBUTION_LIMITS } from '@inventarch/db/distribution';
import { parseLocator, readBody } from '../locator.js';
import { position } from '../position.js';
import type { ScopeKey } from '../scope-key.js';

/**
 * One workspace read in process, answering what `ia position --json`, `ia inspect --json` and `ia read --json` answer
 * for it: the same bodies, records and directed rows, as JSON values. The workspace opens once, without the db cache, so
 * nothing is written.
 */
export interface PositionAnswer {
  readonly ok: boolean;
  readonly body?: Record<string, unknown>;
  readonly digest?: string;
  readonly code?: string;
  readonly message?: string;
  readonly next?: string;
}
export type JsonRecord = Record<string, unknown>;

const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
const failure = (error: unknown): PositionAnswer => {
  const object = (error ?? {}) as { code?: unknown; next?: unknown };
  return {
    ok: false,
    code: typeof object.code === 'string' ? object.code : 'IA-CORE-ERROR',
    message: error instanceof Error ? error.message : String(error),
    ...(typeof object.next === 'string' ? { next: object.next } : {}),
  };
};

export class WorkspaceReader {
  readonly root: string;
  #handle: Handle | undefined;
  #opened: unknown;
  constructor(root: string) {
    this.root = root;
  }
  #open(): Handle {
    if (this.#handle !== undefined) return this.#handle;
    if (this.#opened !== undefined) throw this.#opened;
    try {
      this.#handle = open(this.root, { cache: false });
      return this.#handle;
    } catch (error) {
      this.#opened = error;
      throw error;
    }
  }
  /** The position body for a shape and phase, and an optional seat: an identity, else a workspace path. */
  position(key: {
    readonly shape: string;
    readonly phase: string;
    readonly seat?: string | undefined;
  }): PositionAnswer {
    try {
      const handle = this.#open();
      const partial: Record<string, unknown> = { shape: key.shape, phase: key.phase };
      if (key.seat !== undefined)
        partial['seat'] = parseLocator(key.seat)?.form === 'identity' ? key.seat : { path: key.seat };
      const got = position(handle, handle.resolveScope().token, partial as Partial<ScopeKey>);
      return { ok: true, body: plain<Record<string, unknown>>(got.body), digest: got.digest };
    } catch (error) {
      return failure(error);
    }
  }
  /** The admitted record of an identity as `ia inspect` lists it, or null. */
  record(identity: string): JsonRecord | null {
    try {
      const found = this.#open()
        .records()
        .find((record) => record.identity === identity);
      return found === undefined ? null : plain<JsonRecord>(found);
    } catch {
      return null;
    }
  }
  /** The inbound rows of an identity's directed view, as `ia inspect --edges in` lists them at depth 1, or null. */
  inbound(identity: string): readonly JsonRecord[] | null {
    try {
      const handle = this.#open();
      if (!handle.records().some((record) => record.identity === identity)) return null;
      return handle
        .directedView(identity)
        .filter((row) => row.direction === 'in')
        .map((row) => plain<JsonRecord>({ identity, depth: 1, ...row }));
    } catch {
      return null;
    }
  }
  /** The body and digest behind a locator, or the refusal's message. */
  read(locator: string): { readonly body: string; readonly digest: string } | { readonly message: string } {
    try {
      const handle = this.#open();
      const root = handle.root;
      const got = readBody(handle, locator, {
        read: (path) => readWorkspaceBytes(root, path, DISTRIBUTION_LIMITS.metadata),
        mounts: new Map(adoptedBindings(root).map((binding) => [binding.tree, binding.path])),
      });
      return got.ok ? { body: got.body.body, digest: got.body.digest } : { message: got.message };
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error) };
    }
  }
  close(): void {
    this.#handle?.close();
    this.#handle = undefined;
  }
}
