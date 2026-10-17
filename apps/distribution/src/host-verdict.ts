import type { verifyHostCache } from './host.js';

/**
 * Which functions are verifiers `hostVerifier` (`./host-observe`) made. It holds no verification of its own, so the
 * planners in `host.ts`, `host-home.ts` and `guard-registration.ts` can tell a command's shared verifier from any other
 * function without importing `host-observe.ts`, which imports them. Not a package export: only `hostVerifier` mints.
 */
declare const MINTED: unique symbol;
/** A memo of `verifyHostCache` a caller shares across the reads of one report or the plans of one command. */
export type HostVerifier = ((directory: string) => ReturnType<typeof verifyHostCache>) & { readonly [MINTED]: true };
const minted = new WeakSet<object>();
/** Marks `verify` as one `hostVerifier` made. */
export function mint(verify: (directory: string) => ReturnType<typeof verifyHostCache>): HostVerifier {
  minted.add(verify);
  return verify as HostVerifier;
}
/** Whether `hostVerifier` made `verify`; a function a caller wrote never is, so no caller can stand in for verification. */
export function isMinted(verify: unknown): verify is HostVerifier {
  return typeof verify === 'function' && minted.has(verify);
}
