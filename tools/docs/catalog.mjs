import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { isEntry } from '../entry/is-entry.mjs';
import { htmlIds, localTarget, parseMarkdown } from './markdown.mjs';

// Repository-owned tooling; matching copies live in API scripts and Apps governance.
// No sibling checkout or network is needed. The policy is reviewed input, never generated.
export const GENRES = {
  ideas: 'idea',
  briefs: 'brief',
  research: 'research',
  specs: 'spec',
  plans: 'plan',
  adrs: 'adr',
  rfcs: 'rfc',
};
const RELATIONS = { ...GENRES, runbooks: 'runbook', playbooks: 'playbook', guides: 'guide', reference: 'reference' };
const normalized = (p) => p.replaceAll('\\', '/');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const read = (root, file) => fs.readFileSync(path.resolve(root, file), 'utf8');
export function markdownFiles(root, dir = 'docs') {
  const files = [];
  function visit(relative) {
    for (const e of fs.readdirSync(path.resolve(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${e.name}`;
      if (e.isSymbolicLink()) throw new Error(`Document alias refused: ${file}`);
      if (e.isDirectory()) visit(file);
      else if (e.isFile() && e.name.endsWith('.md')) files.push(file);
    }
  }
  visit(dir);
  return files.sort();
}
export function documentMetadata(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    if (text.startsWith('---')) throw new Error('Unterminated frontmatter');
    return null;
  }
  const value = parse(match[1], { uniqueKeys: true });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Frontmatter must be a mapping');
  return value;
}
export function discoverDocuments(root) {
  const documents = [],
    findings = [];
  const redirects = readRedirects(root);
  const legacyPaths = new Set(JSON.parse(read(root, 'docs/documentation.json')).legacyPaths ?? []);
  for (const file of markdownFiles(root)) {
    if (redirects.has(file)) continue;
    if (file.startsWith('docs/reports/')) continue;
    try {
      const text = read(root, file),
        value = documentMetadata(text);
      const governed = !!GENRES[file.split('/')[1]];
      const bundle = governed && /^docs\/[^/]+\/[^/]+\/README\.md$/.test(file);
      const legacy = governed && /^docs\/[^/]+\/[^/]+\.md$/.test(file) && !file.endsWith('/README.md');
      const part = file.includes('/parts/');
      if (!bundle && !legacy && !part && !value?.id) continue;
      if (!value?.id) {
        if (bundle || legacy) findings.push(`${file}: required lifecycle identity missing`);
        continue;
      }
      if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('Identity must be a nonempty string');
      const genre = GENRES[file.split('/')[1]] ?? value.genre ?? 'reference',
        profile = part ? 'part' : governed ? 'lifecycle' : 'reference';
      if (
        profile === 'lifecycle' &&
        !legacyPaths.has(file) &&
        !/^docs\/[a-z]+\/(?!\d{4}-\d{2}-\d{2})(?:[a-z0-9]+(?:-[a-z0-9]+)*)\/README\.md$/.test(file)
      )
        findings.push(`${file}: lifecycle entrypoint must use a lowercase topic bundle`);
      if (profile === 'lifecycle' && (value.genre !== genre || !value.title))
        findings.push(`${file}: expected genre ${genre} and title`);
      documents.push({
        id: value.id,
        path: file,
        profile,
        genre: profile === 'part' ? 'part' : genre,
        title: value.title ?? /^# (.+)$/m.exec(text)?.[1] ?? value.id,
        status: value.status ?? null,
        sourceDigest: hash(text.replaceAll('\r\n', '\n')),
        metadata: value,
      });
    } catch (error) {
      findings.push(`${file}: ${error.message}`);
    }
  }
  return { documents: documents.sort((a, b) => a.path.localeCompare(b.path, 'en')), findings };
}
export function redirectText(from, to) {
  return `# Document moved\n\n[Continue to the maintained document](${path.posix.relative(path.posix.dirname(from), to)}).\n\nHistorical references retain their original revision; this page has no document identity.\n`;
}
export function readRedirects(root) {
  const file = path.resolve(root, 'docs/documentation.json');
  const policy = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const redirects = new Map();
  for (const entry of policy.redirects ?? []) {
    if (
      !entry ||
      ![entry.from, entry.to].every(
        (p) =>
          typeof p === 'string' &&
          /^docs\/[A-Za-z0-9._/-]+\.md$/.test(p) &&
          !p.split('/').some((v) => v === '.' || v === '..'),
      ) ||
      entry.from === entry.to ||
      redirects.has(entry.from)
    )
      throw new Error('Invalid documentation redirect');
    if (!policy.expected?.some((e) => e.path === entry.to))
      throw new Error(`Redirect target is not a governed canonical document: ${entry.to}`);
    if (!fs.existsSync(path.resolve(root, entry.to))) throw new Error(`Redirect target missing: ${entry.to}`);
    if (read(root, entry.from).replaceAll('\r\n', '\n') !== redirectText(entry.from, entry.to))
      throw new Error(`Redirect must be an identity-free pointer: ${entry.from}`);
    redirects.set(entry.from, entry.to);
  }
  return redirects;
}
export function catalogFor(repository, documents) {
  return { format: 'ia-documentation-catalog/1', repository, documents: documents.map(({ metadata, ...doc }) => doc) };
}
export function indexFor(genre, documents) {
  return (
    `# ${genre[0].toUpperCase() + genre.slice(1)}\n\nGenerated by \`pnpm docs:catalog\`. Edit the owning document; lifecycle status is authored, not inferred from placement.\n\n| Document | Identity | Status |\n| --- | --- | --- |\n` +
    documents
      .filter((d) => d.profile === 'lifecycle' && d.genre === GENRES[genre])
      .map(
        (d) =>
          `| [${String(d.title).replaceAll('|', '\\|')}](${path.posix.relative(`docs/${genre}`, d.path)}) | \`${d.id}\` | ${d.status ?? 'unrecorded'} |`,
      )
      .join('\n') +
    '\n'
  );
}
export function headingIds(text) {
  return parseMarkdown(text).ids;
}
export function checkDocumentationLinks(root, files) {
  const findings = [],
    anchors = new Map();
  let links = 0;
  for (const file of files) {
    let source;
    try {
      source = read(root, file);
    } catch {
      findings.push(`${file}: unreadable document`);
      continue;
    }
    for (const { href } of parseMarkdown(source).links) {
      let decoded;
      try {
        decoded = localTarget(href);
      } catch {
        findings.push(`${file}: invalid link encoding ${href}`);
        continue;
      }
      if (!decoded) continue;
      const { pathname, fragment } = decoded,
        target = pathname ? path.resolve(root, path.dirname(file), pathname) : path.resolve(root, file),
        local = normalized(path.relative(root, target));
      links++;
      if (local === '..' || local.startsWith('../') || path.isAbsolute(local)) {
        findings.push(`${file}: sibling checkout link ${href}`);
        continue;
      }
      if (!fs.existsSync(target)) {
        findings.push(`${file}: missing ${href}`);
        continue;
      }
      if (fragment && /\.(md|html)$/i.test(target)) {
        if (!anchors.has(target)) {
          let text;
          try {
            text = fs.readFileSync(target, 'utf8');
          } catch {
            findings.push(`${file}: unreadable link target ${href}`);
            continue;
          }
          anchors.set(target, /\.html$/i.test(target) ? htmlIds(text) : headingIds(text));
        }
        if (!anchors.get(target).has(fragment)) findings.push(`${file}: missing fragment ${href}`);
      }
    }
  }
  return { files: files.length, links, findings: findings.sort() };
}
export function checkStructure(root, { generated = true } = {}) {
  const findings = [];
  try {
    const policy = JSON.parse(read(root, 'docs/documentation.json'));
    if (
      policy.format !== 'ia-documentation-policy/1' ||
      !/^[\w.-]+\/[\w.-]+$/.test(policy.repository) ||
      !Array.isArray(policy.expected)
    )
      throw new Error('Invalid documentation policy');
    const found = discoverDocuments(root);
    findings.push(...found.findings);
    const identities = new Map();
    for (const doc of found.documents) {
      if (identities.has(doc.id)) findings.push(`${doc.path}: duplicate local identity ${doc.id}`);
      else identities.set(doc.id, doc);
      if (doc.profile === 'lifecycle' && !(policy.legacyMetadata ?? []).includes(doc.id)) {
        const m = doc.metadata;
        for (const key of ['status', 'created', 'last-reviewed'])
          if (typeof m[key] !== 'string' || !m[key]) findings.push(`${doc.path}: required ${key} missing`);
        for (const key of ['created', 'last-reviewed'])
          if (!/^\d{4}-\d{2}-\d{2}$/.test(m[key] ?? '')) findings.push(`${doc.path}: invalid ${key}`);
        if (!Array.isArray(m.owners) || !m.owners.length || m.owners.some((o) => typeof o !== 'string' || !o))
          findings.push(`${doc.path}: owners required`);
      }
    }
    const actual = found.documents.map((d) => ({ id: d.id, path: d.path, profile: d.profile }));
    const ordered = (a) => JSON.stringify([...a].sort((x, y) => x.path.localeCompare(y.path, 'en')));
    if (
      new Set(policy.expected.map((d) => d.id)).size !== policy.expected.length ||
      ordered(policy.expected) !== ordered(actual)
    )
      findings.push(
        'Documentation identity inventory changed: review docs/documentation.json; generation cannot accept omissions',
      );
    for (const doc of found.documents)
      for (const [kind, ids] of Object.entries(doc.metadata.related ?? {})) {
        if (!RELATIONS[kind] || !Array.isArray(ids)) {
          findings.push(`${doc.path}: invalid related ${kind}`);
          continue;
        }
        for (const id of ids) {
          const target = identities.get(id);
          if (!target) findings.push(`${doc.path}: unresolved local document ${id}`);
          else if (target.genre !== RELATIONS[kind]) findings.push(`${doc.path}: wrong relation genre for ${id}`);
          else if (
            !Object.values(target.metadata.related ?? {})
              .flat()
              .includes(doc.id)
          )
            findings.push(`${doc.path}: ${id} lacks reciprocal discovery relation to ${doc.id}`);
        }
      }
    if (generated) {
      const expected = JSON.stringify(catalogFor(policy.repository, found.documents), null, 2) + '\n';
      if (read(root, 'docs/catalog.json').replaceAll('\r\n', '\n') !== expected)
        findings.push('Documentation catalog stale; run pnpm docs:catalog');
      for (const genre of Object.keys(GENRES))
        if (found.documents.some((d) => d.genre === GENRES[genre])) {
          if (read(root, `docs/${genre}/README.md`).replaceAll('\r\n', '\n') !== indexFor(genre, found.documents))
            findings.push(`${genre} index stale; run pnpm docs:catalog`);
        }
    }
    return { documents: found.documents.length, findings: findings.sort() };
  } catch (error) {
    return { documents: 0, findings: [...findings, error.message].sort() };
  }
}
export function generateCatalog(root) {
  const checked = checkStructure(root, { generated: false });
  if (checked.findings.length) throw new Error(checked.findings.join('\n'));
  const policy = JSON.parse(read(root, 'docs/documentation.json')),
    { documents } = discoverDocuments(root);
  fs.writeFileSync(
    path.resolve(root, 'docs/catalog.json'),
    JSON.stringify(catalogFor(policy.repository, documents), null, 2) + '\n',
  );
  for (const genre of Object.keys(GENRES))
    if (documents.some((d) => d.genre === GENRES[genre]))
      fs.writeFileSync(path.resolve(root, `docs/${genre}/README.md`), indexFor(genre, documents));
  return { documents: documents.length };
}
if (isEntry(process.argv[1], import.meta.url)) {
  const root = process.cwd();
  try {
    const result = process.argv.includes('--write')
      ? generateCatalog(root)
      : process.argv.includes('--links')
        ? checkDocumentationLinks(root, [...markdownFiles(root), 'README.md'])
        : checkStructure(root);
    console.log(JSON.stringify(result, null, 2));
    if (result.findings?.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
