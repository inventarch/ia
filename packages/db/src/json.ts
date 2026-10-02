/** Why strict JSON text was refused; each caller maps a fault to its own contract's diagnostic. */
export type StrictJsonFault =
  | 'input'
  | 'size'
  | 'encoding'
  | 'depth'
  | 'nodes'
  | 'duplicate-key'
  | 'malformed'
  | 'nonfinite'
  | 'trailing';
/**
 * `depth` bounds every value, counting the root as 0 (distribution transport). `containers`, when set,
 * instead bounds how many objects/arrays may nest, so scalar leaves never count toward the limit.
 */
export interface StrictJsonLimits {
  readonly bytes: number;
  readonly depth: number;
  readonly nodes: number;
  readonly containers?: number;
}
/**
 * Shared strict JSON transport: bounded UTF-8 bytes, nesting and node count; duplicate decoded
 * keys are refused before object construction; objects have a null prototype. `fail` never returns.
 */
export function parseStrictJson(
  input: string,
  limits: StrictJsonLimits,
  fail: (fault: StrictJsonFault, message: string) => never,
): unknown {
  if (typeof input !== 'string') fail('input', 'Metadata byte limit/encoding');
  if (Buffer.byteLength(input) > limits.bytes) fail('size', 'Metadata byte limit/encoding');
  if (Buffer.from(input).toString('utf8') !== input) fail('encoding', 'Metadata byte limit/encoding');
  let at = 0,
    count = 0;
  const white = (): void => {
    while (/[\t\r\n ]/.test(input[at] ?? 'x')) at++;
  };
  const string = (): string => {
    const token = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    token.lastIndex = at;
    const match = token.exec(input);
    if (!match) fail('malformed', 'Malformed JSON string');
    at = token.lastIndex;
    const result = JSON.parse(match[0]) as string;
    if (Buffer.from(result).toString('utf8') !== result) fail('encoding', 'Invalid JSON Unicode');
    return result;
  };
  const value = (depth: number): unknown => {
    if (limits.containers === undefined && depth > limits.depth) fail('depth', 'Metadata nesting/node limit');
    if (++count > limits.nodes) fail('nodes', 'Metadata nesting/node limit');
    white();
    // With a container limit, `depth` is the number of enclosing containers; opening one more must fit.
    if (limits.containers !== undefined && (input[at] === '{' || input[at] === '[') && depth + 1 > limits.containers)
      fail('depth', 'Metadata nesting/node limit');
    if (input[at] === '"') return string();
    if (input[at] === '{') {
      at++;
      white();
      const row = Object.create(null) as Record<string, unknown>;
      if (input[at] === '}') {
        at++;
        return row;
      }
      for (;;) {
        white();
        const key = string();
        if (Object.hasOwn(row, key)) fail('duplicate-key', 'Duplicate JSON key');
        white();
        if (input[at++] !== ':') fail('malformed', 'Malformed JSON object');
        row[key] = value(depth + 1);
        white();
        const next = input[at++];
        if (next === '}') return row;
        if (next !== ',') fail('malformed', 'Malformed JSON object');
      }
    }
    if (input[at] === '[') {
      at++;
      white();
      const rows: unknown[] = [];
      if (input[at] === ']') {
        at++;
        return rows;
      }
      for (;;) {
        rows.push(value(depth + 1));
        white();
        const next = input[at++];
        if (next === ']') return rows;
        if (next !== ',') fail('malformed', 'Malformed JSON array');
      }
    }
    const token = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
    token.lastIndex = at;
    const match = token.exec(input);
    if (!match) fail('malformed', 'Malformed JSON value');
    at = token.lastIndex;
    const result: unknown = JSON.parse(match[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) fail('nonfinite', 'Nonfinite JSON number');
    return result;
  };
  const result = value(0);
  white();
  if (at !== input.length) fail('trailing', 'Trailing JSON content');
  return result;
}
