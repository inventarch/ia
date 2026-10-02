import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createScope } from './resources.js';
import { runBounded, spawnOwned, terminateTree } from './subprocess.js';

const node = process.execPath;
const settle = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });
it('captures a completed child and reports its status', async () => {
  const result = await runBounded(
    node,
    ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'],
    { timeoutMs: 20_000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '1' } },
  );
  expect(result.status).toBe(3);
  expect(result.stdout).toBe('out');
  expect(result.stderr).toBe('err');
  expect(result.timedOut).toBe(false);
});

it('scrubs the caller workspace root so a nested run resolves its own', async () => {
  // An inherited NX_WORKSPACE_ROOT_PATH points every nested Nx run at the caller's checkout whatever `cwd` says,
  // which is how a cold-cache probe in a temp workspace silently restores from another tree and reports failure.
  const report =
    'process.stdout.write(JSON.stringify([process.env.NX_WORKSPACE_ROOT_PATH ?? null, process.env.IA_SCRUB_WITNESS ?? null]))';
  const inherited = await runBounded(node, ['-e', report], {
    timeoutMs: 20_000,
    env: { ...process.env, NX_WORKSPACE_ROOT_PATH: resolve(tmpdir(), 'elsewhere'), IA_SCRUB_WITNESS: 'kept' },
  });
  expect(JSON.parse(inherited.stdout)).toEqual([null, 'kept']);
  const ambient = await runBounded(node, ['-e', report], { timeoutMs: 20_000 });
  expect(JSON.parse(ambient.stdout)[0]).toBe(null);
});

it('passes input and reports the duration it actually took', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(86_400_000).mockReturnValue(0);
  try {
    const result = await runBounded(
      node,
      ['-e', 'let s="";process.stdin.on("data",c=>{s+=c}).on("end",()=>process.stdout.write(s.toUpperCase()))'],
      { input: 'ping', timeoutMs: 20_000 },
    );
    expect(result.stdout).toBe('PING');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    clock.mockRestore();
  }
});

it('delivers live output before the child exits while retaining its diagnostic capture', async () => {
  const controller = new AbortController();
  let live = '';
  const result = await runBounded(node, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    timeoutMs: 20_000,
    signal: controller.signal,
    onStdout: (chunk) => {
      live += chunk;
      if (live.includes('ready')) controller.abort();
    },
  });
  expect(live).toBe('ready');
  expect(result.stdout).toBe(live);
  expect(result.timedOut).toBe(false);
  expect(result.status).not.toBe(0);
});

it('terminates a hung child at its ceiling instead of waiting for the suite timeout', async () => {
  const result = await runBounded(node, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 400 });
  expect(result.timedOut).toBe(true);
  expect(result.status === null || result.status !== 0).toBe(true);
}, 30_000);

