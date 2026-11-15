import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compiledAliases,
  INSTALLED_READ,
  INSTALLED_READ_LEGACY,
  installedReadAdapters,
  installedReadCatalog,
} from '@inventarch/agent-composition-system';
import type { CompiledHarness, CompositionCatalog } from '@inventarch/agent-composition-system';
import type { Manifest, OperationAdapter, OperationContext } from '@inventarch/agent-system';
import type { Capture } from '@inventarch/workspace-runtime';
import { bindExecution, executionBindings } from '@inventarch/workspace-runtime/bind';
import type { ReadHandle } from '@inventarch/db';
import { canonical } from '@inventarch/session-system';
import { RunnerError } from './errors.js';

/** Only statically imported first-party code may bind; authored module names are never resolved. */
export function bindOperations(input: {
  capture: Capture;
  compiled: CompiledHarness;
  catalog: CompositionCatalog;
  manifest: Manifest;
  principal: string;
  reader: ReadHandle;
  currentCapture: () => Capture;
  authorize: (operation: string, path: string | undefined, context: OperationContext) => Promise<void>;
}) {
  const bindings = executionBindings(input.reader);
  const fixed = installedReadCatalog();
  const aliases = compiledAliases(input.compiled);
  const entryUrl = import.meta.resolve('@inventarch/agent-composition-system');
  const extension = entryUrl.endsWith('.ts') ? 'ts' : 'js';
  const codePath = fileURLToPath(new URL(`./installed-read.${extension}`, entryUrl));
  const codeDigest = createHash('sha256').update(readFileSync(codePath)).digest('hex');
  const read = Object.hasOwn(input.manifest.operations, INSTALLED_READ.operation)
    ? installedReadAdapters(input.capture, input)
    : undefined;
  const operations: Record<string, OperationAdapter> = {};
  for (const operation of Object.values(input.manifest.operations)) {
    const selected = input.compiled.bindings.find((row) => row.kind === 'operation' && row.target === operation.id);
    const binding = bindings.find((row) => row.identity === selected?.identity);
    // A record may still name the original read; the binding then pinned the original entry or, aliased, the plain one.
    const written = selected?.implementation,
      ids = [INSTALLED_READ, INSTALLED_READ_LEGACY].find(
        (candidate) =>
          candidate.implementation === (written === undefined ? undefined : (aliases.operations?.[written] ?? written)),
      );
    const available =
      operation.id === INSTALLED_READ.operation &&
      ids !== undefined &&
      canonical(input.catalog.operations[ids.implementation]) === canonical(fixed.operations[ids.implementation]);
    const result =
      binding &&
      bindExecution(
        binding,
        available
          ? {
              status: 'present',
              operations: [
                {
                  id: written!,
                  status: 'available',
                  version: 1,
                  operation: ids!.operation,
                  handler: ids!.handler,
                  input: ids!.input,
                  output: ids!.output,
                  module: `runtime/node_modules/@inventarch/agent-composition-system/${extension === 'ts' ? 'src' : 'dist'}/installed-read.${extension}`,
                  digest: codeDigest,
                  packages: ['@inventarch/agent-composition-system'],
                },
              ],
            }
          : {
              status: 'unavailable',
              reason: 'This runner has no statically installed implementation for that operation',
            },
      );
    const bound = result?.status === 'bound' ? read?.operations[operation.handler] : undefined;
    operations[operation.handler] = {
      id: operation.handler,
      execute: async (args, context) => {
        const path =
          args && typeof args === 'object' && !Array.isArray(args) && typeof args['path'] === 'string'
            ? args['path']
            : undefined;
        await input.authorize(operation.id, path, context);
        if (!bound)
          throw new RunnerError('IA-RUNNER-BINDING-UNAVAILABLE', result?.reason ?? 'No admitted execution binding');
        const scoped: OperationContext = {
          ...context,
          assertCurrent: async () => {
            await context.assertCurrent?.();
            scoped.grant = context.grant;
            await input.authorize(operation.id, path, scoped);
          },
        };
        // installedReadAdapters rechecks complete implementation closure, capture and current grant at dispatch.
        return bound.execute(args, scoped);
      },
    };
  }
  return { operations: Object.freeze(operations), close: () => read?.close() };
}
