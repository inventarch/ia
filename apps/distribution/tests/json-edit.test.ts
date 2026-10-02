import { expect, it } from 'vitest';
import { editJson, emptyJson, jsonLayout, keptPaths, presentJson } from '../src/json-edit.js';

const group = { matcher: 'W', hooks: [{ type: 'command', args: ['x'], timeout: 10 }] };
const pretty = (value: unknown, indent: number | string, eol: string, tail = eol): string =>
  JSON.stringify(value, null, indent).replaceAll('\n', eol) + tail;
/** Remove the element at `index` from an array that already holds it, and check the bytes around it. */
function roundTrip(original: string, index: number, count: number): string {
  const applied = editJson(original, ['hooks', 'PreToolUse', -1], group),
    rows = JSON.parse(applied).hooks.PreToolUse;
  expect(rows).toHaveLength(count + 1);
  expect(rows[count]).toEqual(group);
  expect(editJson(applied, ['hooks', 'PreToolUse', count], undefined, [['hooks'], ['hooks', 'PreToolUse']])).toBe(
    original,
  );
  if (index !== count) {
    // Move the owned element to `index` by rebuilding the array value, then remove it there: only its own member and separator go.
    const moved = [...rows.slice(0, count)];
    moved.splice(index, 0, group);
    const placed = editJson(original, ['hooks', 'PreToolUse'], moved),
      expected = editJson(original, ['hooks', 'PreToolUse'], rows.slice(0, count));
    expect(editJson(placed, ['hooks', 'PreToolUse', index], undefined, [['hooks'], ['hooks', 'PreToolUse']])).toBe(
      expected,
    );
  }
  return applied;
}
it('appends and removes at the last, middle, first and only positions', () => {
  const two = pretty({ hooks: { PreToolUse: [{ matcher: 'A' }, { matcher: 'B' }] } }, 2, '\n');
  roundTrip(two, 2, 2);
  roundTrip(two, 1, 2);
  roundTrip(two, 0, 2);
  const one = pretty({ hooks: { PreToolUse: [{ matcher: 'A' }] }, env: {} }, 2, '\n'),
    applied = roundTrip(one, 1, 1);
  expect(
    applied.startsWith(
      '{\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "A"\n      },\n      {\n        "matcher": "W",',
    ),
  ).toBe(true);
  const only = pretty({ hooks: { PreToolUse: [] }, env: {} }, 2, '\n'),
    owned = editJson(only, ['hooks', 'PreToolUse', -1], group);
  expect(editJson(owned, ['hooks', 'PreToolUse', 0], undefined, [['hooks'], ['hooks', 'PreToolUse']])).toBe(only);
  expect(editJson(owned, ['hooks', 'PreToolUse', 0], undefined, [['hooks']])).toBe(
    pretty({ hooks: {}, env: {} }, 2, '\n'),
  );
  expect(editJson(owned, ['hooks', 'PreToolUse', 0], undefined)).toBe(pretty({ env: {} }, 2, '\n'));
});
it('keeps a file without a trailing newline, a single-line file, tab indentation and CRLF', () => {
  for (const original of [
    pretty({ a: 1, hooks: { PreToolUse: [{ matcher: 'A' }] } }, 2, '\n', ''),
    '{"a":1,"hooks":{"PreToolUse":[{"matcher":"A"}]}}\n',
    pretty({ a: 1, hooks: { PreToolUse: [{ matcher: 'A' }] } }, '\t', '\n'),
    pretty({ a: 1, hooks: { PreToolUse: [{ matcher: 'A' }] } }, 2, '\r\n'),
  ]) {
    const applied = roundTrip(original, 1, 1),
      layout = jsonLayout(original);
    expect(applied.endsWith('\n')).toBe(original.endsWith('\n'));
    if (!layout) {
      expect(applied.trimEnd()).not.toContain('\n');
      continue;
    }
    expect(applied.replaceAll(layout.eol!, '')).not.toMatch(/[\r\n]/);
    expect(applied).toContain(layout.eol + (layout.insertSpaces ? '        ' : '\t\t\t\t') + '"matcher": "W"');
  }
  expect(jsonLayout(null)).toEqual({ insertSpaces: true, tabSize: 2, eol: '\n' });
  expect(editJson(null, ['mcpServers', 'ia-workspace'], { command: 'node' })).toBe(
    '{\n  "mcpServers": {\n    "ia-workspace": {\n      "command": "node"\n    }\n  }\n}\n',
  );
});
it('reports present containers and emptiness, and validates retained paths', () => {
  const text = '{\n  "hooks": {}\n}\n';
  expect(presentJson(text, [['hooks'], ['hooks', 'PreToolUse']])).toEqual([['hooks']]);
  expect(presentJson(null, [['hooks']])).toEqual([]);
  expect(emptyJson('{}\n')).toBe(true);
  expect(emptyJson(text)).toBe(false);
  expect(keptPaths(undefined, [['hooks']])).toEqual([]);
  expect(keptPaths([['hooks']], [['hooks'], ['hooks', 'X']])).toEqual([['hooks']]);
  for (const bad of [[], [['hooks'], ['hooks']], [['other']], 'hooks'])
    expect(() => keptPaths(bad, [['hooks']])).toThrow(/retained settings containers/);
});
it('refuses malformed JSON, non-object documents and an absent owned member', () => {
  for (const bad of ['{"a":1,}', '{"a":1 // note\n}', '{"a":', '{"a":1}{', '[]', '"text"'])
    expect(() => editJson(bad, ['mcpServers', 'x'], {})).toThrow(
      /Malformed JSON settings|Expected a JSON settings object/,
    );
  expect(() => editJson('{"a":1,}', ['a'], 2)).toThrow(/Malformed JSON settings/);
  expect(() => editJson('{}', ['mcpServers', 'x'], undefined)).toThrow(/absent/);
});
