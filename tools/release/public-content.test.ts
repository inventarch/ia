import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { contentFindings, scanContent, validateContentPolicy } from './public/content-scan.mjs';

const root = resolve(import.meta.dirname, '../..');

it('keeps personal address and local-path refusals under public membership policy', () => {
  const policy = JSON.parse(readFileSync(resolve(root, 'tools/distribution/public-content-policy.json'), 'utf8'));
  expect(() => validateContentPolicy(policy)).not.toThrow();
  const outputs = new Map([
    [
      'packages/language/README.md',
      { bytes: Buffer.from(['person', 'unlisted.dev'].join('@') + ' and /' + 'home/person/private.txt') },
    ],
  ]);
  expect(
    contentFindings(outputs, policy)
      .map((row) => row.rule)
      .sort(),
  ).toEqual(['email', 'local-path']);
  expect(() => scanContent(outputs, policy)).toThrow(/private-content leak/);
  expect(() =>
    validateContentPolicy({ ...policy, packageNames: [{ root: 'apps/cli', name: '@inventarch/cli' }] }),
  ).toThrow(/invalid public package owner/);
});

interface Pin {
  readonly words: number;
  readonly length: number;
  readonly sha256: string;
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/**
 * Names of planning documents, decisions, milestones, plan tasks and repositories kept outside this public repository,
 * pinned by word count, length and the SHA-256 of their lowercase spelling, as content-scan pins its denied tokens, so
 * this file does not list them. A tracked file that cites one points its readers at material they cannot open: state
 * the rule, or cite the public SPEC clause that states it, instead.
 */
const PRIVATE_REFERENCES: readonly Pin[] = [
  { words: 3, length: 23, sha256: '193ec15baf8a62057fe1a3fa4712bfb2b86d54936d36c3aa410d7fdd0fc9bf49' },
  { words: 2, length: 13, sha256: 'c99493c61e8b9b6565ffc59643a0a74f6ea61f26a23718ed4255a7e7fdf028d6' },
  { words: 4, length: 33, sha256: '6828cf9c6c4f10c82561f2f64e2e96144310c741dbef2b9f24fb38322e8013dc' },
  { words: 3, length: 18, sha256: '642ae76c673fccd0861647434ce6f4af053cc400bc33ad41380588acf7b4a00a' },
  { words: 2, length: 18, sha256: '2cbc479e3a8b88a29db6b060b5b0c62bf24c5ef4319ac5ebf2cdfc8f2b7788be' },
  { words: 3, length: 14, sha256: 'e085df2edaa1d9aaff51227326c729ddd32f8f89994d2026cd861d8c64633cf6' },
  { words: 3, length: 22, sha256: 'b8c6c2af5353d536df5f7b4505cc0ea67d0ef1b1eadb8a8f6cb8ad12c6784fcc' },
  { words: 3, length: 27, sha256: '35cfd2781acad476378489b6f21efc3718e1f817fa599f6f6d5dde6f241656c2' },
  { words: 3, length: 19, sha256: 'a42529b53da23a2c822a2e86a71ad556bc33442e4e90248b6fce304c0cf5bd8b' },
  { words: 3, length: 21, sha256: '75272d3e264093b0c8c8780a3172f79aebfebdd54a46f9a4b0dcb9ac92d80731' },
  { words: 3, length: 25, sha256: '7c035df88e629c6e2299b2a164b5cd1321ceaff8d3255c7ab76d49af80c1259c' },
  { words: 3, length: 19, sha256: '6e1e2ad38658390a68ac218a1b022583c3bcc0d8824c31af62a7815641d590aa' },
  { words: 3, length: 18, sha256: '822411690b9f6941abb16e934ea947a5538d2292b25cc60e93ae9a05b93e8503' },
  { words: 4, length: 20, sha256: '5a02ffc9c2073a1535abe653f6a384255edaf20cf665157fffb8065844ec973d' },
  { words: 5, length: 32, sha256: '948f29aa2597671d5fe3d9c3a5d8eae96a5dc0c0de5a9f1e0fb34fdedaa25ec2' },
  { words: 2, length: 18, sha256: '086a5b3badf8907ee40baf11d3b63d23734693749e768318ff2d288022971c35' },
  { words: 3, length: 25, sha256: 'a841c812fa3145d969fc897ca81c9f113836e4de35e790f711a80f4088d29fdc' },
  { words: 2, length: 17, sha256: '966a0648c48caf79af319c11cba8dedd0d63b491cfb17b76258ac616f1651c17' },
  { words: 4, length: 27, sha256: '5dc10e0a7870ff8c4d69fcfaa3588cc0608e178ae80261b55ced2004d23504c9' },
  { words: 4, length: 28, sha256: '214df7739c55e5e9a9437f868c121fb48731c65beaef6b9f6072b118d769b813' },
  { words: 4, length: 29, sha256: '2dbd757de275554086825abcb1e6c43cc0ed89180e2cc5c53dcd1addca88b9a1' },
  { words: 4, length: 26, sha256: '5f72d866fbacd3428b78acbd98af9d615b5d002349be0ca623104e219bdb1b94' },
  { words: 3, length: 15, sha256: '2351bcf8a7af3dd2c663b3875265403043a3a9a01f8bbebaff40c99a0b9d9d0c' },
  { words: 3, length: 12, sha256: '830d66124af4270a4044bd8f26d23943c1df3184d15d7b25c3720f712520cd62' },
  { words: 3, length: 16, sha256: '99f481b8c26fc417efed66129deb7999a99283924beca1f4f4eb6bba1ab425d7' },
  { words: 3, length: 12, sha256: '0d214d8acbac4cafe4bdaae81da36b369f85a69edb04b078fc0cd6388196361a' },
  { words: 3, length: 15, sha256: 'afdec8d0f0e74fa48b19f8f927ec4614f251d775248956362bb7ecdcba392ea1' },
  { words: 3, length: 23, sha256: '4d1320ffd542758a2fd4a60a962abf8edce072bf5f805e0ca5716c2537710438' },
  { words: 3, length: 17, sha256: 'c40752e1af852e7eb0e08ece3a2831b595f8bc35acecf4f9c8d85bf647e11fa4' },
  { words: 3, length: 18, sha256: 'd2faeb7e87822baa3c04a728bb4835bc8d5aea38b481cbf545eefa73cfa90c42' },
  { words: 3, length: 22, sha256: 'af2e98fddbdc7dff7edc74334e2bbca6f029a89c28172e91058e94d2677c4e6f' },
  { words: 3, length: 25, sha256: 'fe4c0f71c9c8525dd04877dfcf1c5ede3087c3857c1046534aa4aefd7874d292' },
  { words: 3, length: 24, sha256: 'de9cbef8d52eaafcc074676ab50dadf7d24f3db4dbd6d39721cff47295a42620' },
  { words: 3, length: 26, sha256: 'b8446695fc3ce4ad2ebea93e92abae99019434a7b69a8bdf5b57463235203f55' },
  { words: 3, length: 28, sha256: 'c8aa763e7818064f3b00a1c145664930dc775d5b14a6f55c04267ba68b45b792' },
  { words: 3, length: 22, sha256: '043a07ae33f0f1957ee6059fc021945c8432532010da9bef3884bd363b0fd746' },
  { words: 5, length: 25, sha256: 'e9eb5d958a4645dd97330c61edef7d1a7aac9457dcd8ce188e0d22c2245b0ef8' },
  { words: 2, length: 7, sha256: '22474d1de2a09f13f7c9b06e7d187fd834ba02f2a8a9457643aa4a518e69aa6e' },
  { words: 2, length: 9, sha256: '4a9fb7a9344cbe896a9b53072daa8562e329372be4f3a2a6afbd12f190d37f86' },
  { words: 2, length: 9, sha256: '7efa7c287f533025fa7ccdbafd13de749103d78f924445bf8fd62b24c3108ef9' },
  { words: 2, length: 9, sha256: 'a0a1146206c1be0531b209237cd5a7645140ac0333e80519f89f20c994e3c721' },
  { words: 2, length: 9, sha256: '80ffa34bf0ab27c650272b557cdb4077bfc6f0dbaacb94a3fea2a67a49783694' },
  { words: 2, length: 9, sha256: '63bb155f4e8b0363d1f39d8fcdc49f7fbc103b979ae1df74bee0124e01919ea5' },
];
/** Phrasing that points at a private knowledge base's tasks or decisions, whatever their names. */
const PRIVATE_PHRASE = /\bkb[ -](?:task|decision|plan|spec|document)s?\b/gi;
/**
 * Ids that only planning material kept outside this repository defines: a plan's amendments and their letters, the
 * rows, items and sections of a design document, review-finding ids, operator design rows, review notes and milestone
 * numbers. Public clause ids (R19, D08b, C31, G06c, W02, db PT5), the sections of the documents under docs/specs,
 * issue and pull request numbers and commit shas match none of them. Each is spelled so that this file does not match.
 */
const PLANNING_IDS: readonly RegExp[] = [
  /\bplan[ ]amendments?\b/gi,
  /\bamendments?[ ][A-C]\d{1,2}\b/gi,
  /\bdesign[ ](?:rows?|items?)[ ]\d+/gi,
  /\bdesign[ ]§/gi,
  /\b[A-H]\d?-(?:RC|R|N)\d{1,2}\b/g,
  /\bOD\d\b/g,
  /\bIM-\d+\b/g,
  /\bM\d\.\d\b/g,
  // Issues and pull requests of the predecessor repository, which this one's numbering has not reached: written bare,
  // they would resolve to unrelated items here, so each is cited as crowncodes/ia#N.
  /(?<![\w/.-])#(?:274|315|317|323|398|436|438|443|444|445|447|474|479|491|524)\b/g,
];
/** Published release history is immutable: a consumed changeset and the changelog generated from it keep their bytes. */
const IMMUTABLE = (path: string): boolean => path === 'CHANGELOG.md' || path.startsWith('releases/changesets/');
/**
 * Files that still carry references only a release of their own can remove, with how many each holds: the
 * authoring-system SPEC is packed into that system's native archive, and doctor prints its legacy-home warning. The
 * release that rewrites the text drops the row; any other reference, or a changed count, fails.
 */
const AWAITING_RELEASE: ReadonlyMap<string, number> = new Map([
  ['.ia/src/systems/authoring-system/SPEC.md', 2],
  ['apps/cli/src/doctor.ts', 1],
]);

/** Each private reference in `files` (path to text), as `path:line`. */
function privateReferences(
  files: ReadonlyMap<string, string>,
  pins: readonly Pin[],
  publicPackages: ReadonlySet<string> = new Set(),
): string[] {
  const widest = Math.max(...pins.map((pin) => pin.words)),
    pinned = new Map<string, Set<string>>(),
    found: string[] = [];
  for (const pin of pins) {
    const key = `${pin.words}:${pin.length}`;
    pinned.set(key, (pinned.get(key) ?? new Set()).add(pin.sha256));
  }
  for (const [path, text] of files) {
    const at = (index: number): string => `${path}:${text.slice(0, index).split('\n').length}`;
    for (const phrase of text.matchAll(PRIVATE_PHRASE)) found.push(at(phrase.index));
    const words = [...text.matchAll(/\b\w+\b/g)];
    for (let index = 0; index < words.length; index++)
      for (let width = 1; width <= widest && index + width <= words.length; width++) {
        const start = words[index]!.index,
          last = words[index + width - 1]!,
          length = last.index + last[0].length - start,
          hashes = pinned.get(`${width}:${length}`);
        const spelling = text.slice(start, start + length);
        // A declared scoped npm package is public; the same bare repository path remains denied.
        const publicPackage =
          text[start - 1] === '@' &&
          !/[\w@.+-]/.test(text[start - 2] ?? '') &&
          !/[\w.-]/.test(text[start + length] ?? '') &&
          publicPackages.has('@' + spelling);
        if (!publicPackage && hashes?.has(sha256(spelling.toLowerCase()))) found.push(at(start));
      }
  }
  return found;
}

/** Each planning id in `files` (path to text), as `path:line id`, in file order. */
function planningIds(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [path, text] of files)
    for (const match of PLANNING_IDS.flatMap((pattern) => [...text.matchAll(pattern)]).sort(
      (a, b) => a.index - b.index,
    ))
      found.push(`${path}:${text.slice(0, match.index).split('\n').length} ${match[0]}`);
  return found;
}

