import { expect, it } from 'vitest';
import { createScope, ResourceTeardownError, withScope } from './resources.js';

it('unwinds in reverse order and is idempotent under a second disposal', async () => {
  const order: string[] = [],
    scope = createScope();
  scope.defer('first', () => {
    order.push('first');
  });
  scope.defer('second', () => {
    order.push('second');
  });
  await scope.dispose();
  await scope.dispose();
  expect(order).toEqual(['second', 'first']);
  expect(scope.disposed).toBe(true);
});

it('releases everything acquired before setup threw', async () => {
  const released: string[] = [];
  await expect(
    withScope(async (scope) => {
      await scope.use(
        'store',
        () => 'store',
        (value) => {
          released.push(value);
        },
      );
      await scope.use(
        'listener',
        () => {
          throw new Error('bind refused');
        },
        () => {
          released.push('listener');
        },
      );
    }),
  ).rejects.toThrow('bind refused');
  expect(released).toEqual(['store']);
});

it('registers nothing when the acquisition itself fails', async () => {
  const scope = createScope();
  await expect(
    scope.use(
      'store',
      () => {
        throw new Error('no');
      },
      () => {
        throw new Error('released a value that was never acquired');
      },
    ),
  ).rejects.toThrow('no');
  await expect(scope.dispose()).resolves.toBeUndefined();
});

it('keeps unwinding past a throwing release and reports every failure', async () => {
  const released: string[] = [],
    scope = createScope();
  scope.defer('outer', () => {
    released.push('outer');
  });
  scope.defer('middle', () => {
    throw new Error('close refused');
  });
  scope.defer('inner', () => {
    released.push('inner');
  });
  await expect(scope.dispose()).rejects.toBeInstanceOf(ResourceTeardownError);
  expect(released).toEqual(['inner', 'outer']);
  expect(scope.teardownFailures.map((failure) => failure.label)).toEqual(['middle']);
});

it('keeps the primary failure and carries teardown diagnostics alongside it', async () => {
  const error = await withScope(async (scope) => {
    scope.defer('listener', () => {
      throw new Error('close refused');
    });
    throw new Error('the assertion failed');
  }).catch((value: unknown) => value as Error & { teardownFailures?: readonly { label: string }[] });
  expect(error.message).toBe('the assertion failed');
  expect(error.teardownFailures?.map((failure) => failure.label)).toEqual(['listener']);
});

it('surfaces a teardown failure when the body itself succeeded', async () => {
  await expect(
    withScope((scope) => {
      scope.defer('store', () => {
        throw new Error('close refused');
      });
    }),
  ).rejects.toBeInstanceOf(ResourceTeardownError);
});

it('bounds a release that never settles instead of hanging the suite', async () => {
  const scope = createScope({ releaseTimeoutMs: 25 });
  scope.defer(
    'hung',
    () =>
      new Promise(() => {
        /* never settles */
      }),
  );
  await expect(scope.dispose()).rejects.toThrow(/Resource teardown failed: hung/);
  expect(String(scope.teardownFailures[0]?.error)).toContain('exceeded 25ms');
});

it('aborts owned work before the first release runs', async () => {
  const observed: string[] = [],
    scope = createScope();
  scope.signal.addEventListener('abort', () => {
    observed.push('aborted');
  });
  scope.defer('release', () => {
    observed.push('released');
  });
  await scope.dispose();
  expect(observed).toEqual(['aborted', 'released']);
});

it('refuses registration on a disposed scope', async () => {
  const scope = createScope();
  await scope.dispose();
  expect(() => scope.defer('late', () => undefined)).toThrow(/disposed scope/);
  await expect(
    scope.use(
      'late',
      () => 1,
      () => undefined,
    ),
  ).rejects.toThrow(/disposed scope/);
});

it('disposes through the asynchronous disposal protocol', async () => {
  const released: string[] = [],
    scope = createScope();
  scope.defer('value', () => {
    released.push('value');
  });
  await scope[Symbol.asyncDispose]();
  expect(released).toEqual(['value']);
});
