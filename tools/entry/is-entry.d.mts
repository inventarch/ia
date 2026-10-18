// Generated from checked JavaScript; run node tools/testing/check-declarations.mjs --write.
/**
 * Whether the module at `moduleUrl` is the process entry named by `argv1`: a tool calls it with `process.argv[1]` and
 * `import.meta.url`. It is the same function as `isEntry` in `@inventarch/runtime/entry`, kept here without dependencies so a
 * tool that imports it hashes one more file rather than the runtime's closure. Node loads an entry from its real path,
 * so the path as invoked is compared first and real paths only when it misses. Only a path that names no file (missing,
 * through a file, or a name too long) means "not the entry"; any other failure to resolve one throws rather than letting
 * a tool exit 0 having done nothing.
 * @param {string | undefined} argv1
 * @param {string} moduleUrl
 * @returns {boolean}
 */
export function isEntry(argv1: string | undefined, moduleUrl: string): boolean;
