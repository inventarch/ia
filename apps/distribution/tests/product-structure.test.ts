import { beforeAll, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { packOptionalDistribution } from '../../../tools/release/distribution.mjs';
import { registryAddCollection } from '../src/registry-build.js';
import { openRegistry } from '../src/registry-source.js';
import { EditorSnapshot } from '@inventarch/db/editor';
import { DISTRIBUTION_ENGINE_VERSION } from '@inventarch/db/distribution';
import { KERNEL_SOURCES } from '@inventarch/language';
import { productStructure } from '../../../tools/release/product-structure.mjs';
import { readProduct } from '../../../distributions/product-structure/consumer.mjs';
import { distributionSnapshot } from '../src/snapshot.js';
import { verifyArchive, verifySelectedArchiveClosure } from '../src/archive.js';
import { planInstallationSnapshot } from '../src/installation-core.js';
import { resolveReleases } from '../src/resolve.js';
import { repository } from './snapshot-fixture.js';

let releases: ReturnType<typeof productStructure>;
it('packs two explicitly owned systems and indexes their optional kit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ia-two-system-'));
  try {
    cpSync(join(repository, 'distributions/product-structure'), directory, { recursive: true });
    const own = join(directory, '.ia/src/systems/product-system'),
      second = join(directory, '.ia/src/systems/gadget-system');
    const copy = (from: string, to: string): void => {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const target = join(to, entry.name.replaceAll('product', 'gadget'));
        if (entry.isDirectory()) copy(join(from, entry.name), target);
        else
          writeFileSync(
            target,
            readFileSync(join(from, entry.name), 'utf8')
              .replaceAll('product', 'gadget')
              .replaceAll('PRODUCT', 'GADGET'),
          );
      }
    };
    copy(own, second);
    const control = join(own, 'release.ia');
    writeFileSync(
      control,
      readFileSync(control, 'utf8').replace(
        'systems [@system product-system]',
        'systems [@system product-system, @system gadget-system]',
      ),
    );
    const original = releases.product.files.get('.ia/authoring.resources.json')!;
    const selection = JSON.parse(original.toString('utf8'));
    const additional = JSON.parse(original.toString('utf8').replaceAll('product', 'gadget'));
    const assets = new Map<string, Buffer>();
    for (const path of ['README.md', 'SPEC.md', 'consumer.mjs', 'consumer.d.mts', 'LICENSE', 'NOTICE'])
      assets.set(path, releases.product.files.get(path)!);
    for (const file of [...selection.files, ...additional.files] as { path: string; bytes: number; sha256: string }[]) {
      const content = readFileSync(join(directory, file.path));
      assets.set(file.path, content);
      file.bytes = content.length;
      file.sha256 = createHash('sha256').update(content).digest('hex');
    }
    selection.files.push(...additional.files);
    selection.associations.push(...additional.associations);
    selection.index.systems.push(...additional.index.systems);
    assets.set('.ia/authoring.resources.json', Buffer.from(JSON.stringify(selection)));
    const { product } = packOptionalDistribution(repository, {
      directory,
      systems: ['product-system', 'gadget-system'],
      assets,
      descriptor: {
        formatVersion: 1,
        id: 'example/two-system',
        version: '1.0.0',
        distribution: 'workspace-system/definition/distribution/product-structure',
        source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
        license: 'Apache-2.0',
        description: 'Two explicitly selected public fixture systems',
      },
    });
    expect(product.manifest.systems.map((system) => system.name).sort()).toEqual(['gadget-system', 'product-system']);
    const registry = join(directory, 'registry');
    mkdirSync(registry);
    registryAddCollection(registry, 'kit', {
      format: 'ia.registry-kit.v1',
      id: 'example/two-system-kit',
      releases: [
        {
          version: '1.0.0',
          withdrawn: false,
          distributions: [{ id: product.manifest.id, range: product.manifest.version }],
        },
      ],
    });
    expect(
      (await (await openRegistry({ kind: 'dir', path: registry })).index('kit', 'example/two-system-kit')).releases,
    ).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
