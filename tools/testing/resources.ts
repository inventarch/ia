/**
 * Owned asynchronous cleanup for tests. Every acquisition registers its release immediately, so a
 * scope that fails halfway through setup still unwinds what it already holds. Disposal is
 * idempotent, bounded and reverse-ordered, and a teardown failure never replaces the primary error.
 */

export interface TeardownFailure {
  readonly label: string;
  readonly error: unknown;
}

export class ResourceTeardownError extends Error {
  readonly failures: readonly TeardownFailure[];
  constructor(failures: readonly TeardownFailure[]) {
    super(`Resource teardown failed: ${failures.map((failure) => failure.label).join(', ')}`);
    this.name = 'ResourceTeardownError';
    this.failures = failures;
  }
}

export interface ScopeOptions {
  /** Per-release ceiling. Exceeding it records a failure; it does not pretend to have cancelled the work. */
  readonly releaseTimeoutMs?: number;
}

export interface ResourceScope extends AsyncDisposable {
  /** Aborted before the first release runs, so owned work has a real cancellation channel. */
  readonly signal: AbortSignal;
  readonly disposed: boolean;
  readonly teardownFailures: readonly TeardownFailure[];
  /** Registers a release for something already acquired. */
  own<T>(label: string, value: T, release: (value: T) => unknown): T;
  /** Acquires and registers in one step; a throwing acquisition registers nothing. */
  use<T>(label: string, acquire: (scope: ResourceScope) => T | Promise<T>, release: (value: T) => unknown): Promise<T>;
  defer(label: string, release: () => unknown): void;
  dispose(): Promise<void>;
}

const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;

async function bounded(label: string, work: () => unknown, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: release exceeded ${timeoutMs}ms and was abandoned`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.resolve().then(work), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createScope(options: ScopeOptions = {}): ResourceScope {
  const timeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  const registered: { label: string; release: () => unknown }[] = [];
  const failures: TeardownFailure[] = [];
  const controller = new AbortController();
  let disposal: Promise<void> | undefined;

  const scope: ResourceScope = {
    signal: controller.signal,
    get disposed() {
      return disposal !== undefined;
    },
    get teardownFailures() {
      return failures;
    },
    own(label, value, release) {
      if (disposal) throw new Error(`${label}: cannot register on a disposed scope`);
      registered.push({ label, release: () => release(value) });
      return value;
    },
    async use(label, acquire, release) {
      if (disposal) throw new Error(`${label}: cannot acquire on a disposed scope`);
      const value = await acquire(scope);
      return scope.own(label, value, release);
    },
    defer(label, release) {
      if (disposal) throw new Error(`${label}: cannot register on a disposed scope`);
      registered.push({ label, release });
    },
    dispose() {
      disposal ??= (async () => {
        controller.abort(new Error('Resource scope disposed'));
        while (registered.length) {
          const entry = registered.pop()!;
          try {
            await bounded(entry.label, entry.release, timeoutMs);
          } catch (error) {
            failures.push({ label: entry.label, error });
          }
        }
        if (failures.length) throw new ResourceTeardownError(failures);
      })();
      return disposal;
    },
    [Symbol.asyncDispose]() {
      return scope.dispose();
    },
  };
  return scope;
}

/**
 * Runs `body` against a fresh scope and always unwinds it. A failure inside the body stays the
 * thrown error; teardown diagnostics travel with it on `teardownFailures` instead of replacing it.
 */
export async function withScope<T>(
  body: (scope: ResourceScope) => T | Promise<T>,
  options: ScopeOptions = {},
): Promise<T> {
  const scope = createScope(options);
  let primary: unknown,
    failed = false,
    result: T | undefined;
  try {
    result = await body(scope);
  } catch (error) {
    primary = error;
    failed = true;
  }
  try {
    await scope.dispose();
  } catch (teardown) {
    if (!failed) throw teardown;
    if (primary instanceof Error && teardown instanceof ResourceTeardownError) {
      Object.defineProperty(primary, 'teardownFailures', {
        value: teardown.failures,
        enumerable: false,
        configurable: true,
      });
    }
  }
  if (failed) throw primary;
  return result as T;
}
