import { expect, it } from 'vitest';
import { createLocalStoreAdapter, verifyStoreBinding } from '../src/local-store.js';
import { metadataDigest } from '../src/resource-format.js';
import { adapterFixture } from './adapter-fixture.js';

it('binds retained storage to exact owner/root/schema/policy/quotas and installed adapter identity', () => {
  const f = adapterFixture();
  expect(verifyStoreBinding(f.binding, f.adapter)).toEqual(f.binding);
  for (const mutate of [
    (value: typeof f.binding) => {
      value.quotas.indexBatch = 101;
    },
    (value: typeof f.binding) => {
      value.rootBinding = 'C:/untrusted';
    },
    (value: typeof f.binding) => {
      value.adapterDigest = metadataDigest('other');
    },
  ]) {
    const value = structuredClone(f.binding);
    mutate(value);
    const { digest: _digest, ...body } = value;
    value.digest = metadataDigest(body);
    expect(() => verifyStoreBinding(value, f.adapter)).toThrow();
  }
});

it('snapshots input before authorization and checks current binding before retaining or publishing a result', async () => {
  const f = adapterFixture();
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapters = createLocalStoreAdapter(f.binding, {
    adapter: f.adapter,
    catalog: f.catalog,
    current: async () => ({ binding: f.binding, adapter: f.adapter, catalog: f.catalog }),
    authorize: async () => {
      await gate;
    },
    storage: {
      execute: async (_binding, _operation, input) => {
        calls++;
        expect(input).toEqual({ text: 'original' });
        return { output: { receipt: 'stored' }, effect: 'applied' };
      },
    },
  });
  const input = { text: 'original' },
    pending = adapters['retained-ingest']!.execute(input, f.context);
  input.text = 'changed';
  release();
  expect(await pending).toEqual({ output: { receipt: 'stored' }, effect: 'applied' });
  expect(calls).toBe(1);
  f.binding.accessPolicy = 'changed-policy';
  await expect(adapters['retained-ingest']!.execute({ text: 'original' }, f.context)).rejects.toThrow();
  expect(calls).toBe(1);
});

it('bounds noncooperating storage and refuses late output without claiming that a timed-out write rolled back', async () => {
  const f = adapterFixture();
  const adapters = createLocalStoreAdapter(f.binding, {
    adapter: f.adapter,
    catalog: f.catalog,
    current: async () => ({ binding: f.binding, adapter: f.adapter, catalog: f.catalog }),
    authorize: async () => {},
    storage: { execute: async () => new Promise(() => {}) },
  });
  await expect(adapters['retained-ingest']!.execute({ text: 'bounded' }, f.context)).rejects.toThrow();
});

it('preserves the current engine grant when its fencing callback narrows authority', async () => {
  const f = adapterFixture();
  f.context.assertCurrent = async () => {
    f.context.grant = { ...f.context.grant, id: 'narrowed-current-grant' };
  };
  const adapters = createLocalStoreAdapter(f.binding, {
    adapter: f.adapter,
    catalog: f.catalog,
    current: async () => ({ binding: f.binding, adapter: f.adapter, catalog: f.catalog }),
    authorize: async () => {},
    storage: {
      execute: async (_binding, _operation, _input, context) => {
        expect(context.grant.id).toBe('narrowed-current-grant');
        return { output: { receipt: 'stored' }, effect: 'applied' };
      },
    },
  });
  await adapters['retained-ingest']!.execute({ text: 'bounded' }, f.context);
});

it('counts the complete effect output envelope in its installed output bound', async () => {
  const f = adapterFixture();
  const adapters = createLocalStoreAdapter(f.binding, {
    adapter: f.adapter,
    catalog: f.catalog,
    current: async () => ({ binding: f.binding, adapter: f.adapter, catalog: f.catalog }),
    authorize: async () => {},
    storage: { execute: async () => ({ output: { receipt: 'x'.repeat(2020) }, effect: 'applied' }) },
  });
  await expect(adapters['retained-ingest']!.execute({ text: 'bounded' }, f.context)).rejects.toThrow(
    'complete byte bound',
  );
});

it('holds the concurrency slot after timeout until the underlying uncooperative invocation settles', async () => {
  const f = adapterFixture();
  let release!: () => void,
    calls = 0;
  const adapters = createLocalStoreAdapter(f.binding, {
    adapter: f.adapter,
    catalog: f.catalog,
    current: async () => ({ binding: f.binding, adapter: f.adapter, catalog: f.catalog }),
    authorize: async () => {},
    storage: {
      execute: async () => {
        if (++calls === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { output: { receipt: 'stored' }, effect: 'applied' };
      },
    },
  });
  await expect(adapters['retained-ingest']!.execute({ text: 'first' }, f.context)).rejects.toThrow();
  await expect(adapters['retained-ingest']!.execute({ text: 'overlap' }, f.context)).rejects.toThrow('concurrency');
  expect(calls).toBe(1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await adapters['retained-ingest']!.execute({ text: 'next' }, f.context)).toEqual({
    output: { receipt: 'stored' },
    effect: 'applied',
  });
  expect(calls).toBe(2);
});
