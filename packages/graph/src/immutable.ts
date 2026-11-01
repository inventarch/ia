/**
 * Read-only views with inaccessible backing storage; Object.freeze(Map) alone is insufficient. One class holds each view's
 * methods, so a view costs its backing store and no more: a graph holds a view per posting of its text index. A method
 * reads its receiver, so one taken off a view throws until it is called on one, and the shared prototypes are frozen.
 */
class ReadonlyMapView<K, V> {
  #backing: Map<K, V>;
  constructor(backing: Map<K, V>) {
    this.#backing = backing;
    Object.freeze(this);
  }
  get size(): number {
    return this.#backing.size;
  }
  get(key: K): V | undefined {
    return this.#backing.get(key);
  }
  has(key: K): boolean {
    return this.#backing.has(key);
  }
  entries(): MapIterator<[K, V]> {
    return this.#backing.entries();
  }
  keys(): MapIterator<K> {
    return this.#backing.keys();
  }
  values(): MapIterator<V> {
    return this.#backing.values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#backing.entries();
  }
  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#backing.forEach((value, key) => callback.call(thisArg, value, key, this as unknown as ReadonlyMap<K, V>));
  }
}
class ReadonlySetView<T> {
  #backing: Set<T>;
  constructor(backing: Set<T>) {
    this.#backing = backing;
    Object.freeze(this);
  }
  get size(): number {
    return this.#backing.size;
  }
  has(value: T): boolean {
    return this.#backing.has(value);
  }
  entries(): SetIterator<[T, T]> {
    return this.#backing.entries();
  }
  keys(): SetIterator<T> {
    return this.#backing.keys();
  }
  values(): SetIterator<T> {
    return this.#backing.values();
  }
  [Symbol.iterator](): SetIterator<T> {
    return this.#backing.values();
  }
  forEach(callback: (value: T, second: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.#backing.forEach((value) => callback.call(thisArg, value, value, this as unknown as ReadonlySet<T>));
  }
}
// A view is a Map or Set to `instanceof` and has none of their writing methods.
Object.setPrototypeOf(ReadonlyMapView.prototype, Map.prototype);
Object.setPrototypeOf(ReadonlySetView.prototype, Set.prototype);
for (const [prototype, names] of [
  [ReadonlyMapView.prototype, ['set', 'delete', 'clear']],
  [ReadonlySetView.prototype, ['add', 'delete', 'clear']],
] as const)
  for (const name of names) Object.defineProperty(prototype, name, { value: undefined });
Object.freeze(ReadonlyMapView.prototype);
Object.freeze(ReadonlySetView.prototype);
export function readonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new ReadonlyMapView(new Map(entries)) as unknown as ReadonlyMap<K, V>;
}
export function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  return new ReadonlySetView(new Set(values)) as unknown as ReadonlySet<T>;
}
const held = new WeakSet<object>();
/** Marks a value `snapshot` made or a frozen tree like one, so that one thing several lists hold stays one. */
export function hold<T extends object>(value: T): T {
  held.add(value);
  return value;
}
/**
 * A deep frozen copy of `value`. Nothing can change it, so what is derived from it can be kept: `load` and the revisions
 * remember what they made of such a value, and of no other, however many times they are given it.
 */
export function frozen<T extends object>(value: T): T {
  return hold(snapshot(value));
}
export const isFrozen = (value: object): boolean => held.has(value);
/** Only structured record data belongs here: no Date, function, resource or class instances. */
export function snapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object' && held.has(value)) return value;
  if (value instanceof Map) return readonlyMap([...value].map(([k, v]) => [snapshot(k), snapshot(v)])) as T;
  if (value instanceof Set) return readonlySet([...value].map(snapshot)) as T;
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot)) as T;
  if (value !== null && typeof value === 'object')
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)]))) as T;
  return value;
}
