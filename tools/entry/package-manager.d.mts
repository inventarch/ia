// Generated from checked JavaScript; run node tools/testing/check-declarations.mjs --write.
/**
 * Select an argv-safe invocation of a trusted installed package-manager entry. Never invoke a shell.
 * @param {string} launcher
 * @param {readonly string[]} args
 * @param {string} [nodePath]
 * @returns {{command: string, args: string[]}}
 */
export function packageManagerCommand(
  launcher: string,
  args: readonly string[],
  nodePath?: string,
): {
  command: string;
  args: string[];
};
