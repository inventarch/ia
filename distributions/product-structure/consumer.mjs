/** Pure structural consumer over an admitted public EditorSnapshot. No authority or effects. */
export function readProduct(snapshot, identity, revision = snapshot.revision) {
  if (
    revision !== snapshot.revision ||
    snapshot.report.findings.some((finding) => finding.severity === 'error') ||
    snapshot.refused.length ||
    snapshot.inspect().blockedSystems.length
  )
    throw new Error('PRODUCT_ADMISSION');
  const records = snapshot.records({ revision });
  const node = records.find((record) => record.identity === identity);
  if (!node || node.discriminator !== 'product' || node.system !== 'product-system')
    throw new Error('PRODUCT_IDENTITY');
  const fields = node.sections.find((section) => section.name === 'product')?.fields ?? [];
  const field = (key) => fields.find((item) => item.key === key)?.value;
  const format = field('format'),
    title = field('title'),
    status = field('status'),
    owner = field('owner'),
    plans = field('plans');
  if (
    format?.kind !== 'scalar' ||
    format.text !== '1' ||
    !title ||
    !('text' in title) ||
    !title.text.trim() ||
    !status ||
    !('text' in status) ||
    !['proposed', 'active', 'retired'].includes(status.text)
  )
    throw new Error('PRODUCT_FIELDS');
  function target(ref, word) {
    if (ref?.kind !== 'ref' || ref.discriminator !== word || ref.fragment) throw new Error('PRODUCT_REFERENCE');
    const result = snapshot.resolve(ref, { revision });
    if (!result.ok || !records.some((record) => record.identity === result.identity && record.discriminator === word))
      throw new Error('PRODUCT_REFERENCE');
    return result.identity;
  }
  if (plans?.kind !== 'list') throw new Error('PRODUCT_REFERENCE');
  const planIds = plans.items.map((ref) => target(ref, 'plan'));
  if (new Set(planIds).size !== planIds.length) throw new Error('PRODUCT_REFERENCE');
  return {
    identity: node.identity,
    revision,
    title: title.text,
    status: status.text,
    owner: target(owner, 'agent'),
    plans: planIds,
  };
}
