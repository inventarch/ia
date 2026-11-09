import { expect, it } from 'vitest';
import { renderStructuredTemplate, verifyStructuredTemplate } from '../src/index.js';

const body = {
  inputs: { name: { type: 'text', required: true } },
  nodes: [
    { kind: 'text', text: 'Hello ' },
    { kind: 'value', input: 'name' },
  ],
};

it('reads a structured template under the plain stamp and under the original literal, as written', () => {
  const current = verifyStructuredTemplate({ format: 'structured-template', formatVersion: 1, ...body }),
    original = verifyStructuredTemplate({ format: 'ia.structured-template.v1', ...body });
  expect(current).toEqual({ format: 'structured-template', formatVersion: 1, ...body });
  expect(original).toEqual({ format: 'ia.structured-template.v1', ...body });
  expect(Object.hasOwn(original, 'formatVersion')).toBe(false);
  // Both render the same bytes: only the stamp differs.
  expect(renderStructuredTemplate(current, { name: 'IA' }).text).toBe('Hello IA');
  expect(renderStructuredTemplate(original, { name: 'IA' }).text).toBe('Hello IA');
});

it('refuses a structured template that is neither the plain stamp nor the original literal', () => {
  for (const stamp of [
    { format: 'structured-template' },
    { format: 'structured-template', formatVersion: 2 },
    { format: 'structured-template', formatVersion: '1' },
    { format: 'ia.structured-template.v1', formatVersion: 1 },
    { format: 'ia.structured-template.v2' },
    { format: 'ia.structured-template' },
    {},
  ])
    expect(() => verifyStructuredTemplate({ ...stamp, ...body })).toThrow(
      /Unknown structured template format|Unknown, missing/,
    );
});
