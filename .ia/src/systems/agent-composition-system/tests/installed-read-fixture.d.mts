import type { Capture, CompiledHarness, CompositionCatalog } from '../src/index.js';
import type { InstalledReadOptions } from '../src/installed-read.js';
import type { Grant, Manifest } from '@inventarch/agent-system';
import type { Json, SessionStore } from '@inventarch/session-system';
type SDK = typeof import('../src/index.js');
export const readPath: string;
export const evaluator: string;
export interface ReadFixture {
  capture: Capture;
  compiled: CompiledHarness;
  catalog: CompositionCatalog;
  manifest: Manifest;
  principal: string;
  grant: Grant;
  profile: string;
  options: InstalledReadOptions;
}
export function readFixture(SDK: SDK, root: string): ReadFixture;
export function qualifyInstalledRead(
  SDK: SDK,
  root: string,
  store: SessionStore,
  retryFault?: () => () => void,
): Promise<{
  capture: string;
  compiled: string;
  installedCode: string;
  calls: number;
  reads: number;
  checks: number;
  attempts: number;
  operationBudget: number;
  receipts: number;
  paidProviderCalls: number;
  revokedRetryRefused: boolean;
  staleSourceRetryRefused: boolean;
  changedCodeRetryRefused: boolean;
  restart: boolean;
  result: Json;
}>;
