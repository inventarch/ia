import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runBounded } from '@tools/testing/subprocess.js';
import { open } from '../src/index.js';
import type { Node } from '@ia/graph';
import {
  DESCRIPTOR_LIMITS,
  activateTarget,
  classifyModelChange,
  compileAppComposition,
  compileDomainModel,
  compileStorageBinding,
  createDescriptorRegistry,
  decodeDescriptorResource,
  envelopeFromRecord,
} from '../src/descriptors/index.js';
import type {
  CompiledAppComposition,
  CompiledDomainModel,
  DescriptorEnvelope,
  DescriptorRegistry,
  DescriptorResult,
} from '../src/descriptors/index.js';

// OS09 (docs/specs/domain-and-app-descriptors/README.md) pure producer: DESC-Q02, DESC-Q03, DESC-Q08.
const repository = resolve(import.meta.dirname, '../../..');
const fixtures = resolve(import.meta.dirname, '../fixtures/descriptors');
const read = (path: string): string => readFileSync(resolve(fixtures, path), 'utf8');
const resources: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(resolve(fixtures, 'resources')).map((name) => [name, read(`resources/${name}`)]),
);
const registryData = JSON.parse(read('registry.json')) as {
  format: number;
  targets: string[];
  contracts: Record<string, unknown>[];
};
const emitted = JSON.parse(read('envelopes.json')) as Record<string, DescriptorEnvelope>;
const walk = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => !['node_modules', 'dist', '.git'].includes(name))
    .flatMap((name) => (statSync(resolve(dir, name)).isDirectory() ? walk(resolve(dir, name)) : [resolve(dir, name)]));
const native = resolve(fixtures, 'native');
/** Candidate sources stay isolated: they enter admission only through the in-memory preview overlay (ALIGN-06). */
const drafts = walk(native).map((file) => {
  const local = relative(native, file).replaceAll('\\', '/');
  return {
    path: local.startsWith('capabilities/')
      ? `.ia/src/systems/agent-composition-system/records/descriptor-candidate/${local.slice('capabilities/'.length)}`
      : `.ia/src/systems/descriptor-candidate/${local}`,
    text: readFileSync(file, 'utf8'),
  };
});

function ok<T>(result: DescriptorResult<T>): T {
  if (!result.ok) throw new Error(`Unexpected refusal ${JSON.stringify(result.diagnostics)}`);
  return result.value;
}
function refused<T>(result: DescriptorResult<T>, code: string, field?: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(Object.keys(result).sort()).toEqual(['diagnostics', 'ok']);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code, ...(field === undefined ? {} : { field }) });
  expect(result.diagnostics[0]!.message.length).toBeLessThanOrEqual(256);
}
type Json = Record<string, any>;
const registry = (): DescriptorRegistry => ok(createDescriptorRegistry(registryData));
const edit = (name: string, change: (value: Json) => void): string => {
  const value = JSON.parse(resources[name]!) as Json;
  change(value);
  return JSON.stringify(value);
};
/** Rebind an edited resource honestly: the envelope digest is recomputed with the released codec. */
function rebound(
  envelope: DescriptorEnvelope,
  text: string,
  fields: Record<string, string | readonly string[]> = {},
): { envelope: DescriptorEnvelope; resources: Record<string, string> } {
  const decoded = ok(decodeDescriptorResource(text));
  const key = envelope.fields['resource'] as string;
  return {
    envelope: { ...envelope, fields: { ...envelope.fields, digest: decoded.digest, ...fields } },
    resources: { ...resources, [key]: text },
  };
}
const orders = (): CompiledDomainModel =>
  ok(compileDomainModel({ envelope: emitted['orders']!, resources, registry: registry() }));

let admitted: readonly Node[] = [];
let findings: readonly { code: string; path?: string }[] = [];
beforeAll(() => {
  const db = open(repository, { cache: false });
  try {
    const base = db.preview([]),
      preview = db.preview(drafts);
    const before = new Set(base.report.findings.map((finding) => JSON.stringify(finding)));
    admitted = preview.records;
    findings = preview.report.findings.filter((finding) => !before.has(JSON.stringify(finding)));
    expect(
      db
        .records()
        .some((record) => ['domain-model', 'storage-binding', 'app-composition'].includes(record.discriminator)),
    ).toBe(false);
  } finally {
    db.close();
  }
}, 60_000);

