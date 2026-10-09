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
 * The index just past the JSON string token that opens at `at`, or -1 when the token is malformed: a single
 * left-to-right scan of the JSON string grammar (no control characters; the eight one-character escapes and
 * `\uXXXX`), so no backtracking regular expression runs over caller-supplied text.
 */
export function jsonStringEnd(input: string, at: number): number {
  if (input.charCodeAt(at) !== 0x22) return -1;
  let i = at + 1;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code === 0x22) return i + 1;
    if (code < 0x20) return -1;
    if (code !== 0x5c) {
      i += 1;
      continue;
    }
    const escaped = input[i + 1] ?? '';
    if (escaped !== '' && '"\\/bfnrt'.includes(escaped)) i += 2;
    else if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(i + 2, i + 6))) i += 6;
    else return -1;
  }
  return -1;
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
    const end = jsonStringEnd(input, at);
    if (end < 0) fail('malformed', 'Malformed JSON string');
    const result = JSON.parse(input.slice(at, end)) as string;
    at = end;
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
