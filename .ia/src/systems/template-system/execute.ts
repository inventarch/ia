import { renderScalarTemplate, TemplateError } from '@ia/template-system';
import { draftPath, evidence, fail, object, preview, string } from '../../../../tools/systems/shared.js';
import { ExecutionError } from '../../../../tools/systems/types.js';
import type { Context, Product } from '../../../../tools/systems/types.js';

export function renderTemplate(context: Context, input: unknown): Product {
  const args = object(input, ['template', 'values']),
    identity = string(args['template']),
    values = object(args['values']);
  const candidates = context.records.filter((r) => r.identity === identity && r.discriminator === 'template');
  if (candidates.length !== 1)
    return fail('IA-EXEC-TEMPLATE-INVALID', 'Template identity must name one admitted @template');
  const record = candidates[0]!;
  let artifact: ReturnType<typeof renderScalarTemplate>;
  try {
    artifact = renderScalarTemplate(record, values);
  } catch (error) {
    if (error instanceof TemplateError) throw new ExecutionError(error.code, error.message);
    throw error;
  }
  const artifacts = [artifact];
  if (artifact.path.endsWith('.ia')) {
    const result = preview(context, draftPath(context, artifact.path), artifact.text);
    return { artifacts, preview: result, evidence: evidence(result) };
  }
  return { artifacts, evidence: { template: record.identity, source: record.source } };
}