describe('isolated candidate envelopes (DESC-01, ALIGN-06)', () => {
  it('admits the three candidate envelopes through existing text/ref/list fields without registering them in active sources', () => {
    expect(findings).toEqual([]);
    const names = admitted
      .filter((record) => record.system === 'descriptor-candidate' && record.discriminator !== 'system')
      .map((record) => `${record.discriminator}/${record.name}`)
      .sort();
    expect(names).toEqual([
      'app-composition/lending-kiosk',
      'app-composition/orders-desk',
      'domain-model/lending',
      'domain-model/orders',
      'storage-binding/orders-store',
    ]);
    for (const path of walk(resolve(repository, 'examples/conformance/native')).filter((file) => file.endsWith('.ia')))
      expect(readFileSync(path, 'utf8')).not.toMatch(/^\s+(domain-model|storage-binding|app-composition) lowers to /m);
  });
  it('emits exactly the envelopes extracted from admitted records', () => {
    for (const [name, envelope] of Object.entries(emitted)) {
      const record = admitted.find(
        (node) => node.system === 'descriptor-candidate' && node.name === name && node.discriminator === envelope.kind,
      );
      expect(record, name).toBeDefined();
      expect(ok(envelopeFromRecord(record!))).toEqual(envelope);
    }
    const steward = admitted.find((node) => node.name === 'descriptor-candidate-steward')!;
    refused(envelopeFromRecord(steward), 'DESC-ENVELOPE-INVALID');
  });
  it('keeps native structural refusals for malformed envelopes', () => {
    const db = open(repository, { cache: false });
    try {
      const path = '.ia/src/systems/descriptor-candidate/records/orders.ia',
        original = drafts.find((draft) => draft.path === path)!.text;
      const variants: [string, string][] = [
        [original.replace('format 1', 'format one'), 'IA-COMP-FIELD-TYPE'],
        [original.replace(/\n {4}digest .*\n/, '\n'), 'IA-COMP-FIELD-MISSING'],
        [original.replace('    format 1\n', '    format 1\n    code "./model.js"\n'), 'IA-COMP-FIELD-UNKNOWN'],
      ];
      for (const [text, code] of variants) {
        const preview = db.preview(drafts.map((draft) => (draft.path === path ? { path, text } : draft)));
        expect(preview.report.findings.some((finding) => finding.code === code && finding.path === path)).toBe(true);
      }
      const app = '.ia/src/systems/descriptor-candidate/records/orders-desk.ia',
        text = drafts
          .find((draft) => draft.path === app)!
          .text.replace('@capability orders-write', '@agent descriptor-candidate-steward');
      expect(
        db
          .preview(drafts.map((draft) => (draft.path === app ? { path: app, text } : draft)))
          .report.findings.some((finding) => finding.code === 'IA-COMP-FIELD-REF-TARGET'),
      ).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000); // Four admissions of the full native tree; allow Windows I/O variance. Not a latency assertion.
});

describe('pure compilations of distinct specimens', () => {
  it('compiles two domain representations with bound contracts and separate invariant evaluation (DOM-01)', () => {
    const model = orders(),
      lending = ok(compileDomainModel({ envelope: emitted['lending']!, resources, registry: registry() }));
    expect(
      Object.isFrozen(model) && Object.isFrozen(model.entities) && Object.isFrozen(model.entities[0]!.fields),
    ).toBe(true);
    expect(model).toMatchObject({
      format: 1,
      kind: 'domain-model',
      owner: 'descriptor-candidate/definition/domain-model/orders',
      model: 'orders',
      version: '1.0.0',
      resource: { key: 'orders.domain.json', digest: emitted['orders']!.fields['digest'] },
    });
    expect(
      model.commands.map((command) => [command.name, command.contract, command.implementation.slice(0, 7)]),
    ).toEqual([
      ['place-order', 'place-order@1', 'sha256:'],
      ['cancel-order', 'cancel-order@1', 'sha256:'],
    ]);
    expect(model.invariants.map((invariant) => [invariant.name, invariant.status])).toEqual([
      ['total-matches-lines', 'bound'],
      ['gift-note-length', 'unavailable'],
    ]);
    expect(model.evaluation).toEqual({ structural: 'compiled', invariants: 'not-evaluated' });
    expect(lending.references).toEqual([
      {
        entity: 'loan',
        field: 'items',
        target: { model: 'catalog', entity: 'item', version: '3.0.0' },
        cardinality: 'many',
      },
    ]);
    expect(lending.entities.map((entity) => [entity.key, entity.id])).toEqual([
      ['member', { field: 'number', codec: 'integer' }],
      ['loan', { field: 'loan-id', codec: 'text' }],
    ]);
    expect(model.digests.definition).not.toBe(lending.digests.definition);
  });
  it('joins the storage binding to the exact compiled model, port, adapter and migration policy', () => {
    const binding = ok(
      compileStorageBinding({ envelope: emitted['orders-store']!, resources, registry: registry(), model: orders() }),
    );
    expect(binding).toMatchObject({
      kind: 'storage-binding',
      model: { id: 'orders', version: '1.0.0', digest: orders().resource.digest },
      port: 'order-repository@1',
      adapter: 'relational-store@2',
      schemaVersion: '4.0.0',
      transaction: 'entity',
      isolation: { column: 'tenant_id' },
      migrationPolicy: 'reviewed-forward-only@1',
    });
    expect(binding.entities.map((entity) => [entity.entity, entity.store, entity.fields.length])).toEqual([
      ['customer', 'customers', 2],
      ['order', 'orders', 7],
    ]);
  });
  it('compiles two app compositions with digests, capabilities, typed diagnostics and an explicit public allowlist (APPD-02)', () => {
    const desk = ok(
      compileAppComposition({
        envelope: emitted['orders-desk']!,
        resources,
        registry: registry(),
        publicConfiguration: ['page-size'],
      }),
    );
    const kiosk = ok(compileAppComposition({ envelope: emitted['lending-kiosk']!, resources, registry: registry() }));
    expect(desk.capabilities).toEqual(['orders-write']);
    expect(desk.targets).toEqual([
      { profile: 'headless', status: 'supported', diagnostics: [] },
      { profile: 'browser', status: 'supported', diagnostics: [] },
    ]);
    expect(desk.publicConfiguration).toEqual([{ key: 'page-size', default: 25 }]);
    expect(desk.configuration.find((entry) => entry.key === 'payment-token')).toEqual({
      key: 'payment-token',
      visibility: 'server',
      secret: true,
    });
    expect(kiosk.publicConfiguration).toEqual([]);
    expect(Object.keys(desk.digests).sort()).toEqual(['definition', 'input', 'registry', 'resource']);
    expect(desk.digests.registry).toBe(registry().digest);
    expect(desk.screens[0]).toMatchObject({
      name: 'order-list',
      view: { contract: 'list-view@1' },
      queries: [{ contract: 'list-orders@1' }],
      actions: ['place-order'],
    });
    expect(kiosk.screens[0]!.view.contract).toBe(desk.screens[0]!.view.contract);
    expect(Object.isFrozen(desk.targets[0])).toBe(true);
    refused(
      compileAppComposition({
        envelope: emitted['orders-desk']!,
        resources,
        registry: registry(),
        publicConfiguration: ['payment-token'],
      }),
      'DESC-SECRET-REFUSED',
      'publicConfiguration[0]',
    );
    refused(
      compileAppComposition({
        envelope: emitted['orders-desk']!,
        resources,
        registry: registry(),
        publicConfiguration: ['support-email'],
      }),
      'DESC-SECRET-REFUSED',
      'publicConfiguration[0]',
    );
  });
  it('hashes canonical data independent of key order and whitespace', () => {
    const value = JSON.parse(resources['orders.domain.json']!) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 4);
    expect(ok(decodeDescriptorResource(reordered)).digest).toBe(emitted['orders']!.fields['digest']);
    expect(ok(decodeDescriptorResource(reordered)).canonical).toBe(
      ok(decodeDescriptorResource(resources['orders.domain.json']!)).canonical,
    );
  });
});

describe('DESC-Q02 wrong resource/schema/adapter version or digest', () => {
  it('refuses a digest mismatch with source and field attribution', () => {
    const text = resources['orders.domain.json']!.replace('"max-length": 200', '"max-length": 201');
    const result = compileDomainModel({
      envelope: emitted['orders']!,
      resources: { ...resources, 'orders.domain.json': text },
      registry: registry(),
    });
    refused(result, 'DESC-DIGEST-MISMATCH', 'model.digest');
    if (!result.ok)
      expect(result.diagnostics[0]).toMatchObject({
        owner: 'descriptor-candidate/definition/domain-model/orders',
        source: '.ia/src/systems/descriptor-candidate/records/orders.ia',
        resource: 'orders.domain.json',
      });
  });
  it('refuses envelope/resource version skew and invalid versions', () => {
    refused(
      compileDomainModel({
        envelope: { ...emitted['orders']!, fields: { ...emitted['orders']!.fields, version: '1.1.0' } },
        resources,
        registry: registry(),
      }),
      'DESC-ENVELOPE-MISMATCH',
      'model.version',
    );
    refused(
      compileDomainModel({
        envelope: { ...emitted['orders']!, fields: { ...emitted['orders']!.fields, version: 'v1' } },
        resources,
        registry: registry(),
      }),
      'DESC-ENVELOPE-INVALID',
      'model.version',
    );
    const next = rebound(
      emitted['orders']!,
      edit('orders.domain.json', (value) => {
        value['version'] = '1.0';
      }),
    );
    refused(compileDomainModel({ ...next, registry: registry() }), 'DESC-FIELD-INVALID', 'version');
  });
  it('refuses a storage schema version that differs between envelope and resource', () => {
    refused(
      compileStorageBinding({
        envelope: {
          ...emitted['orders-store']!,
          fields: { ...emitted['orders-store']!.fields, 'schema-version': '5.0.0' },
        },
        resources,
        registry: registry(),
        model: orders(),
      }),
      'DESC-ENVELOPE-MISMATCH',
      'storage.schema-version',
    );
  });
  it('refuses an unsupported adapter or port contract version', () => {
    const next = rebound(
      emitted['orders-store']!,
      edit('orders.storage.json', (value) => {
        value['adapter'] = 'relational-store@3';
      }),
    );
    refused(
      compileStorageBinding({ ...next, registry: registry(), model: orders() }),
      'DESC-CONTRACT-VERSION',
      'adapter',
    );
    const port = rebound(
      emitted['orders-store']!,
      edit('orders.storage.json', (value) => {
        value['port'] = 'order-repository@2';
      }),
    );
    refused(compileStorageBinding({ ...port, registry: registry(), model: orders() }), 'DESC-CONTRACT-VERSION', 'port');
    const renamed = rebound(
      emitted['orders-store']!,
      edit('orders.storage.json', (value) => {
        value['adapter'] = 'document-store@2';
      }),
    );
    refused(
      compileStorageBinding({ ...renamed, registry: registry(), model: orders() }),
      'DESC-ENVELOPE-MISMATCH',
      'adapter',
    );
  });
  it('refuses model/storage skew against a different model version or digest', () => {
    const lending = ok(compileDomainModel({ envelope: emitted['lending']!, resources, registry: registry() }));
    refused(
      compileStorageBinding({ envelope: emitted['orders-store']!, resources, registry: registry(), model: lending }),
      'DESC-SKEW',
      'storage.model',
    );
    const evolved = rebound(
      emitted['orders']!,
      edit('orders.domain.json', (value) => {
        value['entities'][1]['fields'][5]['required'] = true;
      }),
    );
    const changed = ok(compileDomainModel({ ...evolved, registry: registry() }));
    refused(
      compileStorageBinding({ envelope: emitted['orders-store']!, resources, registry: registry(), model: changed }),
      'DESC-SKEW',
      'model-digest',
    );
  });
  it('refuses unsupported envelope, resource and registry formats', () => {
    refused(
      compileDomainModel({
        envelope: { ...emitted['orders']!, fields: { ...emitted['orders']!.fields, format: '2' } },
        resources,
        registry: registry(),
      }),
      'DESC-FORMAT-UNSUPPORTED',
      'model.format',
    );
    const next = rebound(
      emitted['orders']!,
      edit('orders.domain.json', (value) => {
        value['format'] = 2;
        value['subtypes'] = [];
      }),
    );
    refused(compileDomainModel({ ...next, registry: registry() }), 'DESC-FORMAT-UNSUPPORTED', 'format');
    refused(createDescriptorRegistry({ ...registryData, format: 2 }), 'DESC-FORMAT-UNSUPPORTED', 'format');
  });
  it('refuses undisclosed resources and non-relative resource references', () => {
    const { ['orders.domain.json']: _, ...rest } = resources;
    refused(
      compileDomainModel({ envelope: emitted['orders']!, resources: rest, registry: registry() }),
      'DESC-RESOURCE-UNDISCLOSED',
      'model.resource',
    );
    for (const key of [
      'https://cdn.example/orders.json',
      '/etc/orders.json',
      '../orders.domain.json',
      'C:/orders.json',
      'orders.domain.js',
      './orders.domain.json',
    ]) {
      refused(
        compileDomainModel({
          envelope: { ...emitted['orders']!, fields: { ...emitted['orders']!.fields, resource: key } },
          resources: { ...resources, [key]: resources['orders.domain.json']! },
          registry: registry(),
        }),
        'DESC-RESOURCE-REFERENCE',
        'model.resource',
      );
    }
  });
  it('compiles only against a registry issued by the trusted constructor', () => {
    const forged = { ...registry() } as DescriptorRegistry;
    refused(compileDomainModel({ envelope: emitted['orders']!, resources, registry: forged }), 'DESC-REGISTRY-INVALID');
    const duplicate = { ...registryData, contracts: [...registryData.contracts, registryData.contracts[0]!] };
    refused(createDescriptorRegistry(duplicate), 'DESC-NAME-DUPLICATE', 'contracts[16]');
    refused(
      createDescriptorRegistry({
        ...registryData,
        contracts: [{ ...registryData.contracts[0]!, run: () => undefined }],
      }),
      'DESC-REGISTRY-INVALID',
      'contracts[0].run',
    );
    refused(
      createDescriptorRegistry({
        ...registryData,
        contracts: [{ ...registryData.contracts[7]!, targets: ['desktop'] }],
      }),
      'DESC-TARGET-UNSUPPORTED',
      'contracts[0].targets[0]',
    );
  });
});

describe('DESC-Q03 unknown validator/view/operation, module URL or expression', () => {
  it('refuses an unknown required validator but records an unknown optional one as unavailable', () => {
    const next = rebound(
      emitted['orders']!,
      edit('orders.domain.json', (value) => {
        value['invariants'][0]['validator'] = 'order-total-matches-lines@2';
      }),
    );
    refused(compileDomainModel({ ...next, registry: registry() }), 'DESC-CONTRACT-VERSION', 'invariants[0].validator');
    const unknown = rebound(
      emitted['orders']!,
      edit('orders.domain.json', (value) => {
        value['invariants'][0]['validator'] = 'free-shipping-rule@1';
      }),
    );
    refused(
      compileDomainModel({ ...unknown, registry: registry() }),
      'DESC-CONTRACT-UNKNOWN',
      'invariants[0].validator',
    );
  });
  it('refuses unknown commands, views and operations and contract kind or schema confusion', () => {
    const command = rebound(
      emitted['orders']!,
      edit('orders.domain.json', (value) => {
        value['commands'][0]['contract'] = 'refund-order@1';
      }),
    );
    refused(compileDomainModel({ ...command, registry: registry() }), 'DESC-CONTRACT-UNKNOWN', 'commands[0].contract');
    const schema = rebound(
      emitted['orders']!,
      edit('orders.domain.json', (value) => {
        value['commands'][0]['output'] = 'order-page@1';
      }),
    );
    refused(compileDomainModel({ ...schema, registry: registry() }), 'DESC-CONTRACT-SCHEMA', 'commands[0].output');
    const view = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['screens'][0]['view'] = 'kanban-view@1';
      }),
    );
    refused(compileAppComposition({ ...view, registry: registry() }), 'DESC-CONTRACT-UNKNOWN', 'screens[0].view');
    const kind = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['screens'][0]['view'] = 'place-order@1';
      }),
    );
    refused(compileAppComposition({ ...kind, registry: registry() }), 'DESC-CONTRACT-KIND', 'screens[0].view');
    const operation = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['actions'][0]['operation'] = 'refund-order@1';
      }),
    );
    refused(
      compileAppComposition({ ...operation, registry: registry() }),
      'DESC-CONTRACT-UNKNOWN',
      'actions[0].operation',
    );
    const effect = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['actions'][0]['effect'] = 'read';
      }),
    );
    refused(compileAppComposition({ ...effect, registry: registry() }), 'DESC-CONTRACT-SCHEMA', 'actions[0].effect');
    const capability = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['actions'][0]['capability'] = 'orders-admin';
      }),
    );
    refused(
      compileAppComposition({ ...capability, registry: registry() }),
      'DESC-CAPABILITY-UNDECLARED',
      'actions[0].capability',
    );
  });
  it('refuses module URLs, import paths, JavaScript, expressions, CSS, SQL and driver URLs without executing anything', () => {
    const app: [(value: Json) => void, string][] = [
      [
        (value) => {
          value['screens'][0]['view'] = 'https://cdn.example/list-view.js';
        },
        'screens[0].view',
      ],
      [
        (value) => {
          value['screens'][0]['component'] = './components/OrderList.tsx';
        },
        'screens[0].component',
      ],
      [
        (value) => {
          value['screens'][0]['title'] = 'javascript:alert(1)';
        },
        'screens[0].title',
      ],
      [
        (value) => {
          value['screens'][0]['title'] = '${process.env.SECRET}';
        },
        'screens[0].title',
      ],
      [
        (value) => {
          value['screens'][0]['layout']['sort'] = 'row => row.total';
        },
        'screens[0].layout.sort',
      ],
      [
        (value) => {
          value['screens'][0]['style'] = 'color: red';
        },
        'screens[0].style',
      ],
      [
        (value) => {
          value['screens'][0]['layout']['columns'] = 'import("./x.js")';
        },
        'screens[0].layout.columns',
      ],
    ];
    for (const [change, field] of app)
      refused(
        compileAppComposition({
          ...rebound(emitted['orders-desk']!, edit('orders-desk.app.json', change)),
          registry: registry(),
        }),
        'DESC-EXECUTABLE-REFUSED',
        field,
      );
    refused(
      compileDomainModel({
        ...rebound(
          emitted['orders']!,
          edit('orders.domain.json', (value) => {
            value['invariants'][0]['expression'] = 'total >= 0';
          }),
        ),
        registry: registry(),
      }),
      'DESC-EXECUTABLE-REFUSED',
      'invariants[0].expression',
    );
    refused(
      compileStorageBinding({
        ...rebound(
          emitted['orders-store']!,
          edit('orders.storage.json', (value) => {
            value['entities'][0]['sql'] = 'CREATE TABLE customers (id uuid)';
          }),
        ),
        registry: registry(),
        model: orders(),
      }),
      'DESC-EXECUTABLE-REFUSED',
      'entities[0].sql',
    );
    refused(
      compileStorageBinding({
        ...rebound(
          emitted['orders-store']!,
          edit('orders.storage.json', (value) => {
            value['adapter'] = 'postgres://db.internal/orders';
          }),
        ),
        registry: registry(),
        model: orders(),
      }),
      'DESC-EXECUTABLE-REFUSED',
      'adapter',
    );
    let touched = false;
    const trap = new Proxy(
      {},
      {
        get: () => {
          touched = true;
          return undefined;
        },
      },
    );
    refused(createDescriptorRegistry({ ...registryData, contracts: [trap] }), 'DESC-REGISTRY-INVALID', 'contracts[0]');
    expect(touched).toBe(false);
  });
  it('refuses secret values in configuration', () => {
    const secret = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['configuration'][2]['default'] = 'tok_live_123';
      }),
    );
    refused(
      compileAppComposition({ ...secret, registry: registry() }),
      'DESC-SECRET-REFUSED',
      'configuration[2].default',
    );
    const exposed = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['configuration'][2]['visibility'] = 'public';
      }),
    );
    refused(
      compileAppComposition({ ...exposed, registry: registry() }),
      'DESC-SECRET-REFUSED',
      'configuration[2].visibility',
    );
    const password = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['configuration'][1]['password'] = 'hunter2';
      }),
    );
    refused(
      compileAppComposition({ ...password, registry: registry() }),
      'DESC-SECRET-REFUSED',
      'configuration[1].password',
    );
  });
  it('keeps inspection of an unsupported target but refuses its activation (APPD-03)', () => {
    const next = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['screens'][1]['view'] = 'map-view@1';
        value['targets'] = ['headless', 'browser', 'watch'];
      }),
    );
    const app = ok(compileAppComposition({ ...next, registry: registry() }));
    expect(
      app.targets.map((target) => [target.profile, target.status, target.diagnostics.map((d) => [d.code, d.field])]),
    ).toEqual([
      ['headless', 'unsupported', [['DESC-TARGET-UNSUPPORTED', 'screens[1].view']]],
      ['browser', 'supported', []],
      ['watch', 'unsupported', [['DESC-TARGET-UNSUPPORTED', 'targets[2]']]],
    ]);
    refused(activateTarget(app, 'headless'), 'DESC-TARGET-UNSUPPORTED', 'targets[0]');
    refused(activateTarget(app, 'desktop'), 'DESC-TARGET-UNSUPPORTED', 'targets');
    expect(ok(activateTarget(app, 'browser'))).toEqual({
      app: 'orders-desk',
      version: '1.2.0',
      target: 'browser',
      definition: app.digests.definition,
    });
    refused(activateTarget({ ...app } as CompiledAppComposition, 'browser'), 'DESC-DEFINITION-UNTRUSTED');
  });
});