it('finds a pinned name in any case and a knowledge-base pointer, by line', () => {
  const name = 'sample-planning-note',
    pin = { words: 3, length: name.length, sha256: sha256(name) },
    files = new Map([
      ['a.md', 'intro\nsee Sample-Planning-Note §3 and the sample planning note\n'],
      ['b.ts', ['// as the KB', 'task names it\n'].join(' ')],
      ['c.md', 'roughly 360 KB of payload\n'],
    ]);
  expect(privateReferences(files, [pin])).toEqual(['a.md:2', 'b.ts:1']);
});

it('allows exact declared scoped npm tokens while retaining bare repository and URL refusals', () => {
  const name = 'sample/knowledge',
    pin = { words: 2, length: name.length, sha256: sha256(name) },
    files = new Map([
      ['public.ts', `import '@${name}'; import '@${name}/protocol';`],
      ['private.md', `${name}\nhttps://github.com/${name}\n@${name}-private\nuser@${name}\nuser+@${name}`],
    ]);
  expect(privateReferences(files, [pin], new Set(['@' + name]))).toEqual([
    'private.md:1',
    'private.md:2',
    'private.md:3',
    'private.md:4',
    'private.md:5',
  ]);
  expect(privateReferences(new Map([['unlisted.ts', `import '@${name}';`]]), [pin])).toEqual(['unlisted.ts:1']);
});

