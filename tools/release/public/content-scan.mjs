import { createHash } from 'node:crypto';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const DENIED_TOKENS = [
  {
    words: 1,
    length: 6,
    sha256: 'd38681074467c0bc147b17a9a12b9efa8cc10bcf545f5b0bccccf5a93c4a2b79',
  },
  {
    words: 1,
    length: 5,
    sha256: 'a4648bd801fa6560eaee330bbabaf5ecdce8e0417645513cd644e6ed83b4bc56',
  },
  {
    words: 1,
    length: 4,
    sha256: '6177321eac992341d1ad0823a07e76bfc4ee6909db120e377ea303fdc216756c',
  },
  {
    words: 1,
    length: 7,
    sha256: '86a5ea9f6a8dfd5133a3831a513fdc433c9951ca388342acb02f70fe17b54195',
  },
  {
    words: 1,
    length: 10,
    sha256: 'd2f63ae1083fe0418b850e5d6383c6547e40f7a0f789fa42a3c9a92776c9c9d8',
  },
  {
    words: 2,
    length: 6,
    sha256: '99a5f04bd38b09f7cda635938b713dd02dbd80a34502f572bef3936e9a9456c5',
  },
  {
    words: 3,
    length: 15,
    sha256: 'b404475b06b8617324d7807c40b3229eb77c298c00e48218c75179dfd6b7cd4c',
  },
  {
    words: 1,
    length: 9,
    sha256: '2ce1d14038a732cc4f5b3843ce4a30fd38976f5acdea3655d64ac0db71f38097',
  },
];
const normalize = (value) => value.replace(/\\+/g, '/');
const FORMAT = 'ia.public-content-policy.v1';
const fail = (message) => {
  throw new Error('Public safety: ' + message);
};
const safePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('\\') &&
  !value.startsWith('/') &&
  !value.split('/').some((part) => ['', '.', '..'].includes(part));
