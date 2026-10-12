import { SessionError } from '@inventarch/session-system';

export class RunnerError extends SessionError {
  constructor(
    code: string,
    message: string,
    readonly next = 'ia position',
  ) {
    super(code, message);
    this.name = 'RunnerError';
  }
}
export function requireRunner(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new RunnerError(code, message);
}
