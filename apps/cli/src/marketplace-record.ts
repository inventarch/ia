/**
 * The IA home's record of a user-level plugin installed from the public marketplace (`ia host claude --user`): which
 * marketplace, which plugin, and the ia that installed it. Claude keeps the plugin itself, so this record is the only
 * state the IA home holds for it; the workspace plan and `ia doctor` read it as they read a rendered plugin.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The public marketplace `ia host claude --user` installs from, as Claude's `owner/repo` source. */
export const PUBLIC_MARKETPLACE = 'inventarch/marketplace';
export const MARKETPLACE_RECORD = 'claude/marketplace-install.json';

export type MarketplaceRecord =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly reason: string }
  | {
      readonly state: 'present';
      readonly marketplace: string;
      readonly plugin: string;
      readonly cli: string;
      /**
       * When every registration command last exited 0, so when the marketplace was last consulted (ISO 8601); null
       * when the record predates the field or it is not a date. It never makes a record invalid.
       */
      readonly checkedAt: string | null;
    };

export const marketplaceRecorded = (home: string): boolean => existsSync(join(home, MARKETPLACE_RECORD));

/** The record, or why it cannot be read. Never throws and never writes. */
export function readMarketplaceRecord(home: string): MarketplaceRecord {
  const path = join(home, MARKETPLACE_RECORD);
  if (!existsSync(path)) return { state: 'absent' };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { state: 'invalid', reason: 'it is not JSON' };
  }
  const row = (value ?? {}) as Record<string, unknown>;
  const { marketplace, plugin, cli } = row;
  if (typeof marketplace !== 'string' || typeof plugin !== 'string' || typeof cli !== 'string')
    return { state: 'invalid', reason: 'it lacks marketplace, plugin or cli' };
  const checkedAt =
    typeof row['checkedAt'] === 'string' && !Number.isNaN(Date.parse(row['checkedAt'])) ? row['checkedAt'] : null;
  return { state: 'present', marketplace, plugin, cli, checkedAt };
}

/** Writes the record; `checkedAt` is omitted when null, as in a record written before the field existed. */
export function writeMarketplaceRecord(home: string, plugin: string, cli: string, checkedAt: string | null): void {
  mkdirSync(join(home, 'claude'), { recursive: true });
  const record = { marketplace: PUBLIC_MARKETPLACE, plugin, cli, ...(checkedAt === null ? {} : { checkedAt }) };
  writeFileSync(join(home, MARKETPLACE_RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

export const removeMarketplaceRecord = (home: string): void => rmSync(join(home, MARKETPLACE_RECORD), { force: true });
