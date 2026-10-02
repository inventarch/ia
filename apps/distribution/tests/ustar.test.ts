import { createHash } from 'node:crypto';
import { constants, gunzipSync, gzipSync } from 'node:zlib';
import type { ZlibOptions } from 'node:zlib';
import { expect, it } from 'vitest';
import { HOST_TREE_LIMITS, inflateCanonical, packTree, unpackTree } from '../src/ustar.js';
import { entries } from './tar-entries.js';

// A tar inside the recipe's envelope (level 9, OS 255), so a refusal comes from the check it names rather than the envelope.
const wrap = (bytes: Buffer, options: ZlibOptions = { level: 9 }): Buffer => {
  const out = gzipSync(bytes, options);
  out[9] = 255;
  return out;
};
const tree = () =>
  new Map<string, Buffer>([
    ['runtime/node_modules/@ia/cli/dist/main.js', Buffer.from('export {};\n')],
    ['a/' + 'b'.repeat(120) + '/c.txt', Buffer.from('long path\n')],
    ['release.json', Buffer.from('{}\n')],
  ]);
it('packs deterministically and round-trips every file', () => {
  const first = packTree(tree(), HOST_TREE_LIMITS),
    second = packTree(new Map([...tree()].reverse()), HOST_TREE_LIMITS);
  expect(first.equals(second)).toBe(true);
  expect(first[9]).toBe(255);
  const back = unpackTree(first, HOST_TREE_LIMITS);
  expect([...back.keys()].sort()).toEqual([...tree().keys()].sort());
  for (const [path, bytes] of tree()) expect(back.get(path)!.equals(bytes)).toBe(true);
});
it('refuses non-canonical bytes, oversized trees and unsafe paths', () => {
  const packed = packTree(tree(), HOST_TREE_LIMITS),
    tar = gunzipSync(packed);
  tar[0] = 0x58; // corrupt the first header name
  expect(() => unpackTree(wrap(tar), HOST_TREE_LIMITS)).toThrow(/checksum/);
  expect(() => packTree(tree(), { ...HOST_TREE_LIMITS, files: 2 })).toThrow(/file count/);
  expect(() => packTree(new Map([['../escape', Buffer.from('x')]]), HOST_TREE_LIMITS)).toThrow(/Unsafe/);
});
it('accepts the canonical tree whichever zlib compressed it, and refuses any other envelope', () => {
  const packed = packTree(tree(), HOST_TREE_LIMITS),
    tar = gunzipSync(packed);
  // Another zlib build (Homebrew's Node links the system zlib) encodes the same tar differently.
  for (const options of [{ level: 6 }, { level: 9, strategy: constants.Z_FILTERED }, { level: 1, memLevel: 1 }]) {
    const other = wrap(tar, options);
    expect(other.equals(packed)).toBe(false);
    const back = unpackTree(other, HOST_TREE_LIMITS);
    for (const [path, bytes] of tree()) expect(back.get(path)!.equals(bytes)).toBe(true);
  }
  const refused = (bytes: Buffer): void => {
    expect(() => unpackTree(bytes, HOST_TREE_LIMITS)).toThrow(/canonical/);
  };
  refused(gzipSync(tar, { level: 9 })); // the OS byte is not 255
  const text = Buffer.from(packed);
  text[3] = 1;
  refused(text); // FTEXT set
  const stamped = Buffer.from(packed);
  stamped[4] = 1;
  refused(stamped); // nonzero mtime
  for (const xfl of [1, 3, 0x42]) {
    const extra = Buffer.from(packed);
    extra[8] = xfl;
    refused(extra);
  } // XFL values zlib never writes
  for (const xfl of [0, 2, 4]) {
    const written = Buffer.from(packed);
    written[8] = xfl;
    expect(unpackTree(written, HOST_TREE_LIMITS).size).toBe(tree().size);
  } // the three it does
  refused(Buffer.concat([wrap(Buffer.alloc(0), { level: 9 }), packed])); // an empty member before the tree
  refused(Buffer.concat([packed, wrap(Buffer.alloc(0), { level: 9 })])); // an empty member after it
  refused(Buffer.concat([packed, Buffer.from([0])])); // a trailing byte
  // A trailer that disagrees with what the stream inflates to is corrupt rather than another encoding.
  for (const at of [8, 4]) {
    const trailer = Buffer.from(packed);
    trailer[trailer.length - at] = trailer[trailer.length - at]! ^ 1;
    expect(() => unpackTree(trailer, HOST_TREE_LIMITS)).toThrow(/Invalid or oversized compressed tree/);
  }
  // Inside the recipe's envelope, the tree must still be the one canonical USTAR.
  refused(wrap(Buffer.concat([...entries(tar).reverse(), Buffer.alloc(1024)]), { level: 9 })); // the entries in another order
  const padded = Buffer.from(tar);
  padded[512 + 10] = 1;
  refused(wrap(padded, { level: 9 })); // a nonzero padding byte after the first file
  refused(wrap(Buffer.concat([tar, Buffer.alloc(512, 0x41)]), { level: 9 })); // a block after the end-of-archive marker
});
it("inflates the envelope once, stopping at the caller's bound", () => {
  const packed = packTree(new Map([['zeros.bin', Buffer.alloc(1024 * 1024)]]), HOST_TREE_LIMITS);
  const refusals = { invalid: 'invalid bytes', outside: 'outside the recipe' };
  expect(inflateCanonical(packed, HOST_TREE_LIMITS.expanded, refusals).equals(gunzipSync(packed))).toBe(true);
  expect(() => inflateCanonical(packed, 64 * 1024, refusals)).toThrow('invalid bytes');
});
// Real output of another zlib build: Homebrew's Node 25.9.0 (system zlib 1.2.12) packed this three-file tree.
const ZLIB_1_2_12_TREE =
  'H4sIAAAAAAAC/+3UTQqDMBAF4Kw9hScwiX9ddNObSKqhTYmJmBEE8e5NuykVuihUxTrfZh5ZJNm8KSPogcyLeXmaPqc3nYzx+JUf50nOY05CRhbQORCtf/7X9wp6XslX39TWXMJGwDUgaIdaqaVwMro5a1brP0ve+89ZnG29/xsxjFj8Xfe/M6BqSY2tZFHbqtPS0ZMStNSKVsoBrYUyfj3M13/O0nzS/yw7JNj/Jci+sS2Ew3gMMGL8EHFPIoTQv7kDnzmMewASAAA=';
it('unpacks a tree that zlib 1.2.12 compressed', () => {
  const bytes = Buffer.from(ZLIB_1_2_12_TREE, 'base64');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '4dc483bed326a2758ba00c8e273705bcb990efa78f654235d877834a2c54b13f',
  );
  const back = unpackTree(bytes, HOST_TREE_LIMITS);
  expect(Object.fromEntries([...back].map(([path, content]) => [path, content.toString()]))).toEqual({
    'runtime/node_modules/@ia/cli/dist/main.js': 'export {};\n'.repeat(50),
    ['a/' + 'b'.repeat(120) + '/c.txt']: 'long path\n',
    'release.json': '{}\n',
  });
});
it('refuses case-fold collisions, per-file overflow and invalid epochs', () => {
  expect(() =>
    packTree(
      new Map([
        ['A.txt', Buffer.from('x')],
        ['a.txt', Buffer.from('y')],
      ]),
      HOST_TREE_LIMITS,
    ),
  ).toThrow(/collide/);
  expect(() => packTree(tree(), { ...HOST_TREE_LIMITS, file: 1 })).toThrow(/exceeds its bound/);
  expect(() => packTree(tree(), HOST_TREE_LIMITS, -1)).toThrow(/epoch/);
});
