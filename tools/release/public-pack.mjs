import { packageManagerCommand } from '../entry/package-manager.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { copyPackInputs } from './shared/pack-inputs.mjs';
import { child, separate } from './shared/paths.mjs';
import { packManifest } from './pack-manifest.mjs';
import { isEntry } from '../entry/is-entry.mjs';

export const PUBLIC_INPUTS = '.ia/public-package-inputs.json';
export const PUBLIC_MEMBERSHIP = 'tools/distribution/public-content-policy.json';
export const PUBLIC_SYSTEM_POLICY = 'tools/distribution/system-package-policy.json';
export const COMPATIBILITY = 'system-compatibility.json';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
function inputDescriptor(root) {
  const bytes = readFileSync(child(root, PUBLIC_INPUTS)),
    receipt = JSON.parse(bytes);
  if (
    receipt.format !== 'ia.public-package-inputs.v2' ||
    receipt.source?.repository !== 'https://github.com/inventarch/ia' ||
    !/^[a-f0-9]{40}$/.test(receipt.source?.commit) ||
    !/^[a-f0-9]{40}$/.test(receipt.source?.tree) ||
    typeof receipt.source?.dirty !== 'boolean' ||
    Object.keys(receipt.source).sort().join(',') !== 'commit,dirty,repository,tree' ||
    receipt.membership?.path !== PUBLIC_MEMBERSHIP ||
    !/^[a-f0-9]{64}$/.test(receipt.membership?.sha256) ||
    Object.keys(receipt.membership).sort().join(',') !== 'path,sha256' ||
    !Array.isArray(receipt.files) ||
    !receipt.files.length ||
    new Set(receipt.files.map((row) => row.path)).size !== receipt.files.length ||
    receipt.files.some((row) => row.path === PUBLIC_INPUTS || !/^[a-f0-9]{64}$/.test(row.sha256)) ||
    Object.keys(receipt).sort().join(',') !== 'files,format,inputDigest,membership,npm,source' ||
    receipt.inputDigest !== sha(JSON.stringify(receipt.files)) ||
    !receipt.npm ||
    typeof receipt.npm !== 'object' ||
    Array.isArray(receipt.npm)
  )
    throw new Error('Invalid public package input descriptor');
  return { receipt, sha256: sha(bytes), bytes };
}
const trackedInputs = (root) =>
  execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .filter((path) => path !== PUBLIC_INPUTS)
    .sort();
const hasCommit = (root) => {
  try {
    git(root, 'rev-parse', '--verify', '--quiet', 'HEAD');
    return true;
  } catch (error) {
    if (error.status !== 1) throw error;
    return false;
  }
};
/**
 * The committed, sealed descriptor by default. `sealed: false` derives the descriptor this checkout would seal, in
 * memory, with the same identity and membership refusals: ordinary qualification uses it so a pull request need not
 * rewrite the descriptor, while release preparation and publication keep requiring the committed seal.
 */
