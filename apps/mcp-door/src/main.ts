#!/usr/bin/env node
import { once } from 'node:events';
import { isEntry } from '@inventarch/runtime/entry';
import { Protocol, rpcError } from './protocol.js';
import type { Response } from './protocol.js';

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export async function serve(root: string): Promise<void> {
  const protocol = new Protocol(root),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  const send = async (response: Response | undefined): Promise<void> => {
    if (response !== undefined && !process.stdout.write(JSON.stringify(response) + '\n'))
      await once(process.stdout, 'drain');
  };
  const line = async (text: string): Promise<boolean> => {
    if (Buffer.byteLength(text, 'utf8') > MAX_LINE_BYTES) {
      await send(rpcError(null, -32600, 'Message exceeds 4MiB'));
      return false;
    }
    await send(protocol.line(text));
    return true;
  };
  try {
    for await (const chunk of process.stdin) {
      try {
        pending += decoder.decode(chunk as Uint8Array, { stream: true });
      } catch {
        await send(rpcError(null, -32700, 'Invalid UTF-8'));
        return;
      }
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const text = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!(await line(text))) return;
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES) {
        await send(rpcError(null, -32600, 'Message exceeds 4MiB'));
        return;
      }
    }
    try {
      pending += decoder.decode();
    } catch {
      await send(rpcError(null, -32700, 'Invalid UTF-8'));
      return;
    }
    if (pending.length > 0) await line(pending);
  } finally {
    protocol.close();
  }
}
async function main(): Promise<void> {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    process.stdin.destroy();
    if (error.code !== 'EPIPE') {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: ia-mcp-door [--root <workspace>]\nMCP2025-11-25 read tools over UTF-8 JSON-RPC lines on stdin/stdout.\n',
    );
    return;
  }
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--root' && args[1] !== undefined))) {
    process.stderr.write('Usage: ia-mcp-door [--root <workspace>]\n');
    process.exitCode = 2;
    return;
  }
  try {
    await serve(args[1] ?? process.cwd());
  } catch (error) {
    if (!process.stdout.destroyed && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
if (isEntry(process.argv[1], import.meta.url)) void main();
