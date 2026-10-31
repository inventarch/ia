// Run by scope.test.ts in a process of its own, under --expose-gc: whether what a refresh replaced can be collected while
// tokens issued before it go on reading, and whether close releases every scope. It prints one JSON line.
import { open } from '../src/index.js';

/** A WeakRef holds its target until the job that made it ends, so a collection has to start in a later one. */
const collect = async (): Promise<void> => {
  await new Promise(setImmediate);
  globalThis.gc!();
};
const db = open(process.argv[2]!, { cache: false });
/** A weak reference to a record the token reads now, and everything it reads, by value. */
const observe = (within: string): { readonly record: WeakRef<object>; readonly digests: string } => {
  const records = db.records({ within });
  return { record: new WeakRef(records[0]!), digests: JSON.stringify(records.map((record) => record.digest)) };
};
const narrowed = db.resolveScope({ identities: [db.records()[0]!.identity] }).token,
  tokens = [db.resolveScope().token, db.resolveScope({ phase: 'act' }).token, narrowed],
  replaced = tokens.map(observe),
  scopes = [new WeakRef(db.resolveScope()), new WeakRef(db.resolveScope({ pinned: true }))];
db.refresh();
const current = new WeakRef(db.records()[0]!);
await collect();
const replacedCollected = replaced.map(({ record }) => record.deref() === undefined),
  currentCollected = current.deref() === undefined,
  tokensRead = tokens.map((within, index) => observe(within).digests === replaced[index]!.digests);
db.close();
await collect();
console.log(
  JSON.stringify({
    replacedCollected,
    currentCollected,
    tokensRead,
    closedCollected: scopes.map((scope) => scope.deref() === undefined),
  }),
);
