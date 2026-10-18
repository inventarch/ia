/**
 * Strict named options for repository commands. Parsing has no effects. A value is
 * one argv item, even when it contains spaces; positional and repeated flags refuse.
 * @param {readonly string[]} argv
 * @param {{values?: readonly string[], booleans?: readonly string[], required?: readonly string[], exclusive?: readonly (readonly string[])[]}} contract
 */
export function parseOptions(argv, contract) {
  const valued = new Set(contract.values ?? []),
    boolean = new Set(contract.booleans ?? []);
  const parsed = new Map();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!name || (!valued.has(name) && !boolean.has(name))) throw new Error(`Unknown argument: ${arg}`);
    if (parsed.has(name)) throw new Error(`Repeated option: --${name}`);
    if (valued.has(name)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
      parsed.set(name, value);
    } else parsed.set(name, true);
  }
  for (const name of contract.required ?? []) if (!parsed.has(name)) throw new Error(`Required option: --${name}`);
  for (const group of contract.exclusive ?? [])
    if (group.filter((name) => parsed.has(name)).length > 1)
      throw new Error(`Conflicting options: ${group.map((name) => '--' + name).join(', ')}`);
  return {
    /** @param {string} name @returns {string | undefined} */
    value(name) {
      const value = parsed.get(name);
      return typeof value === 'string' ? value : undefined;
    },
    /** @param {string} name */
    has(name) {
      return parsed.has(name);
    },
  };
}
