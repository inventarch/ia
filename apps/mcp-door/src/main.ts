#!/usr/bin/env node
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '@inventarch/runtime/entry';
import { Protocol, rpcError } from './protocol.js';
import type { Response } from './protocol.js';

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
const USAGE = 'Usage: ia-mcp-door [--root <workspace>] [--kits <folder>] [--kits-package <npm package>]\n';
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/**
 * The folder of the npm package `name` installed beside this door: the nearest `node_modules/<name>` above it, which is
 * where `npx -p @inventarch/mcp-door -p <name>` puts both. Undefined when it is not there.
 */
export function packageBeside(
  name: string,
  from: string = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  if (!PACKAGE_NAME.test(name)) return undefined;
  for (let at = from, depth = 0; depth < 64; depth++) {
    const dir = join(at, 'node_modules', ...name.split('/'));
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(at);
    if (parent === at) return undefined;
    at = parent;
  }
  return undefined;
}
export async function serve(
  root: string,
  options: { readonly kits?: string; readonly kitsPackage?: string } = {},
): Promise<void> {
  const protocol = new Protocol(root, options),
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
      `${USAGE}MCP2025-11-25 read tools and the method tools over UTF-8 JSON-RPC lines on stdin/stdout.\n`,
    );
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!,
      value = args[i + 1];
    if (
      (name !== '--root' && name !== '--kits' && name !== '--kits-package') ||
      value === undefined ||
      options.has(name) ||
      (name === '--kits-package' && !PACKAGE_NAME.test(value))
    ) {
      process.stderr.write(USAGE);
      process.exitCode = 2;
      return;
    }
    options.set(name, value);
  }
  const kits = options.get('--kits');
  // The npx launch `ia host --commit` writes installs the kits package beside the door; a package not found here is
  // reported by ia_session as default kits not installed, and IA_KITS_PACKAGE or the workspace's node_modules still apply.
  const named = options.get('--kits-package');
  const kitsPackage = named === undefined ? undefined : packageBeside(named);
  try {
    await serve(options.get('--root') ?? process.cwd(), {
      ...(kits === undefined ? {} : { kits }),
      ...(kitsPackage === undefined ? {} : { kitsPackage }),
    });
  } catch (error) {
    if (!process.stdout.destroyed && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
if (isEntry(process.argv[1], import.meta.url)) void main();
