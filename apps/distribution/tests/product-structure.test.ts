import { beforeAll, expect, it } from 'vitest';
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
        range: adopted ? product.manifest.version : canonical.manifest.version,
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
