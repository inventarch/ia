import type { ReadHandle } from '@ia/db';
import { portableDraftPath } from '@ia/runtime';
import { renderStructuredTemplate, TemplateError } from '@ia/template-system';
import type { CompiledRecord, CompiledValue } from '@ia/language';
import type { Capture } from './corpus.js';
import { resourceOccurrences, resolveResources } from './resources.js';
import type { ResourceKey, ResourceOccurrence } from './resources.js';
import { nativeResourcePath } from './resource-sources.js';
import {
  decodeJson,
  frozen,
  keyOf,
  metadataDigest,
  occurrenceOf,
  portablePath,
  ResourceError,
} from './resource-format.js';

export interface CapturedTemplateOptions {
  readonly reader: ReadHandle;
  readonly within: string;
  readonly owner: ResourceOccurrence;
  readonly allowedResources: readonly ResourceKey[];
  readonly expectedResourcesDigest: string;
  readonly values: unknown;
}
export type CapturedTemplateResult =
  | { readonly status: 'refused'; readonly code: string; readonly message: string }
  | {
      readonly status: 'rendered';
      readonly artifact: {
        readonly path: string;
        readonly text: string;
        readonly bytes: number;
        readonly sha256: string;
      };
      readonly profile: 'structured-v1';
      readonly owner: ResourceOccurrence;
      readonly captureRevision: string;
      readonly viewRevision: string;
      readonly resourcesDigest: string;
      readonly resource: ResourceKey;
      readonly iterations: number;
      readonly digest: string;
    };
function invalid(message: string): never {
  throw new TemplateError('IA-EXEC-TEMPLATE-INVALID', message);
}
function field(record: CompiledRecord, key: string): CompiledValue {
  const fields = record.sections
      .filter((s) => s.name === 'template')
      .flatMap((s) => s.fields)
      .filter((f) => 'key' in f && f.key === key),
    value = fields.length === 1 ? fields[0] : undefined;
  if (!value || !('value' in value) || value.when !== undefined || value.fields !== undefined)
    invalid(`Template needs one unconditional template.${key}`);
  return value.value;
}
function text(value: CompiledValue): string {
  if (!('text' in value)) invalid('Expected compiled template text');
  return value.text;
}
/** Scoped captured resource join. It returns validated draft bytes, never publishes. */
export function renderCapturedTemplate(
  capture: Capture,
  resources: unknown,
  options: CapturedTemplateOptions,
): CapturedTemplateResult {
  try {
    if (!options.within) invalid('Template rendering requires an explicit current scope');
    const inventory = resourceOccurrences(capture),
      owner = inventory.occurrences.find((o) => occurrenceOf(o) === occurrenceOf(options.owner));
    if (!owner) invalid('Template occurrence is not in the selected capture');
    const records = options.reader.records({ within: options.within }),
      record = records.find((r) => r.identity === owner.identity);
    const path = nativeResourcePath(capture, owner);
    if (
      !record ||
      record.discriminator !== 'template' ||
      record.source.path !== path ||
      record.source.line !== owner.line
    )
      invalid('Template occurrence is outside the current scope');
    if (text(field(record, 'profile')) !== 'structured-v1') invalid('Unsupported template profile');
    for (const key of ['parameters', 'lines']) {
      const value = field(record, key);
      if (value.kind !== 'list' || value.items.length)
        invalid('Structured templates require empty legacy parameters/lines');
    }
    const filename = portableDraftPath(text(field(record, 'filename'))),
      resource = portablePath(text(field(record, 'resource')));
    if (/\{\{|\}\}/.test(filename)) invalid('Structured output filename must be fixed');
    const resolution = resolveResources(resources, capture, {
      reader: options.reader,
      within: options.within,
      owners: [owner],
      allowedResources: options.allowedResources,
      expectedDigest: options.expectedResourcesDigest,
      maxBytes: 1024 * 1024,
    });
    const selected = resolution.items.filter(
      (item) => keyOf(item.file.key) === keyOf({ source: owner.source, revision: owner.revision, path: resource }),
    );
    if (
      selected.length !== 1 ||
      selected[0]!.use.role !== 'template' ||
      !selected[0]!.use.required ||
      selected[0]!.file.mediaType !== 'application/json' ||
      selected[0]!.file.encoding !== 'utf8'
    )
      invalid('Structured template needs one required captured JSON template resource');
    const rendered = renderStructuredTemplate(
      decodeJson(selected[0]!.file.content),
      typeof options.values === 'string' ? decodeJson(options.values) : options.values,
    );
    if (filename.endsWith('.json')) decodeJson(rendered.text);
    else if (filename.endsWith('.ia')) {
      // Contextual preview has whole-workspace semantics. Do not use it to probe
      // undisclosed records from a narrower model-facing scope.
      if (!options.reader.isCompleteScope(options.within))
        invalid('IA draft admission requires a complete disclosed workspace scope');
      const target = /^\.ia\/src\/systems\/([a-z][a-z0-9-]*)\/(.+\.ia)$/.exec(filename);
      if (
        !target ||
        target[2] === 'system.ia' ||
        target[2]!.startsWith('schemas/') ||
        !records.some(
          (r) =>
            r.discriminator === 'system' &&
            r.name === target[1] &&
            r.source.path === `.ia/src/systems/${target[1]}/system.ia`,
        )
      )
        invalid('IA output requires an admitted authored instance target');
      const preview = options.reader.preview([{ path: filename, text: rendered.text }]);
      if (
        preview.report.findings.some((f) => f.severity === 'error') ||
        !preview.records.some((r) => r.source.path === filename)
      )
        invalid('Rendered IA draft failed contextual admission');
    } else if (!/\.(md|txt)$/.test(filename)) invalid('Output syntax has no qualified validator');
    const body = {
      status: 'rendered' as const,
      artifact: { path: filename, text: rendered.text, bytes: rendered.bytes, sha256: rendered.sha256 },
      profile: 'structured-v1' as const,
      owner,
      captureRevision: capture.revision,
      viewRevision: options.reader.revision,
      resourcesDigest: resolution.digest,
      resource: selected[0]!.file.key,
      iterations: rendered.iterations,
    };
    return frozen({ ...body, digest: metadataDigest(body) });
  } catch (error) {
    if (error instanceof TemplateError || error instanceof ResourceError)
      return frozen({ status: 'refused', code: error.code, message: error.message });
    // Read-handle scope errors deliberately do not expose hidden records.
    return frozen({
      status: 'refused',
      code: 'IA-EXEC-TEMPLATE-INVALID',
      message: 'Template capture, current scope or output path is unavailable',
    });
  }
}