it('finds every knowledge-base pointer in each file', () => {
  const files = new Map([
    ['a.md', [['KB', 'task'].join(' '), ['kb', 'decision'].join(' ')].join('\n')],
    ['b.md', ['Kb', 'plan'].join(' ')],
  ]);
  expect(privateReferences(files, [])).toEqual(['a.md:1', 'a.md:2', 'b.md:1']);
});

it('finds planning ids by line and leaves public clause ids, sections and numbers alone', () => {
  // Joined at run time so that this file holds none of the ids it looks for.
  const ids = [
      ['Plan amend', 'ments'],
      ['amendment ', 'C13'],
      ['design row ', '27'],
      ['design item ', '12'],
      ['Design ', '§'],
      ['B2-', 'RC1'],
      ['D-', 'N4'],
      ['O', 'D4'],
      ['IM', '-43'],
      ['M5', '.1'],
      ['#', '315'],
    ].map((parts) => parts.join('')),
    files = new Map([
      ['a.md', `intro\nsee ${ids.join(', ')} and §2.3\n`],
      [
        'b.md',
        'runtime R19, db D08b and PT5, compliance C31, graph G06c, W02, B11, #43, e83a5dd, IA-PT9-ROW-MISSING,\n' +
          'COMP-FIELD, host plugin distribution spec §6.1, the registry spec §5.1, @milestone M1, milestone 1, A-1,\n' +
          'crowncodes/ia#315, #000, #123456\n',
      ],
    ]);
  expect(planningIds(files)).toEqual(ids.map((id) => `a.md:2 ${id}`));
});

it('keeps tracked files free of pointers to private planning material', () => {
  const files = new Map<string, string>();
  for (const path of execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0')
    .filter((path) => path && !IMMUTABLE(path))) {
    const bytes = readFileSync(resolve(root, path));
    if (!bytes.includes(0)) files.set(path, bytes.toString('utf8'));
  }
  expect(files.size).toBeGreaterThan(1000);
  const policy = JSON.parse(readFileSync(resolve(root, 'tools/distribution/public-content-policy.json'), 'utf8'));
  validateContentPolicy(policy);
  const publicPackages = new Set<string>(
    policy.packageNames.filter((row: { private: boolean }) => !row.private).map((row: { name: string }) => row.name),
  );
  const found = [...privateReferences(files, PRIVATE_REFERENCES, publicPackages), ...planningIds(files)],
    pathOf = (row: string): string => row.slice(0, row.indexOf(':'));
  expect(found.filter((row) => !AWAITING_RELEASE.has(pathOf(row)))).toEqual([]);
  for (const [path, count] of AWAITING_RELEASE)
    expect(
      found.filter((row) => pathOf(row) === path),
      path,
    ).toHaveLength(count);
});
