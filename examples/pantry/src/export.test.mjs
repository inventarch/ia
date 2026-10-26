import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shoppingList } from './export.mjs';

test('merges repeated ingredients into one item', () => {
  const list = shoppingList([
    {
      ingredients: [
        { name: 'flour', quantity: '200 g' },
        { name: 'eggs', quantity: '2' },
      ],
    },
    { ingredients: [{ name: 'eggs', quantity: '3' }] },
  ]);
  assert.equal(list, '- [ ] flour (200 g)\n- [ ] eggs (2 + 3)\n');
});
