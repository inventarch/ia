export class TemplateError extends Error {
  constructor(
    readonly code: 'IA-EXEC-TEMPLATE-INVALID' | 'IA-EXEC-INPUT-INVALID' | 'IA-EXEC-OUTPUT-UNSAFE',
    message: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}
export function invalid(message: string): never {
  throw new TemplateError('IA-EXEC-TEMPLATE-INVALID', message);
}
export function inputInvalid(message: string): never {
  throw new TemplateError('IA-EXEC-INPUT-INVALID', message);
}
export const identifier = /^[a-z][a-z0-9-]{0,63}$/;
export function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid('Expected a plain template object');
  const descriptors = Object.getOwnPropertyDescriptors(value),
    names = Reflect.ownKeys(value);
  if (
    names.some(
      (key) => typeof key !== 'string' || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'),
    ) ||
    (keys && (names.length !== keys.length || names.some((key) => !keys.includes(key as string))))
  )
    invalid('Unknown, missing or non-data template field');
  return value as Record<string, unknown>;
}
export function unicode(value: unknown, limit: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit || Buffer.from(value).toString('utf8') !== value)
    invalid('Expected bounded valid Unicode text');
  return value;
}
export function id(value: unknown): string {
  const result = unicode(value, 64);
  if (!identifier.test(result)) invalid('Expected a lowercase identifier');
  return result;
}
