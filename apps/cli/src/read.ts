/**
 * `ia read <locator>`: the body behind a locator, and nothing else (apps/cli/SPEC.md, Workspace commands).
 *
 * The locator forms and the body rule are the runtime's (`parseLocator`, `readBody`): a record's own text by its
 * identity or a source line, a cell by `#phase/Primitive`, a requirement by `#REQ-…`. Structure stays in `ia inspect`.
 * This is a consumer command only; it is not one of the frozen machine routes, which dispatch first.
 */
import { locateRecord, parseLocator, readBody } from '@inventarch/runtime';
import type { Body, Locator } from '@inventarch/runtime';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import { quote } from './render.js';
import { codeOf, messageOf, openSession } from './session.js';
import type { Session } from './session.js';

function locatorOf(text: string): Locator {
  try {
    return parseLocator(text);
  } catch (error) {
    const code = codeOf(error, '');
    if (code !== 'IA-RUNTIME-REQUEST-INVALID') throw error;
    throw new Refusal(code, messageOf(error, code), 2, null, 'Run "ia read --help" for the locator forms it accepts.');
  }
}

/**
 * Nothing to read: the next command is the inspection that shows what is there instead. A record the locator resolves
 * to (one without the body, cell or requirement asked for) is inspected by its identity; otherwise the file or the
 * workspace is.
 */
function unreadable(error: unknown, locator: Locator, session: Session, root: string): Refusal {
  const code = 'IA-DB-SOURCE-UNAVAILABLE',
    message = messageOf(error, code),
    record = locateRecord(session.reader, locator);
  if (record !== undefined)
    return new Refusal(
      code,
      message,
      1,
      locator.kind === 'line'
        ? { path: locator.path, line: locator.line, identity: record.identity }
        : { path: root, identity: record.identity },
      `Run "ia inspect ${record.identity}" for the record's structure.`,
    );
  return locator.kind === 'line'
    ? new Refusal(
        code,
        message,
        1,
        { path: locator.path, line: locator.line },
        `Run "ia inspect --path ${quote(locator.path)}" for the records that file holds and their source lines.`,
      )
    : new Refusal(
        code,
        message,
        1,
        { path: root, identity: locator.identity },
        'Run "ia inspect" for the records this workspace admits.',
      );
}

export function collectRead(root: string, locator: Locator): Body {
  const session = openSession(root);
  try {
    return readBody(session.reader, locator);
  } catch (error) {
    if (codeOf(error, '') === 'IA-DB-SOURCE-UNAVAILABLE') throw unreadable(error, locator, session, root);
    throw error;
  } finally {
    session.close();
  }
}

export function runRead(context: Context): Result {
  // A malformed locator is a usage refusal, decided before any root or workspace is read.
  const locator = locatorOf(context.args.positionals[0]!);
  const read = collectRead(requireRoot(context), locator);
  if (context.json) {
    const { identity, fragment, source, digest, body } = read;
    return {
      exitCode: 0,
      stdout: JSON.stringify({ version: 1, identity, fragment, source, digest, body }) + '\n',
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: read.body + '\n', stderr: '' };
}
