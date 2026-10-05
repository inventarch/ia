/** An inert, deterministic bundled selector; it never imports authored code or executes effects. */
export function authoringRoutine(
  data: {
    revision: string;
    source: string;
    purpose: string;
    cells: readonly {
      phase: string;
      primitive: string;
      text: string;
      condition?: readonly { axis: string; value: string }[];
    }[];
  },
  marker: string,
): string {
  return `/*\n${marker}\n*/
const method = ${JSON.stringify(data)};
try {
  const args = process.argv.slice(2);
  if (args.length !== 8 || args[0] !== '--phase' || args[2] !== '--primitive' || args[4] !== '--mode' || args[6] !== '--revision') throw new Error('Usage: context.mjs --phase <orient|plan|act|learn> --primitive <Memory|Attention|Inference|Decision|Escalation|Learning> --mode <audit|edit|system-design> --revision <source revision>');
  const [phase, primitive, mode, revision] = [args[1], args[3], args[5], args[7]];
  if (!['audit', 'edit', 'system-design'].includes(mode)) throw new Error('Unknown authoring mode');
  if (revision !== method.revision) throw new Error('Bundled source revision is stale; refresh the selected skill package');
  const cells = method.cells.filter(cell => cell.phase === phase && cell.primitive === primitive);
  if (!cells.length) throw new Error('Unknown or missing method coordinate');
  const clauses = cells.map(cell => ({text: cell.text, condition: cell.condition ?? null}));
  const core = method.cells.filter(cell => cell.phase === 'orient' && ['Memory', 'Attention'].includes(cell.primitive));
  const result = { sourceRevision: revision, source: method.source, mode, phase, primitive, purpose: method.purpose, core, instruction: cells.filter(cell => cell.condition === undefined).map(cell => cell.text).join('\\n\\n') || null, clauses, conditionEvaluation: 'caller-required', effectAuthority: 'none', liveAuthority: 'unverified', delivery: 'unconfirmed' };
  const output = JSON.stringify(result), bytes = Buffer.byteLength(output);
  if (bytes > 32768 || Math.ceil(bytes / 4) > 8192) throw new Error('Selected method exceeds the finite context budget');
  process.stdout.write(output + '\\n');
} catch (error) { process.stderr.write(JSON.stringify({ code: 'IA-SKILL-CONTEXT-INVALID', message: error.message }) + '\\n'); process.exitCode = 1; }
`;
}