describe('DESC-Q08 unsupported major, size/depth excess, duplicate key', () => {
  it('refuses oversized, too deep, duplicate-key and malformed resources before any schema decoding', () => {
    const padding = ' '.repeat(DESCRIPTOR_LIMITS.resourceBytes);
    refused(decodeDescriptorResource(resources['orders.domain.json']! + padding), 'DESC-RESOURCE-SIZE');
    refused(decodeDescriptorResource('é'.repeat(DESCRIPTOR_LIMITS.resourceBytes / 2 + 1)), 'DESC-RESOURCE-SIZE');
    const deep = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth);
    expect(decodeDescriptorResource(deep(16)).ok).toBe(true);
    refused(decodeDescriptorResource(deep(17)), 'DESC-RESOURCE-DEPTH');
    refused(decodeDescriptorResource('{"format":1,"format":1}'), 'DESC-RESOURCE-DUPLICATE-KEY');
    refused(
      decodeDescriptorResource(
        resources['orders.domain.json']!.replace('"format": 1,', '"format": 1,\n  "format": 1,'),
      ),
      'DESC-RESOURCE-DUPLICATE-KEY',
    );
    for (const text of [
      '{"format":1',
      '{"format":1} {}',
      '{"format":1.5}',
      '{"format":1e400}',
      '{"n":9007199254740993}',
      '\ud800',
    ])
      refused(decodeDescriptorResource(text), 'DESC-RESOURCE-MALFORMED');
  });
  it('refuses unknown fields, features, collection excess and duplicate names deterministically with no partial result', () => {
    const cases: [string, (value: Json) => void, string, string][] = [
      [
        'orders.domain.json',
        (value) => {
          value['features'] = ['subtypes'];
        },
        'DESC-FEATURE-UNSUPPORTED',
        'features[0]',
      ],
      [
        'orders.domain.json',
        (value) => {
          value['entities'][0]['audit'] = true;
        },
        'DESC-FIELD-UNKNOWN',
        'entities[0].audit',
      ],
      [
        'orders.domain.json',
        (value) => {
          delete value['entities'][0]['id'];
        },
        'DESC-FIELD-MISSING',
        'entities[0].id',
      ],
      [
        'orders.domain.json',
        (value) => {
          value['entities'][1]['fields'][1]['name'] = 'id';
        },
        'DESC-NAME-DUPLICATE',
        'entities[1].fields[1].name',
      ],
      [
        'orders.domain.json',
        (value) => {
          value['entities'][1]['fields'] = Array.from({ length: DESCRIPTOR_LIMITS.entries + 1 }, (_, index) => ({
            name: `f${index}`,
            required: false,
            type: { scalar: 'boolean' },
          }));
        },
        'DESC-ENTRIES-EXCEEDED',
        'entities[1].fields',
      ],
      [
        'orders.domain.json',
        (value) => {
          value['entities'][1]['fields'][1]['type']['reference']['entity'] = 'supplier';
        },
        'DESC-REFERENCE-UNRESOLVED',
        'entities[1].fields[1].type.reference',
      ],
      [
        'orders.domain.json',
        (value) => {
          value['entities'][1]['fields'][1]['type']['reference']['version'] = '0.9.0';
        },
        'DESC-REFERENCE-UNRESOLVED',
        'entities[1].fields[1].type.reference',
      ],
      [
        'orders.domain.json',
        (value) => {
          value['entities'][1]['fields'][6]['type']['minimum'] = 10;
          value['entities'][1]['fields'][6]['type']['maximum'] = 1;
        },
        'DESC-FIELD-INVALID',
        'entities[1].fields[6].type.maximum',
      ],
      [
        'orders.domain.json',
        (value) => {
          value['entities'][1]['fields'][2]['type']['values'] = ['open', 'open'];
        },
        'DESC-NAME-DUPLICATE',
        'entities[1].fields[2].type.values[1]',
      ],
      [
        'orders.domain.json',
        (value) => {
          value['model'] = 'shop';
        },
        'DESC-ENVELOPE-MISMATCH',
        'model',
      ],
    ];
    for (const input of [null, [], 'orders']) refused(compileDomainModel(input as never), 'DESC-ENVELOPE-INVALID', '');
    refused(
      compileAppComposition({
        envelope: { ...emitted['orders-desk']!, extra: true } as never,
        resources,
        registry: registry(),
      }),
      'DESC-ENVELOPE-INVALID',
      'app',
    );
    for (const [name, change, code, field] of cases) {
      const input = { ...rebound(emitted['orders']!, edit(name, change)), registry: registry() };
      const first = compileDomainModel(input),
        second = compileDomainModel(input);
      refused(first, code, field);
      expect(second).toEqual(first);
    }
  });
});