it('terminates an announced grandchild in the owned process tree', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-subprocess-'));
  const marker = resolve(directory, 'grandchild.txt').replaceAll('\\', '/');
  const controller = new AbortController();
  // A monotonically increasing heartbeat measures writes after termination, not elapsed time since
  // startup. Append-only bytes avoid observing the empty interval of truncate-and-rewrite.
  // The independent watchdog also bounds a survivor if tree termination itself regresses.
  const descendant =
    'const fs=require("node:fs");const path=process.argv[1];fs.writeFileSync(path+".pid",String(process.pid));setInterval(()=>fs.appendFileSync(path,"."),50);setTimeout(()=>process.exit(0),30000)';
  const source = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(marker)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const running = runBounded(node, ['-e', source], { timeoutMs: 15_000, signal: controller.signal });
  let announced: number | undefined;
  try {
    for (let attempt = 0; attempt < 60 && !existsSync(marker); attempt += 1) await settle(50);
    expect(existsSync(marker)).toBe(true);
    announced = Number(readFileSync(`${marker}.pid`, 'utf8'));
    expect(Number.isSafeInteger(announced) && announced > 0).toBe(true);
    const initial = readFileSync(marker).length;
    // Deterministically cover slow host enumeration: the old two-second marker would already
    // exist before abort. Prove this witness is live without conditional tasklist-based passes.
    await settle(2300);
    expect(readFileSync(marker).length).toBeGreaterThan(initial);
    controller.abort();
    const result = await running;
    expect(result.timedOut).toBe(false);
    expect(result.status === null || result.status !== 0).toBe(true);
    const terminated = readFileSync(marker, 'utf8');
    await settle(1000);
    expect(readFileSync(marker, 'utf8')).toBe(terminated);
  } finally {
    controller.abort();
    await running;
    // Clean up the owned descendant even when the assertion exposes a broken tree terminator.
    if (announced !== undefined) {
      try {
        process.kill(announced, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (!directory.startsWith(resolve(tmpdir(), 'ia-subprocess-')))
      throw new Error('Unexpected temporary cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);

it('lets a scope own a spawned child and kill it on disposal', async () => {
  const scope = createScope();
  const child = spawnOwned(scope, 'hung child', node, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
    timeoutMs: 20_000,
  });
  expect(child.pid).toBeGreaterThan(0);
  const exited = new Promise<void>((done) => {
    child.once('close', () => {
      done();
    });
  });
  await scope.dispose();
  await exited;
  expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
}, 30_000);

it('terminates the tree when an owning signal aborts', async () => {
  const controller = new AbortController();
  const started = performance.now();
  const running = runBounded(node, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  setTimeout(() => {
    controller.abort();
  }, 200);
  const result = await running;
  expect(result.timedOut).toBe(false);
  expect(performance.now() - started).toBeLessThan(20_000);
}, 40_000);

it('refuses an already-aborted invocation before spawning child effects', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ia-subprocess-aborted-'));
  try {
    const marker = resolve(directory, 'effect.txt');
    const controller = new AbortController();
    const reason = new Error('Owner cancelled before dispatch');
    controller.abort(reason);
    // If dispatch regresses, this child writes immediately and hangs; runBounded's ceiling still
    // owns its cleanup. Capture rejection explicitly so an unrelated spawn error cannot pass.
    const result = await runBounded(
      node,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'effect');setInterval(()=>{},1000)`],
      {
        timeoutMs: 2000,
        signal: controller.signal,
      },
    ).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    expect(existsSync(marker)).toBe(false);
    expect(result.error).toBe(reason);
    expect(result.value).toBeUndefined();
  } finally {
    if (!directory.startsWith(resolve(tmpdir(), 'ia-subprocess-aborted-')))
      throw new Error('Unexpected temporary cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

it('truncates rather than buffering an unbounded stream', async () => {
  const result = await runBounded(node, ['-e', 'process.stdout.write("x".repeat(5000))'], {
    timeoutMs: 20_000,
    maxBufferBytes: 64,
  });
  expect(result.truncated).toBe(true);
  expect(result.stdout.length).toBe(64);
});

it('refuses an unbounded run and ignores a termination request for a process that is gone', async () => {
  await expect(runBounded(node, ['-e', ''], { timeoutMs: 0 })).rejects.toThrow(/positive timeout/);
  expect(() => {
    terminateTree(undefined);
    terminateTree(-1);
  }).not.toThrow();
});

it('tolerates a child that exits without reading its input', async () => {
  // spawnSync ignored the EPIPE this provokes; an unhandled stdin error would fail the whole test run instead.
  const result = await runBounded(node, ['-e', 'process.exit(0)'], {
    timeoutMs: 20_000,
    input: 'x'.repeat(4 * 1024 * 1024),
  });
  expect(result.status).toBe(0);
  expect(result.timedOut).toBe(false);
});

it('kills an owned child that outlives its deadline even when nothing disposes the scope', async () => {
  // A protocol read that never settles keeps the test body, and so the scope, from ever unwinding.
  const scope = createScope();
  const child = spawnOwned(scope, 'stalled child', node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400 });
  try {
    const closed = new Promise<void>((done) => {
      child.once('close', () => {
        done();
      });
    });
    await Promise.race([
      closed,
      settle(10_000).then(() => {
        throw new Error('child outlived its deadline');
      }),
    ]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally {
    terminateTree(child.pid);
    await scope.dispose();
  }
});

it('lets a stdout read settle when the deadline ends the child', async () => {
  const scope = createScope();
  const child = spawnOwned(scope, 'silent child', node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400 });
  try {
    const ended = new Promise<string>((done) => {
      child.stdout.once('close', () => {
        done('closed');
      });
    });
    expect(await Promise.race([ended, settle(10_000).then(() => 'stuck')])).toBe('closed');
  } finally {
    terminateTree(child.pid);
    await scope.dispose();
  }
});

it('refuses an owned child with no positive deadline', () => {
  const scope = createScope();
  expect(() => spawnOwned(scope, 'unbounded', node, ['-e', ''], { timeoutMs: 0 })).toThrow(/positive timeout/);
  expect(() => spawnOwned(scope, 'unbounded', node, ['-e', ''], {} as never)).toThrow(/positive timeout/);
});