beforeAll(() => {
  releases = productStructure(repository);
});
const identity = 'product-system/definition/product/customer-portal';
const record = `#! ia 1.0
@agent product-editor
  meaning
    says "Owns this independent consumer product"
    answers "Who maintains it?"
  governance
    applies []
@plan portal-plan
  meaning
    says "Orders consumer product work"
    answers "What is planned?"
  work
    title "Portal plan"
    status open
    owner "product-editor"
@product customer-portal
  meaning
    says "A stable independently authored product"
    answers "Which product groups these plans?"
  product
    format 1
    title "Customer portal"
    status proposed
    owner @agent product-editor
    plans [@plan portal-plan]
`;
function reader(text = record, adopted = true, duplicateOwner = false) {
  const { language, product } = releases;
  const canonical = verifyArchive(language.bytes);
  expect(canonical.manifest.systems.some((row) => row.name === 'product-system')).toBe(false);
  const selected = resolveReleases(
    [
      {
        id: adopted ? product.manifest.id : canonical.manifest.id,
        range: (adopted ? product : canonical).manifest.version,
      },
    ],
    [canonical, ...(adopted ? [product] : [])].map((release) => ({
      release,
      location: `sha256:${release.archiveDigest}`,
      withdrawn: false,
    })),
    DISTRIBUTION_ENGINE_VERSION,
  );
  const archives = new Map([
    [canonical.archiveDigest, language.bytes],
    ...(adopted ? [[product.archiveDigest, product.bytes] as const] : []),
  ]);
  verifySelectedArchiveClosure(selected.lock, archives);
  const base = distributionSnapshot({
    sources: KERNEL_SOURCES.map((source) => ({
      ...source,
      location: { placement: { kind: 'floor', band: 10, reach: '' }, provenance: 'bootstrap' },
    })),
    folders: [],
    floorOrigin: 'embedded',
  });
  const installed = planInstallationSnapshot({
    base,
    current: null,
    lock: selected.lock,
    archives,
    operation: 'install',
  });
  const local = (path: string, text: string) => ({
    path,
    text,
    location: {
      placement: { kind: 'authored' as const, band: 100 as const, reach: '' },
      provenance: 'workspace' as const,
    },
  });
  const system =
    `#! ia 1.0\n@system consumer-system\n  provider "independent-consumer"\n  version "0.1.0"\n  describes "Owns local product instances"\n  steward @agent product-editor\n  requires\n    - product-system\n    - agent-system\n    - work-system\n` +
    (duplicateOwner
      ? '  discriminators\n    product lowers to definition\n      category thing\n      facets [product]\n      schema @schema product\n'
      : '');
  return new EditorSnapshot({
    root: '',
    ...base,
    sources: [
      ...base.sources,
      ...installed.installedSources,
      local('.ia/src/systems/consumer-system/system.ia', system),
      local('.ia/src/systems/consumer-system/records/product.ia', text),
    ],
    folders: [...installed.inputs.systems.map((row) => row.name), 'consumer-system'],
    activation: installed.pointer,
  });
}
it('requires explicit emitted structural adoption without widening canonical language', () => {
  expect(releases.product.manifest.license).toBe('Apache-2.0');
  const language = verifyArchive(releases.language.bytes);
  for (const path of ['LICENSE', 'NOTICE']) {
    expect(releases.product.files.get(path)).toEqual(language.files.get(path));
    expect(releases.product.files.has(path)).toBe(true);
  }
  expect(() => verifyArchive(releases.product.bytes)).toThrow(/authoring/i);
  const absent = reader(record, false);
  try {
    expect(() => readProduct(absent, identity)).toThrow();
  } finally {
    absent.close();
  }
  const adopted = reader();
  try {
    expect(readProduct(adopted, identity)).toMatchObject({
      identity,
      title: 'Customer portal',
      status: 'proposed',
      owner: 'agent-system/binding/agent/product-editor',
      plans: ['work-system/definition/plan/portal-plan'],
    });
  } finally {
    adopted.close();
  }
  const duplicate = reader(record, true, true);
  try {
    expect(() => readProduct(duplicate, identity)).toThrow();
  } finally {
    duplicate.close();
  }
});
it('keeps product identity stable through title/status changes and refuses stale revisions', () => {
  for (const status of ['proposed', 'active', 'retired']) {
    const snapshot = reader(
      record.replace('status proposed', `status ${status}`).replace('"Customer portal"', '"Renamed portal"'),
    );
    try {
      expect(readProduct(snapshot, identity)).toMatchObject({ identity, status, title: 'Renamed portal' });
      expect(() => readProduct(snapshot, identity, 'stale')).toThrow(/ADMISSION/);
    } finally {
      snapshot.close();
    }
  }
});
it('refuses native shape errors and consumer format/title constraints', () => {
  for (const text of [
    record.replace('format 1', 'format 2'),
    record.replace('format 1', 'format "1"'),
    record.replace('title "Customer portal"', 'title " "'),
    record.replace('status proposed', 'status deleted'),
    ...[
      '    title "Customer portal"\n',
      '    owner @agent product-editor\n',
      '    plans [@plan portal-plan]\n',
      '  meaning\n    says "A stable independently authored product"\n    answers "Which product groups these plans?"\n',
    ].map((field) => record.replace(field, '')),
    record.replace('    format 1', '    surprise true\n    format 1'),
  ]) {
    const snapshot = reader(text);
    try {
      expect(() => readProduct(snapshot, identity)).toThrow();
    } finally {
      snapshot.close();
    }
  }
});
it('refuses dangling, wrong-word and duplicate plan references', () => {
  for (const text of [
    record.replace('owner @agent product-editor', 'owner @agent missing'),
    record.replace('owner @agent product-editor', 'owner @plan portal-plan'),
    record.replace('plans [@plan portal-plan]', 'plans [@plan missing]'),
    record.replace('plans [@plan portal-plan]', 'plans [@agent product-editor]'),
    record.replace('plans [@plan portal-plan]', 'plans [@plan portal-plan, @plan portal-plan]'),
  ]) {
    const snapshot = reader(text);
    try {
      expect(() => readProduct(snapshot, identity)).toThrow();
    } finally {
      snapshot.close();
    }
  }
});