describe('storage mapping validation (STORE-01 producer contribution)', () => {
  it('refuses unmapped required fields, incompatible codecs and unsupported adapter guarantees', () => {
    const cases: [(value: Json) => void, string, string][] = [
      [
        (value) => {
          value['entities'][1]['fields'].splice(3, 1);
        },
        'DESC-MAPPING',
        'entities[1].fields',
      ],
      [
        (value) => {
          value['entities'][1]['fields'][3]['codec'] = 'integer';
        },
        'DESC-MAPPING',
        'entities[1].fields[3].codec',
      ],
      [
        (value) => {
          value['entities'][1]['fields'][0]['field'] = 'reference';
        },
        'DESC-MAPPING',
        'entities[1].fields[0].field',
      ],
      [
        (value) => {
          value['entities'][0]['entity'] = 'supplier';
        },
        'DESC-MAPPING',
        'entities[0].entity',
      ],
      [
        (value) => {
          value['transaction'] = 'none';
        },
        'DESC-FIELD-INVALID',
        'transaction',
      ],
      [
        (value) => {
          delete value['isolation'];
        },
        'DESC-FIELD-MISSING',
        'isolation',
      ],
      [
        (value) => {
          value['migration-policy'] = 'drop-and-recreate@1';
        },
        'DESC-CONTRACT-UNKNOWN',
        'migration-policy',
      ],
    ];
    for (const [change, code, field] of cases)
      refused(
        compileStorageBinding({
          ...rebound(emitted['orders-store']!, edit('orders.storage.json', change)),
          registry: registry(),
          model: orders(),
        }),
        code,
        field,
      );
    const adapter = registryData.contracts.map((contract) =>
      contract['kind'] === 'adapter' ? { ...contract, transactions: ['model'] } : contract,
    );
    refused(
      compileStorageBinding({
        envelope: emitted['orders-store']!,
        resources,
        registry: ok(createDescriptorRegistry({ ...registryData, contracts: adapter })),
        model: orders(),
      }),
      'DESC-STORAGE-UNSUPPORTED',
      'transaction',
    );
    const shared = registryData.contracts.map((contract) =>
      contract['kind'] === 'adapter' ? { ...contract, isolation: false } : contract,
    );
    refused(
      compileStorageBinding({
        envelope: emitted['orders-store']!,
        resources,
        registry: ok(createDescriptorRegistry({ ...registryData, contracts: shared })),
        model: orders(),
      }),
      'DESC-STORAGE-UNSUPPORTED',
      'isolation',
    );
  });
});