export function publicPackageInputs(root, { sealed = true } = {}) {
  if (!sealed) return currentPublicPackageInputs(root);
  const source = inputDescriptor(root);
  for (const row of source.receipt.files)
    if (sha(readFileSync(child(root, row.path))) !== row.sha256)
      throw new Error('Changed public package input: ' + row.path + '; review and run pnpm npm:inputs');
  if (
    JSON.stringify(
      validateMembership(
        root,
        source.receipt.files.map((row) => row.path),
      ),
    ) !== JSON.stringify(source.receipt.npm)
  )
    throw new Error('Changed public package versions; review and run pnpm npm:inputs');
  if (source.receipt.membership.sha256 !== sha(readFileSync(child(root, PUBLIC_MEMBERSHIP))))
    throw new Error('Changed public package membership policy; review and run pnpm npm:inputs');
  // New tracked files must never be silently omitted.
  const tracked = trackedInputs(root);
  if (
    (tracked.length || hasCommit(root)) &&
    JSON.stringify(tracked) !== JSON.stringify(source.receipt.files.map((row) => row.path).sort())
  )
    throw new Error('Changed tracked public input selection; review and run pnpm npm:inputs');
  return source;
}
/** Explicitly seal reviewed tracked public inputs and their public repository provenance. */
export function refreshPublicPackageInputs(root) {
  const current = currentPublicPackageInputs(root);
  writeFileSync(child(resolve(root), PUBLIC_INPUTS), current.bytes);
  return current;
}
/** The descriptor a refresh would write for this checkout, without writing it. */
function validateMembership(root, tracked) {
  const policy = json(child(root, PUBLIC_MEMBERSHIP));
  const rows = policy.packageNames;
  if (
    policy.format !== 'ia.public-content-policy.v1' ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.some(
      (row) =>
        !/^(packages|apps|\.ia\/src\/systems)\/[^/]+$/.test(row.root) ||
        typeof row.private !== 'boolean' ||
        typeof row.name !== 'string',
    ) ||
    new Set(rows.map((row) => row.root)).size !== rows.length ||
    new Set(rows.map((row) => row.name)).size !== rows.length
  )
    throw new Error('Invalid public package membership policy');
  const packagePaths = tracked
    .filter((path) => /^(packages|apps|\.ia\/src\/systems)\/[^/]+\/package.json$/.test(path))
    .sort();
  const selected = rows.map((row) => row.root + '/package.json').sort();
  if (JSON.stringify(packagePaths) !== JSON.stringify(selected))
    throw new Error('Public package membership requires a reviewed public content policy');
  const npm = Object.fromEntries(
    packagePaths.map((path) => {
      const manifest = json(child(root, path));
      const identity = rows.find((row) => row.root + '/package.json' === path);
      if (
        manifest.name !== identity.name ||
        Boolean(manifest.private) !== identity.private ||
        (!manifest.name.startsWith('@inventarch/') &&
          !(
            path === 'apps/vscode/package.json' &&
            manifest.name === 'inventarch-ia' &&
            manifest.private === true &&
            manifest.publisher === 'inventarch'
          )) ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)
      )
        throw new Error('Invalid public package identity: ' + path);
      return [path, manifest.version];
    }),
  );
  return npm;
}
function currentPublicPackageInputs(root) {
  root = resolve(root);
  const previous = readFileSync(child(root, PUBLIC_INPUTS));
  if (json(child(root, 'package.json')).name !== '@inventarch/workspace')
    throw new Error('Input refresh requires the public workspace');
  if (resolve(git(root, 'rev-parse', '--show-toplevel')) !== root)
    throw new Error('Input refresh requires the public repository root');
  const tracked = trackedInputs(root);
  if (!tracked.length || new Set(tracked).size !== tracked.length)
    throw new Error('Invalid tracked public input selection');
  const files = tracked.map((path) => ({ path, sha256: sha(readFileSync(child(root, path))) }));
  const npm = validateMembership(root, tracked);
  const receipt = {
    format: 'ia.public-package-inputs.v2',
    source: {
      repository: 'https://github.com/inventarch/ia',
      commit: git(root, 'rev-parse', 'HEAD'),
      tree: git(root, 'rev-parse', 'HEAD^{tree}'),
      dirty: git(root, 'status', '--porcelain') !== '',
    },
    membership: { path: PUBLIC_MEMBERSHIP, sha256: sha(readFileSync(child(root, PUBLIC_MEMBERSHIP))) },
    npm,
    files,
    inputDigest: sha(JSON.stringify(files)),
  };
  if (
    JSON.stringify(trackedInputs(root)) !== JSON.stringify(tracked) ||
    files.some((row) => sha(readFileSync(child(root, row.path))) !== row.sha256) ||
    !readFileSync(child(root, PUBLIC_INPUTS)).equals(previous)
  )
    throw new Error('Public inputs changed during refresh');
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  return { receipt, bytes, sha256: sha(bytes) };
}
/**
 * Build and pack only the emitted positive selection, using an isolated copy and exact lock. Release preparation packs
 * the sealed descriptor; ordinary qualification passes `sealed: false` and packs the selection this checkout would seal.
 */
