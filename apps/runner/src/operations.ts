import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INSTALLED_READ, installedReadAdapters, installedReadCatalog } from '@inventarch/agent-composition-system';
import type { CompiledHarness, CompositionCatalog } from '@inventarch/agent-composition-system';
import type { Manifest, OperationAdapter } from '@inventarch/agent-system';
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
  authorize: (operation: string, path?: string) => void;
}) {
  const bindings = executionBindings(input.reader);
  const fixed = installedReadCatalog();
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
    const available =
      operation.id === INSTALLED_READ.operation &&
      selected?.implementation === INSTALLED_READ.implementation &&
      canonical(input.catalog.operations[INSTALLED_READ.implementation]) ===
        canonical(fixed.operations[INSTALLED_READ.implementation]);
    const result =
      binding &&
      bindExecution(
        binding,
        available
          ? {
              status: 'present',
              operations: [
                {
                  id: INSTALLED_READ.implementation,
                  status: 'available',
                  version: 1,
                  operation: INSTALLED_READ.operation,
                  handler: INSTALLED_READ.handler,
                  input: INSTALLED_READ.input,
                  output: INSTALLED_READ.output,
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
        input.authorize(
          operation.id,
          args && typeof args === 'object' && !Array.isArray(args) && typeof args['path'] === 'string'
            ? args['path']
            : undefined,
        );
        if (!bound)
          throw new RunnerError('IA-RUNNER-BINDING-UNAVAILABLE', result?.reason ?? 'No admitted execution binding');
        // installedReadAdapters rechecks complete implementation closure, capture and current grant at dispatch.
        return bound.execute(args, context);
      },
    };
  }
  return { operations: Object.freeze(operations), close: () => read?.close() };
}