describe('model evolution classification (DOM-02 producer contribution)', () => {
  const evolve = (change: (value: Json) => void, version = '1.1.0'): CompiledDomainModel => {
    const text = edit('orders.domain.json', (value) => {
      value['version'] = version;
      for (const entity of value['entities'])
        for (const field of entity['fields'])
          if (field['type']['reference']) field['type']['reference']['version'] = version;
      change(value);
    });
    return ok(compileDomainModel({ ...rebound(emitted['orders']!, text, { version }), registry: registry() }));
  };
  it('classifies additions, removals, requiredness, identifier and enum changes against consumers', () => {
    const base = orders();
    expect(classifyModelChange(base, base)).toMatchObject({ compatibility: 'identical', changes: [] });
    const rows: [(value: Json) => void, string, string][] = [
      [
        (value) => {
          value['entities'][1]['fields'].push({
            name: 'note',
            required: false,
            type: { scalar: 'string', 'max-length': 80 },
          });
        },
        'field-added',
        'compatible',
      ],
      [
        (value) => {
          value['entities'][1]['fields'].push({
            name: 'channel',
            required: true,
            type: { scalar: 'string', 'max-length': 80 },
          });
        },
        'field-added',
        'breaking',
      ],
      [
        (value) => {
          value['entities'][1]['fields'].splice(5, 1);
        },
        'field-removed',
        'breaking',
      ],
      [
        (value) => {
          value['entities'][1]['fields'][5]['required'] = true;
        },
        'requiredness-tightened',
        'breaking',
      ],
      [
        (value) => {
          value['entities'][1]['fields'][4]['required'] = false;
        },
        'requiredness-relaxed',
        'compatible',
      ],
      [
        (value) => {
          value['entities'][1]['id']['codec'] = 'text';
        },
        'identifier-changed',
        'breaking',
      ],
      [
        (value) => {
          value['entities'][1]['fields'][2]['type']['values'].push('refunded');
        },
        'enum-widened',
        'compatible',
      ],
      [
        (value) => {
          value['entities'][1]['fields'][2]['type']['values'].pop();
        },
        'enum-narrowed',
        'breaking',
      ],
      [
        (value) => {
          value['entities'][1]['fields'][6]['type']['maximum'] = 100;
        },
        'type-changed',
        'breaking',
      ],
    ];
    for (const [change, kind, compatibility] of rows) {
      const report = classifyModelChange(base, evolve(change));
      expect(
        report.changes.map((row) => [row.change, row.compatibility]),
        kind,
      ).toEqual([[kind, compatibility]]);
      expect(report).toMatchObject({
        model: 'orders',
        from: { version: '1.0.0', digest: base.resource.digest },
        to: { version: '1.1.0' },
        compatibility,
      });
    }
    expect(() =>
      classifyModelChange(
        base,
        ok(compileDomainModel({ envelope: emitted['lending']!, resources, registry: registry() })),
      ),
    ).toThrow(/different models/);
  });
});

