/** Read-only views with inaccessible backing storage; Object.freeze(Map) alone is insufficient. */
export function readonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const backing = new Map(entries);
  const view = Object.create(Map.prototype) as ReadonlyMap<K, V>;
  Object.defineProperties(view, {
    size: { get: () => backing.size },
    get: { value: (key: K) => backing.get(key) },
    has: { value: (key: K) => backing.has(key) },
    entries: { value: () => backing.entries() },
    keys: { value: () => backing.keys() },
    values: { value: () => backing.values() },
    [Symbol.iterator]: { value: () => backing.entries() },
    forEach: {
      value: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) =>
        backing.forEach((value, key) => callback.call(thisArg, value, key, view)),
    },
    set: { value: undefined },
    delete: { value: undefined },
    clear: { value: undefined },
  });
  return Object.freeze(view);
}
export function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const backing = new Set(values);
  const view = Object.create(Set.prototype) as ReadonlySet<T>;
  Object.defineProperties(view, {
    size: { get: () => backing.size },
    has: { value: (value: T) => backing.has(value) },
    entries: { value: () => backing.entries() },
    keys: { value: () => backing.keys() },
    values: { value: () => backing.values() },
    [Symbol.iterator]: { value: () => backing.values() },
    forEach: {
      value: (callback: (value: T, second: T, set: ReadonlySet<T>) => void, thisArg?: unknown) =>
        backing.forEach((value) => callback.call(thisArg, value, value, view)),
    },
    add: { value: undefined },
    delete: { value: undefined },
    clear: { value: undefined },
  });
  return Object.freeze(view);
}
/** Only structured record data belongs here: no Date, function, resource or class instances. */
export function snapshot<T>(value: T): T {
  if (value instanceof Map) return readonlyMap([...value].map(([k, v]) => [snapshot(k), snapshot(v)])) as T;
  if (value instanceof Set) return readonlySet([...value].map(snapshot)) as T;
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot)) as T;
  if (value !== null && typeof value === 'object')
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)]))) as T;
  return value;
}
