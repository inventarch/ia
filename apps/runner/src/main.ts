#!/usr/bin/env node
import { resolve } from 'node:path';
import { isEntry } from '@inventarch/runtime/entry';
import { canonical } from '@inventarch/session-system';
import type { ModelResponse } from '@inventarch/agent-system';
import { openRunner } from './open.js';
import { RunnerError } from './errors.js';
import { readResponseFile } from './response.js';

const help = `ia-runner run --profile <agent-profile> --root <workspace> [--task <text>] [--id <run-id>]
ia-runner step --profile <agent-profile> --root <workspace> --id <run-id>
ia-runner submit --profile <agent-profile> --root <workspace> --id <run-id> --attempt <attempt-id> --response <json-file>

Optional --harness and --entry resolve ambiguous composition. The local host installs captured reads only.
run opens and advances a durable run; step resumes one scheduler action; submit accepts one exact pending model response.
The default model defers to the local host. Output includes the pending request; no credentials or provider are selected.
`;
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') {
    process.stdout.write(help);
    return;
  }
  const [command, ...args] = argv;
  const allowed = new Set(['profile', 'root', 'task', 'id', 'harness', 'entry', 'attempt', 'response']);
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, ''),
      value = args[i + 1];
    if (
      !args[i]?.startsWith('--') ||
      !key ||
      !allowed.has(key) ||
      !value ||
      value.startsWith('--') ||
      Object.hasOwn(values, key)
    )
      throw new RunnerError('IA-RUNNER-ARGUMENT', 'Expected unique supported option/value pairs', 'ia-runner --help');
    values[key] = value;
  }
  if (!['run', 'step', 'submit'].includes(command ?? '') || !values['profile'] || !values['root'])
    throw new RunnerError('IA-RUNNER-ARGUMENT', 'A command, --root and --profile are required', 'ia-runner --help');
  if (command !== 'run' && !values['id'])
    throw new RunnerError('IA-RUNNER-ARGUMENT', '--id is required to resume', 'ia-runner --help');
  const runner = openRunner({
    root: values['root'],
    profile: values['profile'],
    ...(values['harness'] ? { harness: values['harness'] } : {}),
    ...(values['entry'] ? { entry: values['entry'] } : {}),
  });
  try {
    let state;
    if (command === 'run') {
      await runner.start(values['task'] ?? 'Perform the bounded task.', values['id']);
      state = await runner.run();
    } else {
      await runner.resume(values['id']!);
      if (command === 'step') state = await runner.step();
      else {
        if (!values['attempt'] || !values['response'])
          throw new RunnerError('IA-RUNNER-ARGUMENT', 'submit requires --attempt and --response', 'ia-runner --help');
        const content = readResponseFile(resolve(values['response']));
        state = await runner.submit(values['attempt'], JSON.parse(content) as ModelResponse);
      }
    }
    const pending = Object.values(state.attempts).filter(
      (attempt) => attempt.kind === 'model' && attempt.status === 'dispatched',
    );
    const pendingRequests = pending.map(({ id, input }) => {
      const request = input as { [key: string]: import('@inventarch/session-system').Json };
      const profile = request['profile'] as { [key: string]: import('@inventarch/session-system').Json };
      return { id, request: { ...request, profile: { ...profile, instructions: [], voice: '' } } };
    });
    process.stdout.write(
      `${canonical({ id: state.id, sequence: state.sequence, run: state.runs[state.rootId], pending: pendingRequests })}\n`,
    );
  } finally {
    await runner.close();
  }
}
if (isEntry(process.argv[1], import.meta.url))
  main().catch((error: unknown) => {
    const problem = error as { code?: string; message?: string; next?: string };
    process.stderr.write(
      `${canonical({ code: problem.code ?? 'IA-RUNNER-FAILED', message: problem.message ?? 'Runner failed', ...(problem.next ? { next: problem.next } : {}) })}\n`,
    );
    process.exitCode = 1;
  });