export function packPublicPackages(root, target, pnpm = process.env.npm_execpath, { sealed = true } = {}) {
  root = resolve(root);
  target = resolve(target);
  separate(target, root);
  if (!pnpm || !existsSync(pnpm)) throw new Error('Run public package qualification through the pinned pnpm');
  const source = publicPackageInputs(root, { sealed }),
    rootManifest = json(child(root, 'package.json'));
  const versionInvocation = packageManagerCommand(pnpm, ['--version']);
  const pnpmVersion = execFileSync(versionInvocation.command, versionInvocation.args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (rootManifest.packageManager !== 'pnpm@' + pnpmVersion)
    throw new Error('Package manager differs from the emitted toolchain policy');
  if (existsSync(target) && readdirSync(target).length) throw new Error('Public package destination must be empty');
  const parent = dirname(root),
    staging = mkdtempSync(resolve(parent, '.ia-public-npm-pack-'));
  const run = (args, cwd = staging) => {
    const invocation = packageManagerCommand(pnpm, args);
    return execFileSync(invocation.command, invocation.args, { cwd, windowsHide: true, stdio: 'inherit' });
  };
  try {
    copyPackInputs(root, staging, source.receipt);
    execFileSync('git', ['init', '--quiet'], { cwd: staging, windowsHide: true });
    run(['install', '--offline', '--frozen-lockfile']);
    run(['build']);
    // A build must not rewrite selected inputs, including generated dependency attribution.
    for (const row of source.receipt.files)
      if (sha(readFileSync(child(staging, row.path))) !== row.sha256)
        throw new Error('Build changed selected package input: ' + row.path);
    const projects = source.receipt.files
      .filter((row) => /^(packages|apps|\.ia\/src\/systems)\/[^/]+\/package.json$/.test(row.path))
      .map((row) => ({ owner: dirname(row.path).replaceAll('\\', '/'), manifest: json(child(staging, row.path)) }));
    const versions = new Map(projects.map((row) => [row.manifest.name, row.manifest.version]));
    const packages = projects.filter((row) => !row.manifest.private);
    if (
      projects.length !== Object.keys(source.receipt.npm).length ||
      packages.some((row) => !row.manifest.name.startsWith('@inventarch/')) ||
      versions.size !== projects.length
    )
      throw new Error('Unexpected public package membership');
    for (const row of projects)
      writeFileSync(
        child(staging, row.owner + '/package.json'),
        JSON.stringify(packManifest(row.manifest, versions), null, 2) + '\n',
      );
    const receiptPath = child(staging, '.git/public-package-inputs.json');
    writeFileSync(receiptPath, source.bytes);
    const systemPackages = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--conditions=development',
          '--import',
          'tsx',
          'tools/release/system-packages.ts',
          staging,
          receiptPath,
          child(staging, PUBLIC_SYSTEM_POLICY),
        ],
        { cwd: staging, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      ),
    );
    mkdirSync(target, { recursive: true });
    const packed = [];
    for (const row of packages) {
      run(['pack', '--pack-destination', target], child(staging, row.owner));
      const filename = `${row.manifest.name.replace('@', '').replace('/', '-')}-${row.manifest.version}.tgz`;
      const bytes = readFileSync(child(target, filename));
      packed.push({
        name: row.manifest.name,
        version: row.manifest.version,
        filename: child(target, filename),
        owner: row.owner,
        sha256: sha(bytes),
      });
    }
    const compatibility = {
      format: 'ia.system-package-compatibility.v2',
      source: source.receipt.source,
      sourceManifestSha256: source.sha256,
      membership: source.receipt.membership,
      recipe: {
        publicCommit: git(root, 'rev-parse', 'HEAD'),
        publicDirty: git(root, 'status', '--porcelain') !== '',
        node: process.version,
        pnpm: pnpmVersion,
        lockSha256: sha(readFileSync(child(root, 'pnpm-lock.yaml'))),
        files: source.receipt.files.filter(
          (row) => row.path.startsWith('tools/release/') || row.path === PUBLIC_SYSTEM_POLICY,
        ),
      },
      packages: systemPackages.map((row) => {
        const archive = packed.find((entry) => entry.name === row.binding.package.name);
        if (!archive || archive.version !== row.binding.package.version)
          throw new Error('Bundled and packed system identities differ');
        return {
          package: row.binding.package,
          archiveSha256: archive.sha256,
          bindingSha256: row.bindingSha256,
          native: row.binding.native,
          codeDigest: row.binding.code.digest,
          protocols: row.binding.protocols,
        };
      }),
    };
    const compatibilityBytes = JSON.stringify(compatibility, null, 2) + '\n';
    writeFileSync(child(target, COMPATIBILITY), compatibilityBytes);
    if (sealed) {
      if (!readFileSync(child(root, PUBLIC_INPUTS)).equals(source.bytes))
        throw new Error('Public input descriptor changed while packing');
      publicPackageInputs(root);
    } else if (publicPackageInputs(root, { sealed: false }).receipt.inputDigest !== source.receipt.inputDigest)
      throw new Error('Public inputs changed while packing');
    return { packed, compatibility, compatibilitySha256: sha(compatibilityBytes) };
  } finally {
    if (dirname(staging) !== parent || !basename(staging).startsWith('.ia-public-npm-pack-'))
      throw new Error('Unsafe public packaging cleanup');
    rmSync(staging, { recursive: true, force: true });
  }
}
/**
 * Verify exact companion provenance before a publisher considers any npm write. Publication uses the sealed
 * descriptor; a caller may pass the `inputs` it qualified against (tests use the unsealed current selection).
 */
