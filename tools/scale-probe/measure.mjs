// Runs the IA CLI named by IA_PROBE_CLI in this process, then writes its wall time, CPU time and peak memory to
// stderr as one `@@PROBE {json}` line. Usage: IA_PROBE_CLI=<bin.js> node measure.mjs <ia args...>
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const start = performance.now();
process.on('exit', (code) => {
  const usage = process.resourceUsage();
  writeSync(
    2,
    `\n@@PROBE ${JSON.stringify({ code, wallMs: Math.round(performance.now() - start), cpuMs: Math.round((usage.userCPUTime + usage.systemCPUTime) / 1000), maxRssMB: Math.round(usage.maxRSS / 1024) })}\n`,
  );
});
const cli = process.env.IA_PROBE_CLI;
if (!cli) throw new Error('IA_PROBE_CLI names no CLI');
process.argv[1] = cli;
await import(pathToFileURL(cli).href);