describe('LK-17 repair: review findings', () => {
  const evolve = (change: (value: Json) => void): CompiledDomainModel => {
    const text = edit('orders.domain.json', (value) => {
      value['version'] = '1.1.0';
      for (const entity of value['entities'])
        for (const field of entity['fields'])
          if (field['type']['reference']) field['type']['reference']['version'] = '1.1.0';
      change(value);
    });
    return ok(compileDomainModel({ ...rebound(emitted['orders']!, text, { version: '1.1.0' }), registry: registry() }));
  };
  it('S1 classifies resolved value-type changes and contract removals (DOM-02)', () => {
    const base = orders();
    const rows: [(value: Json) => void, string, string][] = [
      [
        (value) => {
          value['values'][0]['type']['precision'] = 2;
        },
        'type-changed',
        'breaking',
      ],
      [
        (value) => {
          value['commands'].splice(1, 1);
        },
        'command-removed',
        'breaking',
      ],
      [
        (value) => {
          value['queries'] = [];
        },
        'query-removed',
        'breaking',
      ],
      [
        (value) => {
          value['commands'][0]['contract'] = 'cancel-order@1';
          value['commands'][0]['input'] = 'order-ref@1';
        },
        'command-changed',
        'breaking',
      ],
      [
        (value) => {
          value['invariants'].splice(0, 1);
        },
        'invariant-removed',
        'breaking',
      ],
      [
        (value) => {
          value['invariants'][1]['required'] = true;
          value['invariants'][1]['validator'] = 'order-total-matches-lines@1';
        },
        'invariant-changed',
        'breaking',
      ],
      [
        (value) => {
          value['invariants'].push({
            name: 'member-rule',
            validator: 'member-in-good-standing@1',
            entity: 'order',
            required: true,
          });
        },
        'invariant-added',
        'breaking',
      ],
      [
        (value) => {
          value['invariants'].push({
            name: 'optional-rule',
            validator: 'free-shipping-rule@1',
            entity: 'order',
            required: false,
          });
        },
        'invariant-added',
        'compatible',
      ],
      [
        (value) => {
          value['commands'].push({
            name: 'open-loan',
            contract: 'open-loan@2',
            input: 'loan-request@2',
            output: 'loan-summary@2',
            error: 'loan-error@1',
          });
        },
        'command-added',
        'compatible',
      ],
    ];
    for (const [change, kind, compatibility] of rows) {
      const report = classifyModelChange(base, evolve(change));
      expect(
        report.changes.map((row) => [row.change, row.compatibility]),
        kind,
      ).toEqual([[kind, compatibility]]);
      expect(report.compatibility).toBe(compatibility);
    }
  });
  it('S2 refuses a model entity with required fields that the binding leaves unmapped (STORE-01)', () => {
    const probe = rebound(
      emitted['orders-store']!,
      edit('orders.storage.json', (value) => {
        value['entities'].splice(0, 1);
      }),
    );
    refused(compileStorageBinding({ ...probe, registry: registry(), model: orders() }), 'DESC-MAPPING', 'entities');
  });
  it('S3 admits 16 non-empty nested containers and refuses 17 (DESC-02)', () => {
    const arrays = (depth: number): string => '['.repeat(depth) + '1' + ']'.repeat(depth);
    const objects = (depth: number): string => '{"a":'.repeat(depth) + 'true' + '}'.repeat(depth);
    for (const nest of [arrays, objects]) {
      expect(decodeDescriptorResource(nest(15)).ok).toBe(true);
      expect(decodeDescriptorResource(nest(16)).ok).toBe(true);
      refused(decodeDescriptorResource(nest(17)), 'DESC-RESOURCE-DEPTH');
    }
  });
  it('Q1 bounds executable-value scanning to linear work on 1 MiB hostile strings', () => {
    const room = DESCRIPTOR_LIMITS.resourceBytes - resources['orders-desk.app.json']!.length - 1024;
    const hostile: string[] = [
      '<' + ' '.repeat(room - 1),
      '<' + ' /'.repeat(room / 2 - 1),
      'import' + ' '.repeat(room - 6),
      'new' + ' '.repeat(room - 3),
      '.'.repeat(room),
      'a:'.repeat(room / 2),
      '$'.repeat(room),
      '='.repeat(room),
      '/'.repeat(room),
      'a'.repeat(room),
    ];
    for (const text of hostile)
      for (const field of ['view', 'title'] as const) {
        const next = rebound(
          emitted['orders-desk']!,
          edit('orders-desk.app.json', (value) => {
            value['screens'][0][field] = text;
          }),
        );
        const started = performance.now(),
          result = compileAppComposition({ ...next, registry: registry() });
        expect(performance.now() - started, `${field} ${JSON.stringify(text.slice(0, 8))}`).toBeLessThan(2_000);
        expect(result.ok).toBe(false);
      }
  }, 120_000);
  it('applies value heuristics only where code could appear and checks the format first', () => {
    for (const title of ['Install Node.js', 'Orders => Archive', 'import (legacy)', '/ home'])
      ok(
        compileAppComposition({
          ...rebound(
            emitted['orders-desk']!,
            edit('orders-desk.app.json', (value) => {
              value['screens'][0]['title'] = title;
            }),
          ),
          registry: registry(),
        }),
      );
    refused(
      compileAppComposition({
        ...rebound(
          emitted['orders-desk']!,
          edit('orders-desk.app.json', (value) => {
            value['format'] = 2;
            value['screens'][0]['component'] = './Card.tsx';
          }),
        ),
        registry: registry(),
      }),
      'DESC-FORMAT-UNSUPPORTED',
      'format',
    );
  });
  it('snapshots envelopes, resources and registry data once and refuses accessors, proxies, cycles and runaway nesting', () => {
    let reads = 0;
    const envelope = { ...emitted['orders']! } as Json;
    Object.defineProperty(envelope, 'source', {
      enumerable: true,
      get: () => (reads++ ? '/etc/passwd' : emitted['orders']!.source),
    });
    refused(
      compileDomainModel({ envelope: envelope as never, resources, registry: registry() }),
      'DESC-ENVELOPE-INVALID',
    );
    refused(
      compileDomainModel({
        envelope: emitted['orders']!,
        resources: new Proxy({ ...resources }, {}),
        registry: registry(),
      }),
      'DESC-RESOURCE-UNDISCLOSED',
    );
    const input = { resources, registry: registry() } as Json;
    Object.defineProperty(input, 'envelope', { enumerable: true, get: () => emitted['orders'] });
    refused(compileDomainModel(input as never), 'DESC-ENVELOPE-INVALID');
    const cyclic = { ...registryData, contracts: [{ ...registryData.contracts[0]! }] } as Json;
    cyclic['contracts'][0]['self'] = cyclic;
    refused(createDescriptorRegistry(cyclic), 'DESC-REGISTRY-INVALID');
    let deep: Json = { leaf: true };
    for (let index = 0; index < 100_000; index++) deep = { nested: deep };
    refused(createDescriptorRegistry({ ...registryData, extra: deep }), 'DESC-REGISTRY-INVALID');
    refused(
      createDescriptorRegistry({ ...registryData, contracts: Array.from({ length: 300_000 }, () => 0) }),
      'DESC-REGISTRY-INVALID',
    );
    refused(decodeDescriptorResource(42 as never), 'DESC-RESOURCE-MALFORMED');
  });
  it('keeps canonical helpers internal and truncates attribution without splitting surrogates', async () => {
    const module = (await import('../src/descriptors/index.js')) as Record<string, unknown>;
    expect('descriptorDigest' in module || 'canonicalDescriptorJson' in module).toBe(false);
    const result = compileDomainModel({
      ...rebound(
        emitted['orders']!,
        edit('orders.domain.json', (value) => {
          value['entities'][0]['\u{1F600}'.repeat(200)] = 1;
        }),
      ),
      registry: registry(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0].code).toBe('DESC-FIELD-UNKNOWN');
      expect(result.diagnostics[0].field.length).toBeLessThanOrEqual(256);
      expect(result.diagnostics[0].field).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
  });
  it('attributes layout keys, requires query target support and cross-checks owner and source', () => {
    refused(
      compileAppComposition({
        ...rebound(
          emitted['orders-desk']!,
          edit('orders-desk.app.json', (value) => {
            value['screens'][0]['layout']['Bad Key'] = 1;
          }),
        ),
        registry: registry(),
      }),
      'DESC-FIELD-INVALID',
      'screens[0].layout.Bad Key',
    );
    refused(
      createDescriptorRegistry({
        ...registryData,
        contracts: [{ ...registryData.contracts[2]!, targets: undefined }].map((contract) =>
          JSON.parse(JSON.stringify(contract)),
        ),
      }),
      'DESC-FIELD-MISSING',
      'contracts[0].targets',
    );
    const headless = registryData.contracts.map((contract) =>
      contract['kind'] === 'query' && contract['id'] === 'list-orders'
        ? { ...contract, targets: ['headless'] }
        : contract,
    );
    const app = ok(
      compileAppComposition({
        envelope: emitted['orders-desk']!,
        resources,
        registry: ok(createDescriptorRegistry({ ...registryData, contracts: headless })),
      }),
    );
    expect(
      app.targets.map((target) => [target.profile, target.status, target.diagnostics.map((d) => d.field)]),
    ).toEqual([
      ['headless', 'supported', []],
      ['browser', 'unsupported', ['screens[0].queries[0]', 'screens[1].queries[0]']],
    ]);
    refused(
      compileDomainModel({
        envelope: { ...emitted['orders']!, source: '.ia/src/systems/agent-system/records/orders.ia' },
        resources,
        registry: registry(),
      }),
      'DESC-ENVELOPE-INVALID',
      'source',
    );
  });
});

describe('LK-17 repair round 2: snapshot guard', () => {
  it('refuses an own __proto__ key in envelopes, resource maps, allowlists and registry data', () => {
    const fields = JSON.parse(
      `{"__proto__":{"evil":"x"},${JSON.stringify(emitted['orders']!.fields).slice(1)}`,
    ) as Json;
    expect(Object.hasOwn(fields, '__proto__')).toBe(true);
    refused(
      compileDomainModel({ envelope: { ...emitted['orders']!, fields } as never, resources, registry: registry() }),
      'DESC-ENVELOPE-INVALID',
      'fields.__proto__',
    );
    const map = JSON.parse(`{"__proto__":{"orders.domain.json":"{}"},${JSON.stringify(resources).slice(1)}`) as Json;
    refused(
      compileDomainModel({ envelope: emitted['orders']!, resources: map as never, registry: registry() }),
      'DESC-RESOURCE-UNDISCLOSED',
      'resources.__proto__',
    );
    const registryText = JSON.stringify(registryData).replace('{"format":1,', '{"__proto__":{"x":1},"format":1,');
    refused(createDescriptorRegistry(JSON.parse(registryText)), 'DESC-REGISTRY-INVALID', '__proto__');
    const contract = JSON.parse(
      JSON.stringify(registryData.contracts[0]).replace('{', '{"__proto__":{"targets":["browser"]},'),
    ) as Json;
    refused(
      createDescriptorRegistry({ ...registryData, contracts: [contract] }),
      'DESC-REGISTRY-INVALID',
      'contracts[0].__proto__',
    );
  });
  it('refuses sparse arrays and arrays with extra keys', () => {
    const sparse = (): string[] => {
      const array: string[] = [];
      array[1] = 'browser';
      array[2] = 'headless';
      return array;
    };
    const holes = sparse() as string[] & { foo?: string };
    holes.foo = 'x';
    refused(createDescriptorRegistry({ ...registryData, targets: holes }), 'DESC-REGISTRY-INVALID', 'targets');
    const trailing = ['browser', 'headless'] as string[] & { foo?: string };
    trailing.length = 3;
    trailing.foo = 'x';
    refused(createDescriptorRegistry({ ...registryData, targets: trailing }), 'DESC-REGISTRY-INVALID', 'targets');
    const named = ['browser', 'headless'] as string[] & { foo?: string };
    named.foo = 'x';
    refused(createDescriptorRegistry({ ...registryData, targets: named }), 'DESC-REGISTRY-INVALID', 'targets');
    refused(createDescriptorRegistry({ ...registryData, targets: sparse() }), 'DESC-REGISTRY-INVALID', 'targets');
  });
  it('refuses oversized collections before reading their properties', () => {
    // Inputs are built outside the timed region; only the refusal is timed.
    const targets = new Array(2_000_000).fill('browser'),
      map = Object.fromEntries(Array.from({ length: 300_000 }, (_, index) => [`r${index}.json`, '{}'])),
      trusted = registry();
    for (const [name, run] of [
      ['registry targets', () => createDescriptorRegistry({ ...registryData, targets })],
      ['resource map', () => compileDomainModel({ envelope: emitted['orders']!, resources: map, registry: trusted })],
    ] as const) {
      const started = performance.now(),
        result = run();
      expect(performance.now() - started, name).toBeLessThan(500);
      expect(result.ok, name).toBe(false);
    }
  });
  it('refuses script URI schemes in display text but not a word followed by a colon and a space', () => {
    const title = (text: string) =>
      compileAppComposition({
        ...rebound(
          emitted['orders-desk']!,
          edit('orders-desk.app.json', (value) => {
            value['screens'][0]['title'] = text;
          }),
        ),
        registry: registry(),
      });
    for (const text of ['Data: overview', 'JavaScript: a guide', 'vbscript: legacy notes']) ok(title(text));
    for (const text of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', ' JavaScript:alert(1)'])
      refused(title(text), 'DESC-EXECUTABLE-REFUSED', 'screens[0].title');
  });
  it('classifies widening a resolved type as breaking', () => {
    const text = edit('orders.domain.json', (value) => {
      value['version'] = '1.1.0';
      for (const entity of value['entities'])
        for (const field of entity['fields'])
          if (field['type']['reference']) field['type']['reference']['version'] = '1.1.0';
      value['values'][0]['type']['precision'] = 14;
    });
    const report = classifyModelChange(
      orders(),
      ok(compileDomainModel({ ...rebound(emitted['orders']!, text, { version: '1.1.0' }), registry: registry() })),
    );
    expect(report.changes.map((row) => [row.change, row.compatibility])).toEqual([['type-changed', 'breaking']]);
  });
  it('restricts envelope source paths to safe segment characters', () => {
    for (const source of [
      '.ia/src/systems/descriptor-candidate/rec\u0000\n‮\u{1F600}.ia',
      '.ia/src/systems/descriptor-candidate/records/or ders.ia',
      '.ia/src/systems/descriptor-candidate/records/or\\ders.ia',
    ]) {
      refused(
        compileDomainModel({ envelope: { ...emitted['orders']!, source }, resources, registry: registry() }),
        'DESC-ENVELOPE-INVALID',
        'source',
      );
    }
    ok(
      compileDomainModel({
        envelope: { ...emitted['orders']!, source: '.ia/src/systems/descriptor-candidate/records/Orders_v1.2-x.ia' },
        resources,
        registry: registry(),
      }),
    );
  });
});

describe('emitted consumer fixture', () => {
  it('bounds attribution in successful unsupported-target inspection diagnostics', () => {
    const input = rebound(
      emitted['orders-desk']!,
      edit('orders-desk.app.json', (value) => {
        value['targets'].push('unavailable-profile');
      }),
    );
    const source = `.ia/src/systems/descriptor-candidate/${'a'.repeat(700)}.ia`;
    const app = ok(compileAppComposition({ ...input, envelope: { ...input.envelope, source }, registry: registry() }));
    const diagnostic = app.targets.find((target) => target.profile === 'unavailable-profile')!.diagnostics[0]!;
    expect(diagnostic.source.length).toBeLessThanOrEqual(256);
    expect(diagnostic.source.endsWith('...')).toBe(true);
    expect(diagnostic.code).toBe('DESC-TARGET-UNSUPPORTED');
    expect(app.source).toBe(source);
    refused(activateTarget(app, 'unavailable-profile'), 'DESC-TARGET-UNSUPPORTED');
  });
  it('refuses a class instance as the compiler input before reading its own fields', () => {
    class CompilerInput {
      envelope = emitted['orders']!;
      resources = resources;
      registry = registry();
    }
    refused(compileDomainModel(new CompilerInput()), 'DESC-ENVELOPE-INVALID');
    const plain = { envelope: emitted['orders']!, resources, registry: registry() };
    ok(compileDomainModel(plain));
    ok(compileDomainModel(Object.assign(Object.create(null), plain)));
  });
  it('matches the source compilation and is reproduced by the built package export', async () => {
    const expected = JSON.parse(read('expected.json')) as Record<string, string>;
    const reg = registry(),
      model = orders();
    const actual = {
      registry: reg.digest,
      orders: model.digests.definition,
      lending: ok(compileDomainModel({ envelope: emitted['lending']!, resources, registry: reg })).digests.definition,
      'orders-store': ok(compileStorageBinding({ envelope: emitted['orders-store']!, resources, registry: reg, model }))
        .digests.definition,
      'orders-desk': ok(
        compileAppComposition({
          envelope: emitted['orders-desk']!,
          resources,
          registry: reg,
          publicConfiguration: ['page-size'],
        }),
      ).digests.definition,
      'lending-kiosk': ok(compileAppComposition({ envelope: emitted['lending-kiosk']!, resources, registry: reg }))
        .digests.definition,
    };
    expect(actual).toEqual(expected);
    const consumer = await runBounded(process.execPath, [resolve(fixtures, 'consumer.mjs'), fixtures], {
      timeoutMs: 30_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(consumer.status, consumer.stderr).toBe(0);
    expect(JSON.parse(consumer.stdout)).toEqual({
      consumer: '@ia/db/descriptors',
      compiled: expected,
      refusals: {
        digest: 'DESC-DIGEST-MISMATCH',
        duplicate: 'DESC-RESOURCE-DUPLICATE-KEY',
        view: 'DESC-CONTRACT-UNKNOWN',
        major: 'DESC-FORMAT-UNSUPPORTED',
      },
    });
  });
});