export function verifyPublicCompatibility(root, directory, expectedSha256, { inputs } = {}) {
  const source = inputs ?? publicPackageInputs(root),
    bytes = readFileSync(child(directory, COMPATIBILITY));
  if (expectedSha256 !== undefined && sha(bytes) !== expectedSha256)
    throw new Error('System compatibility manifest changed');
  const compatibility = JSON.parse(bytes),
    policy = json(child(root, PUBLIC_SYSTEM_POLICY));
  if (
    compatibility.format !== 'ia.system-package-compatibility.v2' ||
    Object.keys(compatibility).sort().join(',') !== 'format,membership,packages,recipe,source,sourceManifestSha256' ||
    !compatibility.recipe ||
    Object.keys(compatibility.recipe).sort().join(',') !== 'files,lockSha256,node,pnpm,publicCommit,publicDirty' ||
    JSON.stringify(compatibility.source) !== JSON.stringify(source.receipt.source) ||
    compatibility.sourceManifestSha256 !== source.sha256 ||
    compatibility.recipe?.publicCommit !== git(root, 'rev-parse', 'HEAD') ||
    compatibility.recipe?.lockSha256 !== sha(readFileSync(child(root, 'pnpm-lock.yaml')))
  )
    throw new Error('System compatibility source or recipe differs');
  if (policy.format !== 'ia.system-package-policy.v2') throw new Error('System compatibility policy differs');
  const manifests = policy.packages.map((owner) => json(child(root, owner + '/package.json')));
  const names = manifests.map((row) => row.name).sort();
  const recipeFiles = source.receipt.files.filter(
    (row) => row.path.startsWith('tools/release/') || row.path === PUBLIC_SYSTEM_POLICY,
  );
  if (
    JSON.stringify(compatibility.membership) !== JSON.stringify(source.receipt.membership) ||
    JSON.stringify(compatibility.recipe.files) !== JSON.stringify(recipeFiles) ||
    typeof compatibility.recipe.publicDirty !== 'boolean' ||
    !/^v\d+\.\d+\.\d+$/.test(compatibility.recipe.node) ||
    'pnpm@' + compatibility.recipe.pnpm !== json(child(root, 'package.json')).packageManager
  )
    throw new Error('System compatibility source or recipe differs');
  if (JSON.stringify(compatibility.packages.map((row) => row.package.name).sort()) !== JSON.stringify(names))
    throw new Error('System compatibility membership differs');
  for (const row of compatibility.packages) {
    if (
      row.package.version !== manifests.find((manifest) => manifest.name === row.package.name)?.version ||
      !/^[a-f0-9]{64}$/.test(row.codeDigest) ||
      !/^[a-f0-9]{64}$/.test(row.native?.archiveSha256) ||
      !/^[a-f0-9]{64}$/.test(row.native?.manifestSha256)
    )
      throw new Error('System compatibility identity or digest differs');
    const filename = `${row.package.name.replace('@', '').replace('/', '-')}-${row.package.version}.tgz`;
    if (
      sha(readFileSync(child(directory, filename))) !== row.archiveSha256 ||
      !/^[a-f0-9]{64}$/.test(row.bindingSha256) ||
      row.native?.id !==
        policy.owners.find((owner) => '@inventarch/' + owner.native.system === row.package.name)?.native.id ||
      row.native.version !==
        policy.owners.find((owner) => '@inventarch/' + owner.native.system === row.package.name)?.native.version ||
      row.protocols?.distribution !== 1 ||
      row.protocols?.binding !== 2 ||
      JSON.stringify(row.protocols?.language) !== '["1.0"]'
    )
      throw new Error('System compatibility archive or protocol differs');
  }
  return { compatibility, sha256: sha(bytes) };
}

if (isEntry(process.argv[1], import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== 'refresh-inputs')
    throw new Error('Usage: node tools/release/public-pack.mjs refresh-inputs');
  const refreshed = refreshPublicPackageInputs(process.cwd());
  process.stdout.write(
    JSON.stringify(
      {
        files: refreshed.receipt.files.length,
        sha256: refreshed.sha256,
        source: refreshed.receipt.source,
        inputDigest: refreshed.receipt.inputDigest,
      },
      null,
      2,
    ) + '\n',
  );
}
