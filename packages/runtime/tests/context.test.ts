import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { context, DEFAULT_TOKENIZER, parseLocator, readBody, RuntimeError } from '../src/index.js';
import type { ContextResult, Packet } from '../src/index.js';
import { database, lawId, lawPath, methodId, methodPath, playbook, put, workspace } from './workspace.js';

const budget = { tokens: 100000, records: 1000 };
const loopFixture = resolve(import.meta.dirname, '../../compliance/fixtures/loop/.ia/src');
function packet(result: ContextResult): Packet {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.packet;
}
it('delivers exact and separate primary cells with citations, then applicable governance', () => {
  const root = workspace();
  put(root, '.ia/src/fallback.ia', playbook('fallback'));
  const db = database(root),
    within = db.resolveScope({
      identities: [methodId, lawId, 'governance-system/definition/procedure/fallback'],
    }).token;
  const got = packet(
    context(
      db,
      { within, text: '', coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' } },
      budget,
    ),
  );
  expect(got.included.slice(0, 3).map((e) => e.step)).toEqual([1, 2, 3]);
  expect(got.included[0]?.address).toBe(methodId + '#orient/Decision');
  expect(got.included[0]?.text).toContain('Sample fixture statement');
  expect(got.included[1]?.text).toBe('Fallback fixture memory');
  expect(got.included[0]?.citations[0]?.path).toBe(methodPath);
  expect(got.included.find((e) => e.identity === lawId)?.step).toBe(3);
  expect(got.revision).toBe(db.revision);
  expect(got.scope.phase).toBe('orient');
  expect(got.included.filter((e) => e.identity === methodId)).toHaveLength(1);
});
it('delivers each cell with its record says and answers as its purpose when asked, counted in the budget and not in the envelope', () => {
  const root = workspace(),
    long = 'x'.repeat(20_000);
  put(root, '.ia/src/fallback.ia', playbook('fallback'));
  put(root, '.ia/src/long.ia', playbook('long').replace('says "Fixture procedure long"', `says "${long}"`));
  const db = database(root),
    fallback = 'governance-system/definition/procedure/fallback';
  const request = (identity: string) => ({
    within: db.resolveScope({ identities: [identity, lawId] }).token,
    text: '',
    coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' },
    follow: [],
  });
  const asked = { purpose: true },
    got = packet(context(db, request(fallback), budget, asked)),
    cell = got.included.find((e) => e.identity === fallback)!;
  expect(cell).toMatchObject({
    step: 2,
    text: 'Fallback fixture memory',
    purpose: 'says Fixture procedure fallback\nanswers What does this procedure do?',
  });
  expect(got.included.find((e) => e.identity === lawId)?.purpose).toBeUndefined();
  expect(
    packet(context(db, request(fallback), budget)).included.find((e) => e.identity === fallback),
  ).not.toHaveProperty('purpose');
  const one = { tokenizer: { name: 'one', count: () => 1 }, purpose: true },
    law = { tokens: 1, records: 1 };
  expect(
    packet(context(db, request(fallback), { tokens: law.tokens + 1, records: 2 }, one)).included.map((e) => e.identity),
  ).toEqual([lawId]);
  // A caller that does not ask is not charged: the cell's text alone fits beside the law.
  expect(
    packet(context(db, request(fallback), { tokens: law.tokens + 1, records: 2 }, { tokenizer: one.tokenizer }))
      .included.map((e) => e.identity)
      .sort(),
  ).toEqual([fallback, lawId].sort());
  expect(packet(context(db, request(fallback), { tokens: law.tokens + 2, records: 2 }, one)).limits.tokensUsed).toBe(3);
  const heavy = packet(context(db, request('governance-system/definition/procedure/long'), budget, asked));
  expect(heavy.included.find((e) => e.identity.endsWith('/long'))?.purpose?.length).toBeGreaterThan(20_000);
  expect(heavy.limits.envelopeBytes).toBeLessThan(20_000);
  // The purpose's own count is validated like the text's.
  expect(() =>
    context(db, request(fallback), budget, {
      purpose: true,
      tokenizer: { name: 'bad-purpose', count: (text: string) => (text.startsWith('says ') ? 0 : 1) },
    }),
  ).toThrow('IA-RUNTIME-BUDGET-INVALID');
  // Only cells carry a purpose: an entry matched by subject, mention or text already carries its record's meaning in its text.
  const wide = packet(
    context(
      db,
      {
        within: db.resolveScope().token,
        text: 'author a new law record for the governance system',
        coordinate: { phase: 'orient', primitive: 'Decision' },
      },
      budget,
      asked,
    ),
  );
  expect([wide.included.some((e) => e.purpose !== undefined), wide.included.some((e) => e.step >= 4)]).toEqual([
    true,
    true,
  ]);
  expect(wide.included.filter((e) => e.purpose !== undefined).every((e) => e.step <= 2)).toBe(true);
});
it('selects the advisory law clause at effective severity and gates the inverse edge', () => {
  // The native law now cites instance-schema-check; the loop fixture law keeps the conditioned inverse
  // `enforced-by` edge. The replace pins the advisory author severity whatever the fixture declares.
  const root = workspace(loopFixture);
  put(root, lawPath, readFileSync(resolve(root, lawPath), 'utf8').replace('severity blocking', 'severity advisory'));
  expect(readFileSync(resolve(root, lawPath), 'utf8')).toContain(
    'enforced-by @check instance-schema-check when phase is act and severity is blocking',
  );
  const db = database(root),
    within = db.resolveScope().token;
  const get = (severity?: string) =>
    packet(
      context(
        db,
        {
          within,
          text: '',
          coordinate: {
            phase: 'act',
            primitive: 'Memory',
            category: 'process',
            ...(severity === undefined ? {} : { severity }),
          },
          follow: ['enforced-by'],
        },
        budget,
      ),
    );
  const plain = get(),
    strong = get('blocking'),
    ordinary = plain.included.find((e) => e.identity === lawId)!,
    raised = strong.included.find((e) => e.identity === lawId)!;
  expect(ordinary.text).toContain('Sample fixture statement 3.');
  expect(ordinary.text).not.toContain('Sample fixture statement 4.');
  expect(raised.text).toContain('Sample fixture statement 4.');
  expect(raised.text).not.toContain('Sample fixture statement 3.');
  expect(ordinary.severity).toBe('advisory');
  expect(raised.severity).toBe('blocking');
  expect(raised.clauses?.[0]?.condition).toEqual([
    { axis: 'primitive', value: 'Memory' },
    { axis: 'severity', value: 'blocking' },
  ]);
  expect(plain.gated.some((e) => e.predicate === 'enforce')).toBe(true);
  expect(plain.followed.some((e) => e.predicate === 'enforce')).toBe(false);
  expect(strong.followed.some((e) => e.predicate === 'enforce')).toBe(true);
});
it('matches declared category, primitive and move without interpreting meaning.category as a selector', () => {
  // The loop fixture's closed playbook schema declares `meaning.category` as a text gloss; the native one does not, so a
  // native copy would refuse the decoy as IA-COMP-FIELD-UNKNOWN (compliance D1) before any consumer could misread it.
  const root = workspace(resolve(import.meta.dirname, '../../compliance/fixtures/loop/.ia/src'));
  put(
    root,
    '.ia/src/decision.ia',
    playbook(
      'decision-fixture',
      '  activation\n    activate when category is decision and primitive is Decision and move is Verification\n',
      '    learn\n      primary Learning\n      Learning means "Unused in act"\n',
    ).replace('  cognition', '    category "this is only a gloss"\n  cognition'),
  );
  const db = database(root),
    within = db.resolveScope().token;
  const got = packet(
    context(
      db,
      {
        within,
        text: '',
        coordinate: { phase: 'act', primitive: 'Decision', move: 'Verification', category: 'decision' },
      },
      budget,
    ),
  );
  const entry = got.included.find((e) => e.identity.endsWith('/decision-fixture'));
  expect(entry?.step).toBe(4);
  expect(entry?.score).toBe(3);
  const wrong = packet(
    context(
      db,
      {
        within,
        text: 'decision-fixture',
        coordinate: { phase: 'act', primitive: 'Memory', move: 'Verification', category: 'decision' },
      },
      budget,
    ),
  );
  expect(wrong.included.some((e) => e.identity.endsWith('/decision-fixture'))).toBe(false);
  expect(wrong.omitted.some((e) => e.detail.includes('primitive is Decision'))).toBe(true);
});
it('keeps a partial uncontradicted selector eligible for text but does not claim a full match', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/partial.ia',
    playbook(
      'partial-needle',
      '  activation\n    activate when category is decision and move is Verification\n',
      '    learn\n      primary Learning\n      Learning means "Later"\n',
    ),
  );
  const db = database(root),
    within = db.resolveScope().token;
  const got = packet(
    context(
      db,
      { within, text: 'partial-needle', coordinate: { phase: 'act', primitive: 'Decision', category: 'decision' } },
      budget,
    ),
  );
  expect(got.included.find((e) => e.identity.endsWith('/partial-needle'))?.step).toBe(6);
});
it('resolves subjects, sigils, identities and kind/name mentions only within the scoped pool', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/mentioned.ia',
    playbook('mentioned', '', '    learn\n      primary Learning\n      Learning means "Later"\n'),
  );
  const db = database(root),
    id = 'governance-system/definition/procedure/mentioned',
    within = db.resolveScope({ identities: [id] }).token;
  for (const text of ['@playbook mentioned', id, 'definition/mentioned']) {
    const got = packet(context(db, { within, text, coordinate: { phase: 'act', primitive: 'Decision' } }, budget));
    expect(got.included[0]?.step).toBe(5);
    expect(got.included[0]?.identity).toBe(id);
  }
  const got = packet(
    context(
      db,
      {
        within,
        text: '@agent agent-steward',
        subject: 'mentioned',
        coordinate: { phase: 'act', primitive: 'Decision' },
      },
      budget,
    ),
  );
  expect(got.included[0]?.step).toBe(5);
  expect(got.omitted.some((e) => e.address === '@agent agent-steward' && e.detail === 'IA-GRAPH-TARGET-MISSING')).toBe(
    true,
  );
  expect(got.followed).toEqual([]);
  const missing = packet(
    context(
      db,
      { within, text: '', subject: '@playbook mentioned#missing', coordinate: { phase: 'act', primitive: 'Decision' } },
      budget,
    ),
  );
  expect(missing.included).toEqual([]);
  expect(missing.omitted[0]?.detail).toContain('No cell or requirement fragment');
});
it('reserves blockers before an earlier cell and returns the minimum blocker reduction on overflow', () => {
  const db = database(workspace()),
    within = db.resolveScope({ identities: [methodId, lawId] }).token,
    request = { within, text: '', coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' } };
  const exact = packet(context(db, request, budget)),
    law = exact.included.find((e) => e.identity === lawId)!;
  const got = packet(context(db, request, { tokens: DEFAULT_TOKENIZER.count(law.text), records: 1 }));
  expect(got.included.map((e) => e.identity)).toEqual([lawId]);
  expect(got.omitted.some((e) => e.address.startsWith(methodId) && e.reason === 'budget')).toBe(true);
  const failed = context(db, request, { tokens: 0, records: 0 });
  expect(failed).toMatchObject({
    ok: false,
    code: 'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW',
    required: { tokens: DEFAULT_TOKENIZER.count(law.text), records: 1 },
    reduction: [lawId],
  });
});
it('offers topical assembly without spending the reserved blocking-governance budget', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/zebra.ia',
    playbook(
      'zebra-needle',
      '',
      '    orient\n      primary Decision\n      Decision means "Find zebra-needle evidence"\n',
    ),
  );
  const id = 'governance-system/definition/procedure/zebra-needle',
    db = database(root);
  const within = db.resolveScope({ identities: [methodId, lawId, id] }).token;
  const request = {
    within,
    text: 'zebra-needle',
    coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' },
  };
  const native = packet(context(db, request, budget));
  expect(native.included[0]?.identity).toBe(methodId);
  const topical = packet(context(db, request, budget, { ranking: 'topical' }));
  expect(topical.ranking).toBe('topical');
  expect(topical.included[0]?.identity).toBe(lawId);
  expect(topical.included[1]?.identity).toBe(id);
  const law = topical.included[0]!;
  const tight = packet(
    context(db, request, { tokens: DEFAULT_TOKENIZER.count(law.text), records: 1 }, { ranking: 'topical' }),
  );
  expect(tight.included.map((entry) => entry.identity)).toEqual([lawId]);
  expect(context(db, request, { tokens: 0, records: 0 }, { ranking: 'topical' })).toMatchObject({
    ok: false,
    code: 'IA-GRAPH-BUDGET-BLOCKING-OVERFLOW',
  });
});
it('uses the declared estimator and counts distinct identities while reporting envelope overhead', () => {
  const db = database(workspace()),
    within = db.resolveScope({ identities: [methodId] }).token;
  const got = packet(
    context(
      db,
      { within, text: '', coordinate: { phase: 'orient', primitive: 'Memory', category: 'process' }, follow: [] },
      { tokens: 1, records: 1 },
      { tokenizer: { name: 'one', count: () => 1 } },
    ),
  );
  expect(got.limits).toMatchObject({ tokensUsed: 1, recordsUsed: 1, estimator: 'one' });
  expect(got.limits.envelopeBytes).toBeGreaterThan(0);
  expect(got.followed).toEqual([]);
  expect(DEFAULT_TOKENIZER.count('😀')).toBe(1);
  expect(DEFAULT_TOKENIZER.count('')).toBe(0);
  expect(() =>
    context(db, { within, text: '', coordinate: { phase: 'act', primitive: 'Memory' } }, { tokens: -1, records: 1 }),
  ).toThrow('IA-RUNTIME-BUDGET-INVALID');
  expect(() =>
    context(
      db,
      { within, text: '', coordinate: { phase: 'orient', primitive: 'Memory', category: 'process' } },
      budget,
      { tokenizer: { name: 'bad', count: () => NaN } },
    ),
  ).toThrow('IA-RUNTIME-BUDGET-INVALID');
});
it('refuses incomplete coordinates and stale/forged tokens without substituting unscoped reads', () => {
  const root = workspace(),
    db = database(root),
    within = db.resolveScope().token;
  expect(context(db, { within, text: 'write', coordinate: { phase: 'act' } }, budget)).toMatchObject({
    ok: false,
    escalation: 'coordinate-incomplete',
    missing: ['primitive'],
  });
  expect(() => context(db, { within: 'forged', text: '', coordinate: {} }, budget)).toThrow('IA-DB-SCOPE-UNAVAILABLE');
  put(root, '.ia/src/new.ia', '#! ia 1.0\n');
  db.refresh();
  expect(() => context(db, { within, text: '', coordinate: { phase: 'act', primitive: 'Decision' } }, budget)).toThrow(
    'IA-DB-STALE',
  );
});
it('keeps returned packets immutable and equivalent calls deterministic apart from their opaque token', () => {
  const db = database(workspace()),
    request = {
      within: db.resolveScope().token,
      text: 'fixture',
      coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' },
    };
  const a = packet(context(db, request, budget)),
    b = packet(context(db, request, budget));
  expect({ ...a, scope: { ...a.scope, token: '' } }).toEqual({ ...b, scope: { ...b.scope, token: '' } });
  expect(() => (a.included as unknown[]).pop()).toThrow();
  expect(() => {
    (a.limits as { tokensUsed: number }).tokensUsed = 0;
  }).toThrow();
});
it('delegates phase-before-band authority to the database instead of filtering a wildcard winner', () => {
  const root = workspace(),
    overlay = '.ia/src/phase-overlay.ia';
  put(
    root,
    overlay,
    readFileSync(resolve(root, methodPath), 'utf8')
      .replace(/ {2}activation\n(?: {4}activate when .*\n)+/, '  activation\n    activate when phase is act\n')
      .replace('Sample fixture statement', 'Overlay whether'),
  );
  const db = database(root, {
      locations: { [methodPath]: { placement: { kind: 'adopted', band: 90, reach: '' }, provenance: 'methodology' } },
    }),
    within = db.resolveScope({ identities: [methodId] }).token;
  const got = packet(
    context(
      db,
      { within, text: '', coordinate: { phase: 'orient', primitive: 'Decision', category: 'process' } },
      budget,
    ),
  );
  expect(got.included[0]?.citations[0]?.path).toBe(methodPath);
  expect(got.included[0]?.text).toContain('Sample fixture statement');
  const act = packet(
    context(db, { within, text: '', coordinate: { phase: 'act', primitive: 'Decision', category: 'process' } }, budget),
  );
  expect(act.included[0]?.citations[0]?.path).toBe(overlay);
});
it('finds an exact minimum-count blocking reduction for both token and identity constraints', () => {
  const root = workspace(),
    original = readFileSync(resolve(root, lawPath), 'utf8');
  for (const name of ['large', 'medium'])
    put(root, `.ia/src/${name}.ia`, original.replace('@law sample-rule', `@law ${name}`));
  const prefix = 'governance-system/governance/law/',
    db = database(root),
    within = db.resolveScope({ identities: [lawId, prefix + 'large', prefix + 'medium'] }).token;
  const request = { within, text: '', coordinate: { phase: 'orient', primitive: 'Decision' } },
    options = {
      tokenizer: {
        name: 'fixture',
        count: (text: string) => (text.startsWith('@law large') ? 9 : text.startsWith('@law medium') ? 6 : 3),
      },
    };
  const failed = context(db, request, { tokens: 5, records: 3 }, options);
  expect(failed).toMatchObject({
    ok: false,
    required: { tokens: 18, records: 3 },
    reduction: [prefix + 'large', prefix + 'medium'],
  });
  expect(context(db, request, { tokens: 100, records: 1 }, options)).toMatchObject({
    ok: false,
    reduction: [prefix + 'large', prefix + 'medium'],
  });
});
it('parses each locator form: identity, identity#phase/primitive, identity#REQ and path:line', () => {
  const id = 'agent-system/binding/agent/public-agent-system-steward';
  expect(parseLocator(id)).toEqual({ kind: 'identity', identity: id });
  expect(parseLocator('x/binding/agent/y#orient/Decision')).toEqual({
    kind: 'cell',
    identity: 'x/binding/agent/y',
    phase: 'orient',
    primitive: 'Decision',
  });
  expect(parseLocator(`${id}#REQ-FOUNDATION-INPUT`)).toEqual({
    kind: 'requirement',
    identity: id,
    id: 'REQ-FOUNDATION-INPUT',
  });
  expect(parseLocator('.ia/src/systems/agent-system/system.ia:33')).toEqual({
    kind: 'line',
    path: '.ia/src/systems/agent-system/system.ia',
    line: 33,
  });
  // A path keeps the portable spelling the database records sources in.
  expect(parseLocator('.\\.ia\\src\\a.ia:2')).toEqual({ kind: 'line', path: '.ia/src/a.ia', line: 2 });
  for (const text of [
    '',
    'sample-procedure',
    'Not/An/Identity/X',
    'a/b/c',
    'a/b/c/d/e',
    `${id}#`,
    `${id}#orient`,
    `${id}#orient/Nothing`,
    `${id}#nowhere/Decision`,
    `${id}#orient/Decision/extra`,
    `${id}#req-lowercase`,
    'file.ia:0',
    'file.ia:-1',
    'file.ia:x',
    ':4',
  ]) {
    expect(() => parseLocator(text), JSON.stringify(text)).toThrow(RuntimeError);
    expect(() => parseLocator(text), JSON.stringify(text)).toThrow('IA-RUNTIME-REQUEST-INVALID');
  }
});
it('reads only the body behind a locator, with the per-record digest, scoped by the read token', () => {
  const root = workspace();
  put(
    root,
    '.ia/src/pair.ia',
    playbook('first') +
      '\n' +
      playbook('second', '', '    learn\n      primary Learning\n      Learning means "Later"\n').replace('#! ia 1.0\n', ''),
  );
  const db = database(root),
    records = db.records(),
    method = records.find((n) => n.identity === methodId)!,
    contract = records.find((n) => n.name === 'foundation-authoring-contract')!,
    system = records.find((n) => n.identity === 'floor/definition/system/agent-system')!,
    schema = records.find((n) => n.discriminator === 'schema')!;
  // Every admitted identity is a locator, so a read never needs a second address form.
  for (const node of records) expect(parseLocator(node.identity)).toEqual({ kind: 'identity', identity: node.identity });

  expect(readBody(db, parseLocator(methodId))).toEqual({
    identity: methodId,
    fragment: null,
    body: 'Sample fixture statement 1.',
    digest: method.digest,
    source: 'record',
  });
  const cell = method.cells.find((c) => c.phase === 'orient' && c.primitive === 'Decision')!;
  expect(readBody(db, parseLocator(`${methodId}#orient/Decision`))).toEqual({
    identity: methodId,
    fragment: 'orient/Decision',
    body: cell.text,
    digest: method.digest,
    source: 'record',
  });
  expect(readBody(db, parseLocator(`${contract.identity}#REQ-FOUNDATION-INPUT`))).toMatchObject({
    identity: contract.identity,
    fragment: 'REQ-FOUNDATION-INPUT',
    body: 'Supply the intended owner, complete native registry closure and authored record source.',
    digest: contract.digest,
  });
  // A @system says nothing in a meaning section; its body is the head's describes.
  expect(readBody(db, parseLocator(system.identity)).body).toBe('Public agent-system vocabulary contracts');

  // path:line names the innermost record whose source lines hold it, then reads it as its identity would.
  expect(readBody(db, parseLocator(`${methodPath}:${method.source.line}`))).toMatchObject({
    identity: methodId,
    fragment: null,
    body: 'Sample fixture statement 1.',
  });
  const second = records.find((n) => n.identity === 'governance-system/definition/procedure/second')!;
  expect(readBody(db, parseLocator(`.ia/src/pair.ia:${second.source.endLine}`))).toMatchObject({
    identity: second.identity,
    body: 'Fixture procedure second',
  });

  // Nothing to read is a database refusal that names what was asked for, never an empty body.
  expect(() => readBody(db, parseLocator(`${methodId}#REQ-NOT-HERE`))).toThrow('IA-DB-SOURCE-UNAVAILABLE');
  expect(() => readBody(db, parseLocator(`${methodId}#REQ-NOT-HERE`))).toThrow('REQ-NOT-HERE');
  expect(() => readBody(db, parseLocator('governance-system/definition/procedure/second#orient/Memory'))).toThrow(
    'IA-DB-SOURCE-UNAVAILABLE',
  );
  expect(() => readBody(db, parseLocator('no-such/definition/procedure/record'))).toThrow('IA-DB-SOURCE-UNAVAILABLE');
  expect(() => readBody(db, parseLocator(`${methodPath}:1`))).toThrow('IA-DB-SOURCE-UNAVAILABLE');
  expect(() => readBody(db, parseLocator('.ia/src/absent.ia:3'))).toThrow('IA-DB-SOURCE-UNAVAILABLE');
  // A @schema carries neither says nor describes: its structure is inspected, not read.
  expect(() => readBody(db, parseLocator(schema.identity))).toThrow('IA-DB-SOURCE-UNAVAILABLE');

  // The read goes through the supplied token: outside its scope is refused, not read unscoped.
  const within = db.resolveScope({ identities: [methodId] }).token;
  expect(readBody(db, parseLocator(methodId), { within }).body).toBe('Sample fixture statement 1.');
  expect(() => readBody(db, parseLocator(contract.identity), { within })).toThrow('IA-DB-OUT-OF-SCOPE');
  expect(() => readBody(db, parseLocator(`.ia/src/pair.ia:${second.source.line}`), { within })).toThrow(
    'IA-DB-SOURCE-UNAVAILABLE',
  );
  expect(Object.isFrozen(readBody(db, parseLocator(methodId)))).toBe(true);
});
