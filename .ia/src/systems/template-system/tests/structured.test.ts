import { expect, it } from 'vitest';
import { renderStructuredTemplate, verifyStructuredTemplate, TEMPLATE_LIMITS } from '../src/index.js';
import type { StructuredTemplate, TemplateNode, InputSchema } from '../src/index.js';

const text = (text: string): TemplateNode => ({ kind: 'text', text });
const value = (input: string): TemplateNode => ({ kind: 'value', input });
const template = (inputs: Record<string, InputSchema>, nodes: TemplateNode[]): StructuredTemplate => ({
  format: 'ia.structured-template.v1',
  inputs,
  nodes,
});
const scalar = { type: 'text' as const, required: true };
const design = template(
  {
    project: scalar,
    tokens: {
      type: 'list',
      required: true,
      items: { name: scalar, value: scalar, rationale: { type: 'text', required: false } },
    },
  },
  [
    text('# '),
    value('project'),
    text(' design system\n'),
    {
      kind: 'each',
      input: 'tokens',
      item: 'token',
      children: [
        text('- '),
        value('token.name'),
        text(': '),
        value('token.value'),
        {
          kind: 'optional',
          input: 'token.rationale',
          test: 'present',
          children: [text(' — '), value('token.rationale')],
        },
        text('\n'),
      ],
    },
  ],
);
const plan = template(
  {
    title: scalar,
    tasks: { type: 'list', required: true, items: { name: scalar, done: { type: 'boolean', required: true } } },
    risks: { type: 'text', required: false },
  },
  [
    text('# '),
    value('title'),
    text('\n'),
    {
      kind: 'each',
      input: 'tasks',
      item: 'task',
      children: [
        text('- '),
        value('task.name'),
        { kind: 'optional', input: 'task.done', test: 'true', children: [text(' (done)')] },
        text('\n'),
      ],
    },
    { kind: 'optional', input: 'risks', test: 'present', children: [text('Risks: '), value('risks'), text('\n')] },
  ],
);
const deploy = template(
  {
    version: scalar,
    healthy: { type: 'boolean', required: true },
    instances: { type: 'integer', required: true },
    changes: { type: 'list', required: true, items: { description: scalar } },
  },
  [
    text('Release '),
    value('version'),
    text('\nInstances: '),
    value('instances'),
    text('\n'),
    { kind: 'optional', input: 'healthy', test: 'true', children: [text('Health checks passed\n')] },
    { kind: 'each', input: 'changes', item: 'change', children: [text('- '), value('change.description'), text('\n')] },
  ],
);
it('renders a design system with ordered tokens and optional per-item rationale', () => {
  const values = {
    project: 'Original fixture',
    tokens: [
      { name: 'accent', value: '#123456', rationale: 'Observed existing token' },
      { name: 'spacing', value: '8px' },
    ],
  };
  const result = renderStructuredTemplate(design, values);
  expect(result.text).toBe(
    '# Original fixture design system\n- accent: #123456 — Observed existing token\n- spacing: 8px\n',
  );
  expect(result.iterations).toBe(2);
  expect(result.bytes).toBe(Buffer.byteLength(result.text));
  expect(renderStructuredTemplate(JSON.parse(JSON.stringify(design)), JSON.parse(JSON.stringify(values)))).toEqual(
    result,
  );
  expect(renderStructuredTemplate(design, { project: 'Empty', tokens: [] }).text).toBe('# Empty design system\n');
});
it('renders plans with boolean conditions and optional sections', () => {
  expect(
    renderStructuredTemplate(plan, {
      title: 'Install',
      tasks: [
        { name: 'Prepare', done: true },
        { name: 'Verify', done: false },
      ],
      risks: 'Host unavailable',
    }).text,
  ).toBe('# Install\n- Prepare (done)\n- Verify\nRisks: Host unavailable\n');
  expect(renderStructuredTemplate(plan, { title: 'Install', tasks: [] }).text).toBe('# Install\n');
});
it('renders deploy summaries without treating supplied values as template instructions', () => {
  expect(
    renderStructuredTemplate(deploy, {
      version: '{{version}}',
      healthy: true,
      instances: 2,
      changes: [{ description: '${process.env.SECRET}' }],
    }).text,
  ).toBe('Release {{version}}\nInstances: 2\nHealth checks passed\n- ${process.env.SECRET}\n');
  expect(
    renderStructuredTemplate(deploy, { version: 'v1', healthy: false, instances: 0, changes: [] }).text,
  ).not.toContain('passed');
});
it.each([
  { project: 'x', tokens: [], unknown: 1 },
  { tokens: [] },
  { project: 7, tokens: [] },
  { project: 'x', tokens: [{ name: 'n', value: 'v', extra: 'hidden' }] },
  { project: 'x', tokens: [{ name: 'n' }] },
  { project: 'x', tokens: [{ name: 'n', value: false }] },
  { project: '\ud800', tokens: [] },
  { project: 'x', tokens: Array.from({ length: 101 }, () => ({ name: 'n', value: 'v' })) },
])('refuses malformed or unknown input %#', (values) => {
  expect(() => renderStructuredTemplate(design, values)).toThrow();
});
it('refuses unknown/unused declarations, properties, aliases, includes and expressions', () => {
  const malformed = [
    template({ extra: scalar }, [text('unused')]),
    template({}, [value('constructor')]),
    template({ title: scalar }, [value('title.toString')]),
    template({ title: scalar }, [{ kind: 'optional', input: 'title', test: 'true', children: [] }]),
    template({ values: { type: 'list', required: true, items: { title: scalar, unused: scalar } } }, [
      { kind: 'each', input: 'values', item: 'item', children: [value('item.title')] },
    ]),
    template({ values: { type: 'list', required: true, items: { title: scalar } } }, [
      { kind: 'each', input: 'values', item: 'values', children: [value('values.title')] },
    ]),
    template({ values: { type: 'list', required: true, items: { title: scalar } } }, [
      { kind: 'each', input: 'values', item: 'item', children: [value('item.constructor')] },
    ]),
    { ...design, extra: true },
    { ...design, nodes: [{ kind: 'include', path: '/etc/passwd' }] },
    { ...design, nodes: [{ kind: 'value', input: 'project', expression: 'eval()' }] },
  ];
  for (const value of malformed) expect(() => verifyStructuredTemplate(value)).toThrow();
});
it('treats inherited-looking identifiers as declared data and omitted optional data as absent', () => {
  const t = template({ constructor: { type: 'text' as const, required: false } }, [
    { kind: 'optional', input: 'constructor', test: 'present', children: [value('constructor')] },
  ]);
  expect(renderStructuredTemplate(t, {}).text).toBe('');
  expect(renderStructuredTemplate(t, { constructor: 'own value' }).text).toBe('own value');
});
it('refuses getters without executing them', () => {
  let called = false;
  const input = Object.defineProperty({}, 'project', {
    enumerable: true,
    get: () => {
      called = true;
      return 'x';
    },
  });
  expect(() => renderStructuredTemplate(design, input)).toThrow();
  expect(called).toBe(false);
});
it('enforces depth, node count, input bytes, total output and total iterations', () => {
  let deep: TemplateNode[] = [value('flag')];
  for (let i = 0; i < 8; i++) deep = [{ kind: 'optional', input: 'flag', test: 'true', children: deep }];
  expect(() => verifyStructuredTemplate(template({ flag: { type: 'boolean', required: true } }, deep))).toThrow(
    'depth',
  );
  expect(() =>
    verifyStructuredTemplate(
      template(
        {},
        Array.from({ length: 1025 }, () => text('x')),
      ),
    ),
  ).toThrow('bound');
  expect(() => renderStructuredTemplate(design, { project: 'x'.repeat(65536), tokens: [] })).toThrow('64 KiB');
  const big = template({ items: { type: 'list', required: true, items: { value: scalar } } }, [
    { kind: 'each', input: 'items', item: 'row', children: [text('x'.repeat(15000)), value('row.value')] },
  ]);
  expect(() => renderStructuredTemplate(big, { items: Array.from({ length: 100 }, () => ({ value: '' })) })).toThrow(
    '1 MiB',
  );
  const nested = template({ items: { type: 'list', required: true, items: { value: scalar } } }, [
    {
      kind: 'each',
      input: 'items',
      item: 'outer',
      children: [
        value('outer.value'),
        { kind: 'each', input: 'items', item: 'inner', children: [value('inner.value')] },
      ],
    },
  ]);
  expect(() => renderStructuredTemplate(nested, { items: Array.from({ length: 32 }, () => ({ value: 'x' })) })).toThrow(
    'iteration',
  );
  expect(TEMPLATE_LIMITS.iterations).toBe(1000);
});
