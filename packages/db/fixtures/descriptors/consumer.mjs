// Installed consumer for the OS09 descriptor producer. It imports only the published
// `@inventarch/db/descriptors` export (no source aliases or development condition) and compiles the
// emitted specimens in the directory given as its argument. See ../../src/descriptors/SPEC.md.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compileAppComposition,
  compileDomainModel,
  compileStorageBinding,
  createDescriptorRegistry,
} from '@inventarch/db/descriptors';

const directory = resolve(process.argv[2] ?? import.meta.dirname);
const read = (path) => readFileSync(resolve(directory, path), 'utf8');
const resources = Object.fromEntries(
  readdirSync(resolve(directory, 'resources')).map((name) => [name, read(`resources/${name}`)]),
);
const envelopes = JSON.parse(read('envelopes.json'));
const value = (result) => {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
};
const code = (result) => (result.ok ? 'compiled' : result.diagnostics[0].code);

const registry = value(createDescriptorRegistry(JSON.parse(read('registry.json'))));
const orders = value(compileDomainModel({ envelope: envelopes.orders, resources, registry }));
const compiled = {
  registry: registry.digest,
  orders: orders.digests.definition,
  lending: value(compileDomainModel({ envelope: envelopes.lending, resources, registry })).digests.definition,
  'orders-store': value(
    compileStorageBinding({ envelope: envelopes['orders-store'], resources, registry, model: orders }),
  ).digests.definition,
  'orders-desk': value(
    compileAppComposition({
      envelope: envelopes['orders-desk'],
      resources,
      registry,
      publicConfiguration: ['page-size'],
    }),
  ).digests.definition,
  'lending-kiosk': value(compileAppComposition({ envelope: envelopes['lending-kiosk'], resources, registry })).digests
    .definition,
};
const app = JSON.parse(resources['orders-desk.app.json']);
app.screens[0].view = 'kanban-view@1';
const refusals = {
  digest: code(
    compileDomainModel({
      envelope: envelopes.orders,
      resources: { ...resources, 'orders.domain.json': resources['orders.domain.json'].replace('"open"', '"pending"') },
      registry,
    }),
  ),
  duplicate: code(
    compileDomainModel({
      envelope: envelopes.orders,
      resources: {
        ...resources,
        'orders.domain.json': resources['orders.domain.json'].replace('"format": 1,', '"format": 1, "format": 1,'),
      },
      registry,
    }),
  ),
  view: code(
    compileAppComposition({
      envelope: {
        ...envelopes['orders-desk'],
        fields: {
          ...envelopes['orders-desk'].fields,
          digest: 'sha256:' + (await import('node:crypto')).createHash('sha256').update(canonical(app)).digest('hex'),
        },
      },
      resources: { ...resources, 'orders-desk.app.json': JSON.stringify(app) },
      registry,
    }),
  ),
  major: code(createDescriptorRegistry({ ...JSON.parse(read('registry.json')), format: 2 })),
};
const expected = JSON.parse(read('expected.json'));
for (const [key, digest] of Object.entries(expected))
  if (compiled[key] !== digest) throw new Error(`Installed compilation of ${key} differs from the emitted fixture`);
console.log(JSON.stringify({ consumer: '@inventarch/db/descriptors', compiled, refusals }));

/** Independent canonical form (sorted keys, no whitespace) used to rebind the edited specimen. */
function canonical(item) {
  if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
  if (item !== null && typeof item === 'object')
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
      .join(',')}}`;
  return JSON.stringify(item);
}
