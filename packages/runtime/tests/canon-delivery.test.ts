import { createHash } from 'node:crypto';
import { cpSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readInputs } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { stableSerialize } from '@inventarch/graph';
import { normalizeScopeKey, positionBody, resolveScopeKey } from '../src/index.js';
import type { PositionBody, ScopeKey } from '../src/index.js';
import { database, packetFixture, put, workspace } from './workspace.js';

// The goal-1 scenario set, offline: a workspace pinning this repository's language (its floor and systems, the canon
// records with them) receives the canon by subject word (R17) at a seat of each boundary word.
const language = resolve(import.meta.dirname, '../../../.ia/src'),
  SKIP = /(?:^|[\\/])(node_modules|dist|\.git)(?:[\\/]|$)/,
  law = (name: string) => `governance-system/governance/law/${name}`,
  convention = (name: string) => `governance-system/governance/convention/${name}`,
  principle = (name: string) => `governance-system/governance/principle/${name}`;
const DISTRIBUTION =
  '#! ia 1.0\n\n@distribution demo-kit\n  meaning\n    says "The demo kit\'s release."\n    answers "Which records does the demo kit release?"\n  distribution\n    records [@workspace demo]\n';

/** A fresh init adopting this repository's floor and systems at band 90 from `vendor/language`, pinned by revision. */
function pinned(): string {
  const root = workspace(null),
    vendor = 'vendor/language';
  for (const part of ['floor', 'systems'])
    cpSync(resolve(language, part), resolve(root, vendor, '.ia/src', part), {
      recursive: true,
      filter: (path) => !SKIP.test(path),
    });
  const sources = readInputs(resolve(root, vendor), { adopted: [] })
    .sources.filter((s) => !s.path.startsWith('.ia/src/floor/'))
    .map(({ path, text }) => ({ path, text }));
  const revision = createHash('sha256').update(stableSerialize(sources)).digest('hex');
  put(
    root,
    '.ia/workspace.json',
    JSON.stringify({ version: 1, adopted: [{ id: 'language', path: vendor, revision }] }),
  );
  put(root, '.ia/src/workspace.ia', readFileSync(packetFixture, 'utf8'));
  put(root, '.ia/src/releases/demo-kit.ia', DISTRIBUTION);
  return root;
}
/** The applies-by-word identities at `seat` alone: no hop and no budget, so only the seat's own word is answered. */
const appliesAt = (db: Handle, seat: string): readonly string[] => {
  const within = db.resolveScope().token,
    key: Partial<ScopeKey> = { seat, depth: 0, budget: 0 },
    body: PositionBody = positionBody(db, within, resolveScopeKey(db, within, normalizeScopeKey(key)));
  return body.appliesByWord.map((entry) => entry.identity);
};

describe('canon delivery by subject word', () => {
  /** A fresh pinned workspace, admitted with no error. */
  const open = (): Handle => {
    const db = database(pinned());
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    return db;
  };

  it('a seat touching @workspace receives canon-boundary-order and canon-ask-before-boundary', () => {
    const applies = appliesAt(open(), 'workspace-system/definition/workspace/demo');
    expect(applies).toEqual(
      expect.arrayContaining([
        convention('canon-boundary-order'),
        convention('canon-ask-before-boundary'),
        convention('canon-boundary-made-by-many'),
        convention('canon-boundary-independence'),
        convention('canon-boundary-smaller'),
        convention('canon-boundary-verdict'),
        principle('canon-customer-corpus-workspace'),
        convention('canon-one-workspace-per-root'),
        principle('canon-storage-one-authority'),
        convention('canon-storage-review-default'),
      ]),
    );
    expect(applies).not.toContain(convention('canon-split-on-fact'));
  });

  it('a seat touching @distribution receives the kit boundary rows', () => {
    const applies = appliesAt(open(), 'workspace-system/definition/distribution/demo-kit');
    expect(applies).toEqual(
      expect.arrayContaining([
        convention('canon-boundary-authority-order'),
        principle('canon-distribution-release-form'),
        principle('canon-kits-mint-no-words'),
        principle('canon-hosted-method-path'),
      ]),
    );
    expect(applies).not.toContain(convention('canon-boundary-order'));
  });

  it('a seat touching @system receives the split conventions', () => {
    const applies = appliesAt(open(), 'floor/definition/system/workspace-system');
    expect(applies).toEqual(
      expect.arrayContaining([
        convention('canon-split-triggers'),
        convention('canon-split-on-fact'),
        convention('canon-split-ask'),
        principle('canon-one-registration-owner'),
      ]),
    );
    expect(applies).not.toContain(convention('canon-boundary-order'));
  });

  it('a seat touching @mandate receives canon-steward-authority', () => {
    const applies = appliesAt(open(), 'agent-system/policy/mandate/demo-mandate');
    expect(applies).toEqual(
      expect.arrayContaining([
        law('canon-steward-authority'),
        convention('canon-steward-local-variation'),
        convention('canon-steward-definition-approval'),
      ]),
    );
  });
});