const digest = (value) => /^[a-f0-9]{64}$/.test(value);
/** Strip private dispositions, literal exception values and reasons. No new exception is inferred. */
export function projectContentPolicy(policy, outputs) {
  const selected = outputs && new Set(outputs.keys());
  const packageNames = policy.packageNames
    .filter((row) => !selected || selected.has(row.root + '/package.json'))
    .map((row) => ({
      root: row.root,
      name: row.name.replace(policy.namespace?.source ?? '@inventarch/', policy.namespace?.public ?? '@inventarch/'),
    }));
  const dependencies = new Set();
  if (outputs)
    for (const owner of packageNames) {
      const manifest = JSON.parse(Buffer.from(outputs.get(owner.root + '/package.json').bytes).toString('utf8'));
      for (const group of ['dependencies', 'optionalDependencies'])
        for (const name of Object.keys(manifest[group] ?? {})) dependencies.add(name);
    }
  const carriers = (policy.embeddedCarriers ?? [])
    .filter((row) => packageNames.some((owner) => row.owner.startsWith(owner.root + '/')))
    .map((row) => ({ owner: row.owner, memberPrefix: row.memberPrefix }));
  const publicPath = (path) => {
    if (!selected || selected.has(path)) return true;
    if (
      packageNames.some((owner) => path.startsWith(owner.root + '/dist/') || path.startsWith(owner.root + '/assets/'))
    )
      return true;
    const dependency = /^runtime\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1];
    return !!dependency && dependencies.has(dependency) && carriers.some((row) => path.startsWith(row.memberPrefix));
  };
  const exceptions = policy.leakExceptions
    .filter((row) => publicPath(row.path))
    .map((row) => ({
      path: row.path,
      rule: row.rule,
      valueSha256: sha(row.value),
      normalizedSha256: sha(normalize(row.value)),
    }));
  const result = { format: FORMAT, packageNames, embeddedCarriers: carriers, exceptions };
  validateContentPolicy(result);
  return result;
}
export function validateContentPolicy(policy) {
  if (
    policy?.format !== FORMAT ||
    !Array.isArray(policy.packageNames) ||
    !Array.isArray(policy.embeddedCarriers) ||
    !Array.isArray(policy.exceptions) ||
    Object.keys(policy).some((key) => !['format', 'packageNames', 'embeddedCarriers', 'exceptions'].includes(key))
  )
    fail('invalid public content policy');
  const keys = new Set();
  for (const row of policy.packageNames)
    if (
      !safePath(row.root) ||
      !/^(?:@inventarch\/)?[a-z][a-z0-9-]*$/.test(row.name) ||
      Object.keys(row).some((key) => !['root', 'name'].includes(key))
    )
      fail('invalid public package owner');
  for (const row of policy.embeddedCarriers)
    if (
      !safePath(row.owner) ||
      !safePath(row.memberPrefix.replace(/\/$/, '')) ||
      Object.keys(row).some((key) => !['owner', 'memberPrefix'].includes(key))
    )
      fail('invalid public embedded carrier');
  for (const row of policy.exceptions) {
    const key = row.path + ':' + row.rule + ':' + row.valueSha256;
    if (
      !safePath(row.path) ||
      !['client-name', 'email', 'local-path', 'private-repository'].includes(row.rule) ||
      !digest(row.valueSha256) ||
      !digest(row.normalizedSha256) ||
      keys.has(key) ||
      Object.keys(row).some((name) => !['path', 'rule', 'valueSha256', 'normalizedSha256'].includes(name))
    )
      fail('invalid public content exception');
    keys.add(key);
  }
}
const reservedEmail = (value) => /@(?:example\.(?:com|org|net)|(?:[\w-]+\.)*(?:test|invalid|example))$/i.test(value);
function clientMatches(body) {
  const words = [...body.matchAll(/\b\w+\b/g)],
    matches = [];
  for (let index = 0; index < words.length; index++)
    for (const width of [1, 2, 3]) {
      const last = words[index + width - 1];
      if (!last) continue;
      const start = words[index].index,
        end = last.index + last[0].length,
        candidates = DENIED_TOKENS.filter((pin) => pin.words === width && pin.length === end - start);
      if (!candidates.length) continue;
      const value = body.slice(start, end);
      if (candidates.some((pin) => pin.sha256 === sha(value.toLowerCase()))) matches.push({ value, index: start });
    }
  return matches;
}
function excepted(path, rule, value, policy, carriers) {
  const exact = (path) =>
    policy.exceptions.some((row) => row.path === path && row.rule === rule && row.valueSha256 === sha(value));
  if (exact(path)) return true;
  let direct = path;
  if (path.includes('!/')) {
    const parts = path.split('!/');
    if (parts.length !== 2 || !carriers.some((row) => parts[0] === row.path && parts[1].startsWith(row.memberPrefix)))
      return false;
    direct = parts[1];
    if (exact(direct)) return true;
  }
  for (const owner of policy.packageNames) {
    const prefix = 'runtime/node_modules/' + owner.name + '/';
    if (direct.startsWith(prefix)) {
      direct = owner.root + '/' + direct.slice(prefix.length);
      break;
    }
  }
  for (const row of policy.exceptions) {
    if (row.rule !== rule) continue;
    const owner = policy.packageNames.find((owner) => row.path.startsWith(owner.root + '/src/'));
    if (!owner) continue;
    const compiled = owner.root + '/dist/' + row.path.slice((owner.root + '/src/').length).replace(/\.ts$/, '');
    if (
      (direct === compiled + '.js' || direct === compiled + '.d.ts') &&
      row.normalizedSha256 === sha(normalize(value))
    )
      return true;
  }
  return false;
}
/** Same matching semantics in private source checks and emitted archive qualification; no sensitive text in refusals. */
export function contentFindings(outputs, policy) {
  validateContentPolicy(policy);
  const findings = [],
    carriers = [];
  for (const row of policy.embeddedCarriers) {
    const metadata = outputs.get(row.owner + '.json');
    if (!metadata) continue;
    let selected;
    try {
      selected = JSON.parse(Buffer.from(metadata.bytes).toString('utf8'));
    } catch {
      continue;
    }
    if (digest(selected.archive))
      carriers.push({ path: row.owner + '/' + selected.archive + '.tgz', memberPrefix: row.memberPrefix });
  }
  const rules = [
    ['private-repository', /crowncodes\/ia(?![\w-])/gi],
    ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
    ['local-path', /(?:\b[A-Z]:[\\/]+|\/(?:Users|home)\/)[^\s"'`<>]+/gi],
  ];
  for (const [path, output] of outputs) {
    const body = Buffer.from(output.bytes).toString('utf8');
    const hits = clientMatches(body).map((row) => ({ ...row, rule: 'client-name' }));
    for (const [rule, pattern] of rules)
      for (const hit of body.matchAll(pattern))
        if (!(rule === 'email' && reservedEmail(hit[0]))) hits.push({ value: hit[0], index: hit.index, rule });
    for (const hit of hits)
      if (!excepted(path, hit.rule, hit.value, policy, carriers))
        findings.push({ path, rule: hit.rule, value: hit.value, line: body.slice(0, hit.index).split('\n').length });
  }
  return findings;
}
export function scanContent(outputs, policy) {
  const findings = contentFindings(outputs, policy);
  if (findings.length) fail(`private-content leak (${findings[0].rule}) at ${findings[0].path}:${findings[0].line}`);
}
