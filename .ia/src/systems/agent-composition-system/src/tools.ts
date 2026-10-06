import { createHash } from 'node:crypto';
import { EditorSnapshot } from '@inventarch/db/editor';
import { DraftError, formatDraft, validateDraft } from '@inventarch/authoring-system';
import { manifestDigest, validateShape } from '@inventarch/agent-system';
import type { Manifest, OperationAdapter, OperationContext } from '@inventarch/agent-system';
import { canonical, copy, digest, SessionError } from '@inventarch/session-system';
import type { Json } from '@inventarch/session-system';
import { installed } from './catalog.js';
import type { CompositionCatalog } from './catalog.js';

import { verifyCapture } from '@inventarch/workspace-runtime/corpus';
import type { Capture } from '@inventarch/workspace-runtime/corpus';
import { resourceOccurrences, verifyResources } from '@inventarch/workspace-runtime/resources';
import type { ResourceKey } from '@inventarch/workspace-runtime/resources';
import { renderCapturedTemplate } from '@inventarch/workspace-runtime/templates';

const prefix = 'authoring-system/binding/operation/';
export const DRAFT_TOOL_IDS = Object.freeze({
  validate: prefix + 'validate-draft',
  format: prefix + 'format-draft',
  render: prefix + 'render-captured-template',
});
const profiles = [
  {
    id: DRAFT_TOOL_IDS.validate,
    name: 'draft-validate-v1',
    handler: 'ia.draft.validate.v1',
    owner: 'authoring-system',
    input: 'draft-text-v1',
  },
  {
    id: DRAFT_TOOL_IDS.format,
    name: 'draft-format-v1',
    handler: 'ia.draft.format.v1',
    owner: 'authoring-system',
    input: 'draft-text-v1',
  },
  {
    id: DRAFT_TOOL_IDS.render,
    name: 'captured-template-render-v1',
    handler: 'ia.template.render.v1',
    owner: 'template-system',
    input: 'captured-template-input-v1',
  },
] as const;
const object = (properties: Record<string, Json>): Json => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string = (maxLength = 2048): Json => ({ type: 'string', maxLength });
const output = object({
  status: { type: 'string', enum: ['validated', 'draft', 'refused'] },
  code: string(128),
  message: string(1024),
  baseRevision: string(64),
  candidateRevision: string(64),
  evidenceDigest: string(64),
  admitted: { type: 'integer', minimum: 0 },
  unavailable: { type: 'integer', minimum: 0 },
  artifacts: { type: 'array', maxItems: 1, items: object({ path: string(), text: string(65536), sha256: string(64) }) },
  diagnostics: {
    type: 'array',
    maxItems: 128,
    items: object({ code: string(128), path: string(), line: { type: 'integer', minimum: 0 } }),
  },
});
export interface TemplateToolSelection {
  readonly digest: string;
  readonly allowed: readonly ResourceKey[];
  readonly templates: readonly string[];
}
/** Installed descriptions, not authority; unavailable native bindings still refuse compilation. */
export function draftToolCatalog(
  model: string,
  implementationDigest: string,
  resources?: TemplateToolSelection,
): CompositionCatalog {
  if (!/^[a-f0-9]{64}$/.test(implementationDigest))
    throw new SessionError('IA-TOOLS-UNAVAILABLE', 'Installed draft implementation pin is required');
  const catalog: CompositionCatalog = {
    hosts: {},
    models: { 'host-model': installed({ model }) },
    validators: {},
    outcomes: {},
    mandates: {},
    contexts: {},
    operations: {},
    evaluators: {},
    entries: {},
    mappings: {},
  };
  catalog.validators['draft-text-v1'] = installed({ schema: object({ path: string(), text: string(49152) }) });
  catalog.validators['captured-template-input-v1'] = installed({
    schema: object({ template: string(), values: string(49152) }),
  });
  catalog.validators['draft-result-v1'] = installed({ schema: output });
  const renderPin = digest({
    implementationDigest,
    resources: resources
      ? { digest: resources.digest, allowed: resources.allowed, templates: resources.templates }
      : null,
  });
  for (const profile of profiles)
    catalog.operations[profile.name] = installed({
      identity: profile.id,
      owner: profile.owner,
      handler: profile.handler,
      implementationDigest: profile.id === DRAFT_TOOL_IDS.render ? renderPin : implementationDigest,
      input: profile.input,
      output: 'draft-result-v1',
      effects: ['read'],
      recovery: 'repeatable',
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      preflight: 'captured-workspace',
    });
  return catalog;
}
export interface DraftToolOptions {
  readonly manifest: Manifest;
  readonly principal: string;
  readonly implementationDigest: string;
  readonly current: () => boolean | Promise<boolean>;
  readonly identities?: readonly string[];
  readonly resources?: TemplateToolSelection & { readonly envelope: unknown };
}
function denied(message: string): never {
  throw new SessionError('IA-TOOLS-DENIED', message);
}
/** Host-owned captured adapters. Model arguments cannot select authority, sources or code. */
export function draftToolAdapters(
  input: Capture,
  options: DraftToolOptions,
): { operations: Readonly<Record<string, OperationAdapter>>; close(): void } {
  const capture = verifyCapture(input),
    manifest = copy(options.manifest),
    principal = options.principal,
    current = options.current;
  if (
    !principal ||
    typeof current !== 'function' ||
    manifestDigest(manifest) !== manifest.digest ||
    manifest.sourceDigest !== capture.revision
  )
    denied('Draft host bindings are unavailable');
  const catalog = draftToolCatalog('host-bound', options.implementationDigest, options.resources),
    resources = options.resources
      ? {
          ...copy({
            digest: options.resources.digest,
            allowed: options.resources.allowed,
            templates: options.resources.templates,
          }),
          envelope: verifyResources(options.resources.envelope, capture),
        }
      : undefined;
  if (resources && resources.envelope.digest !== resources.digest) denied('Template resource pin differs');
  const reader = new EditorSnapshot({
    root: process.cwd(),
    sources: capture.sources,
    folders: capture.folders,
    floorOrigin: capture.floorOrigin,
    fingerprint: capture.revision,
    ...(capture.activation ? { activation: capture.activation } : {}),
  });
  try {
    const within = reader.resolveScope(options.identities ? { identities: options.identities } : {}).token,
      revision = reader.revision;
    const refusal = (code: string, message: string): Json => ({
      status: 'refused',
      code,
      message,
      baseRevision: revision,
      candidateRevision: '',
      evidenceDigest: '',
      admitted: 0,
      unavailable: 0,
      artifacts: [],
      diagnostics: [],
    });
    const operations: Record<string, OperationAdapter> = {};
    for (const profile of profiles) {
      const definition = manifest.operations[profile.id];
      if (!definition) continue;
      const descriptor = catalog.operations[profile.name]!.value,
        expectedInput = catalog.validators[profile.input]!.value.schema;
      const pins = (
        manifest.provenance as {
          compiled?: { provenance?: { installed?: { group: string; id: string; digest: string }[] } };
        }
      ).compiled?.provenance?.installed;
      if (
        definition.handler !== profile.handler ||
        canonical(definition.effects) !== canonical(['read']) ||
        definition.recovery !== 'repeatable' ||
        definition.timeoutMs !== descriptor.timeoutMs ||
        definition.maxOutputBytes !== 65536 ||
        canonical(definition.input) !== canonical(expectedInput) ||
        canonical(definition.output) !== canonical(output) ||
        !pins?.some(
          (pin) =>
            pin.group === 'operations' &&
            pin.id === profile.name &&
            pin.digest === catalog.operations[profile.name]!.digest,
        )
      )
        denied('Draft operation differs from the installed descriptor');
      const authorize = async (context: OperationContext): Promise<void> => {
        context.signal.throwIfAborted();
        const check = (): void => {
          if (
            !context.assertCurrent ||
            context.principal !== principal ||
            context.grant.principal !== principal ||
            context.manifest.digest !== manifest.digest ||
            manifestDigest(context.manifest) !== manifest.digest ||
            context.grant.workspace !== manifest.workspace ||
            context.grant.expiresAt <= Date.now() ||
            !context.grant.operations.includes(profile.id) ||
            !context.grant.effects.includes('read') ||
            !context.grant.sources.includes(capture.revision)
          )
            denied('Draft request exceeds current host authority');
        };
        check();
        await context.assertCurrent!();
        check();
        if (!(await current())) denied('Draft source, resource or implementation selection changed');
        context.signal.throwIfAborted();
      };
      operations[profile.handler] = {
        id: profile.handler,
        execute: async (args, context) => {
          await authorize(context);
          if (!validateShape(expectedInput, args) || Buffer.byteLength(canonical(args)) > 65536)
            denied('Draft arguments do not match the installed schema');
          let result: Json;
          try {
            if (profile.id === DRAFT_TOOL_IDS.render) {
              const values = args as { template: string; values: string },
                owner = resourceOccurrences(capture).occurrences.find((o) => o.identity === values.template);
              if (!resources || !resources.templates.includes(values.template) || !owner)
                result = refusal(
                  'IA-TOOLS-RESOURCE-UNAVAILABLE',
                  'Template is outside the installed resource selection',
                );
              else {
                const rendered = renderCapturedTemplate(capture, resources.envelope, {
                  reader,
                  within,
                  owner,
                  allowedResources: resources.allowed,
                  expectedResourcesDigest: resources.digest,
                  values: values.values,
                });
                result =
                  rendered.status === 'refused'
                    ? refusal(rendered.code, rendered.message)
                    : {
                        status: 'draft',
                        code: '',
                        message: 'Structured draft rendered; no file was written.',
                        baseRevision: revision,
                        candidateRevision: '',
                        evidenceDigest: rendered.digest,
                        admitted: 0,
                        unavailable: 0,
                        artifacts: [
                          {
                            path: rendered.artifact.path,
                            text: rendered.artifact.text,
                            sha256: rendered.artifact.sha256,
                          },
                        ],
                        diagnostics: [],
                      };
              }
            } else {
              const rendered = (profile.id === DRAFT_TOOL_IDS.validate ? validateDraft : formatDraft)(
                { reader, within, revision },
                args,
              );
              result = {
                status: profile.id === DRAFT_TOOL_IDS.validate ? 'validated' : 'draft',
                code: '',
                message: 'Contextual draft admitted; no file was written.',
                baseRevision: rendered.baseRevision,
                candidateRevision: rendered.candidateRevision,
                evidenceDigest: digest(rendered.evidence),
                admitted: rendered.evidence.admitted,
                unavailable: rendered.evidence.unavailable.length,
                artifacts: rendered.artifacts.map((artifact) => ({
                  ...artifact,
                  sha256: createHash('sha256').update(artifact.text).digest('hex'),
                })),
                diagnostics: rendered.evidence.findings.map((finding) => ({
                  code: finding.code,
                  path: finding.path,
                  line: finding.line,
                })),
              };
            }
          } catch (error) {
            if (!(error instanceof DraftError)) throw error;
            result = refusal(error.code, error.message);
          }
          if (Buffer.byteLength(canonical(result)) > 65536 || !validateShape(output, result))
            result = refusal(
              'IA-TOOLS-RESULT-LIMIT',
              'Draft result exceeds the installed output contract; request a smaller draft.',
            );
          await authorize(context);
          return { effect: 'none', output: result };
        },
      };
    }
    return { operations, close: () => reader.close() };
  } catch (error) {
    reader.close();
    throw error;
  }
}
