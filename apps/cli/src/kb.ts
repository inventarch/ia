import { isAbsolute, relative, resolve } from 'node:path';
import { readWorkspaceBytes } from '@inventarch/db';
import { captureKnowledge, foundationFromWorkspace, openKnowledgeView, packageFromCommit } from '@inventarch/kb';
import { executeKnowledge, knowledgeFailure, parseKnowledgeRequest } from '@inventarch/kb/protocol';
import type { KnowledgeOperation } from '@inventarch/kb/protocol';
import type { Context, Result } from './consumer.js';
import { confirm, requireRoot, Refusal } from './consumer.js';
import { UsageError } from './args.js';
import { knowledgeMode } from './kb-commands.js';
import { requireProfile } from './profile.js';
import { openSession } from './session.js';
import { knowledgeOutput } from './kb-output.js';
import { document, headerLine } from './render.js';
const answer = (value: { ok: boolean }, context: Context): Result => ({
  exitCode: value.ok ? 0 : 1,
  stdout:
    (context.json ? '' : document([headerLine('Knowledge', value.ok ? 'ready' : 'unavailable', [], context.caps)])) +
    JSON.stringify(value, null, context.json ? undefined : 2) +
    '\n',
  stderr: '',
});
export async function runKnowledge(context: Context): Promise<Result> {
  const { args } = context,
    operation = args.positionals[0]!,
    root = requireRoot(context);
  const session = openSession(root);
  try {
    const mode = knowledgeMode(args);
    requireProfile({
      reader: session.reader,
      within: session.reader.resolveScope().token,
      context,
      mode,
      ...(operation === 'pack'
        ? { path: relative(root, resolve(root, args.value('out')!)).replaceAll('\\', '/') }
        : {}),
    });
    try {
      if (operation === 'pack') {
        const pkg = packageFromCommit({
          repository: root,
          commit: args.value('commit')!,
          selection: args.value('selection')!,
          foundation: foundationFromWorkspace(root),
        });
        const bytes = JSON.stringify(pkg) + '\n';
        const destination = knowledgeOutput(
          root,
          args.value('out')!,
          [
            ...pkg.files.map((file) => file.path),
            relative(root, resolve(root, args.value('selection')!)).replaceAll('\\', '/'),
          ],
          bytes,
        );
        const output = destination.absolute;
        if (destination.unchanged)
          return answer(
            { ok: true, ...{ version: 1, value: { applied: false, unchanged: true, digest: pkg.digest, output } } },
            context,
          );
        if (!args.flag('apply'))
          return answer(
            {
              ok: true,
              ...{
                version: 1,
                value: {
                  applied: false,
                  digest: pkg.digest,
                  files: pkg.files.length,
                  bytes: Buffer.byteLength(bytes),
                  output,
                },
              },
            },
            context,
          );
        if (
          !args.flag('yes') &&
          !(await confirm(context.host.interaction, 'Write validated knowledge package.\n', 'Apply? [y/N] '))
        )
          return answer(
            { ok: true, ...{ version: 1, value: { applied: false, digest: pkg.digest, output } } },
            context,
          );
        // Confirmation is an asynchronous boundary; authority and sources must still be current.
        const current = openSession(root);
        try {
          requireProfile({
            reader: current.reader,
            within: current.reader.resolveScope().token,
            context,
            mode,
            path: destination.path,
          });
          if (current.reader.revision !== session.reader.revision) throw new Error('Workspace changed before export');
          const applied = destination.write();
          return answer(
            { ok: true, ...{ version: 1, value: { applied, unchanged: !applied, digest: pkg.digest, output } } },
            context,
          );
        } finally {
          current.close();
        }
      }
      const citation = args.value('citation');
      const input =
        operation === 'search'
          ? { query: args.positionals[1], limit: args.integer('limit', 100) }
          : operation === 'read'
            ? { locator: args.positionals[1] }
            : operation === 'traverse'
              ? { identity: args.positionals[1], steps: args.integer('steps', 64) }
              : operation === 'resolve'
                ? {
                    citation: JSON.parse(
                      Buffer.from(
                        readWorkspaceBytes(
                          root,
                          isAbsolute(citation!) ? relative(root, citation!).replaceAll('\\', '/') : citation!,
                          16 * 1024,
                        ),
                      ).toString('utf8'),
                    ),
                  }
                : {};
      try {
        parseKnowledgeRequest(operation, input);
      } catch {
        throw new UsageError('Invalid kb request; see ia kb ' + operation + ' --help');
      }
      const view = openKnowledgeView(captureKnowledge(root, { expectedRevision: session.reader.revision }));
      try {
        return answer(executeKnowledge(view, operation as KnowledgeOperation, input), context);
      } finally {
        view.close();
      }
    } catch (error) {
      if (error instanceof UsageError || error instanceof Refusal) throw error;
      return answer(knowledgeFailure(error), context);
    }
  } finally {
    session.close();
  }
}
