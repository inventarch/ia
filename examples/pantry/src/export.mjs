// Merge the ingredients of the picked recipes into one Markdown checklist.
export function shoppingList(recipes) {
  const items = new Map();
  for (const recipe of recipes)
    for (const { name, quantity } of recipe.ingredients) items.set(name, [...(items.get(name) ?? []), quantity]);
  return [...items].map(([name, quantities]) => `- [ ] ${name} (${quantities.join(' + ')})`).join('\n') + '\n';
}
