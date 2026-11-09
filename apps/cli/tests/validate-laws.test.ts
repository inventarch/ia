/**
 * `ia validate` reports every law's status: enforced, pending (enforcement pending), not evaluated or suspended.
 * Only error findings and revoked items exit 1, so a pending, not-evaluated or suspended law never does.
 * tests/equivalence.test.ts holds `ia-distribution validate` to the same laws.
 */
import { afterAll, expect, it } from 'vitest';
import { initialized, put } from './host-fixture.js';
import { cleanup, run } from './workspace-fixture.js';

afterAll(cleanup, 120_000);

const law = (name: string, severity: string, enforcedBy?: string) => `@law ${name}
  meaning
    says "Test law ${name}."
    answers "What does test law ${name} require?"
  governance
    severity ${severity}
${enforcedBy === undefined ? '' : `  relationships\n    enforced-by @check ${enforcedBy}\n`}`;
const check = (name: string, runs: string) => `@check ${name}
  meaning
    says "Test check ${name}."
    answers "What does test check ${name} evaluate?"
  check
    runs ${runs}
    scope "*"
`;
const improvement = (name: string, target: string) => `@improvement ${name}
  meaning
    says "Suspend ${target}."
    answers "What does ${name} propose?"
  proposal
    target ${target}
    system governance-system
    path "x"
    before "a"
    candidate "b"
    digest "d"
    applies "now"
    verification "v"
    reversal "r"
  review
    status suspended
  publication
    status draft
  relationships
    cites @law placement-law
`;
const OFFENDING = `@spec offending-spec
  meaning
    says "A specification inside a system folder."
    answers "Which specification sits in a system folder?"
  work
    title "Offending"
    status draft
`;
const OFFENDING_PATH = '.ia/src/systems/work-system/records/offending-spec.ia';
const named = (name: string) => expect.stringMatching(new RegExp(`/${name}$`));
const json = async (root: string, env: Record<string, string>) => {
  const result = await run(['validate', '--root', root, '--json'], { env });
  return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) };
};
const text = async (root: string, env: Record<string, string>) => {
  const result = await run(['validate', '--root', root], { env });
  return { ...result, text: result.stdout.replace(/\s+/g, ' ') };
};

it('validate lists a pending law and exits 0', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/laws.ia', `#! ia 1.0\n\n${law('lonely-law', 'blocking')}`);
  const human = await text(root, env);
  expect(human.exitCode).toBe(0);
  expect(human.text).toContain('Laws');
  expect(human.text).toContain('lonely-law');
  expect(human.text).toContain('pending (enforcement pending)');
  expect(human.text).toMatch(/1 pending \(enforcement pending\)/);
});

it('validate exits 1 on a blocking canon finding and 0 when the law is suspended', async () => {
  const { root, env } = await initialized();
  put(
    root,
    '.ia/src/laws.ia',
    `#! ia 1.0\n\n${law('placement-law', 'blocking', 'placement-check')}\n${check('placement-check', 'CANON-WORK-PLACEMENT')}`,
  );
  put(root, OFFENDING_PATH, `#! ia 1.0\n\n${OFFENDING}`);
  const blocked = await json(root, env);
  expect(blocked.exitCode).toBe(1);
  expect(blocked.envelope.laws).toMatchObject([
    { identity: named('placement-law'), severity: 'blocking', state: 'enforced' },
  ]);
  const lawIdentity = blocked.envelope.laws[0].identity as string;
  put(root, '.ia/src/suspend.ia', `#! ia 1.0\n\n${improvement('pause-placement-law', lawIdentity)}`);
  const suspended = await json(root, env);
  expect(suspended.exitCode).toBe(0);
  expect(suspended.envelope.laws).toMatchObject([
    { identity: lawIdentity, state: 'suspended', suspendedBy: named('pause-placement-law') },
  ]);
  const canon = suspended.envelope.findings.filter((f: { code: string }) => f.code === 'IA-COMP-CANON-WORK-PLACEMENT');
  expect(canon.length).toBeGreaterThan(0);
  expect(canon.every((f: { severity: string }) => f.severity === 'warning')).toBe(true);
  expect(suspended.envelope.counts).toMatchObject({ lawsSuspended: 1 });
  const human = await text(root, env);
  expect(human.exitCode).toBe(0);
  expect(human.text).toMatch(/1 suspended/);
});

it('json envelope carries laws and counts', async () => {
  const { root, env } = await initialized();
  put(
    root,
    '.ia/src/laws.ia',
    `#! ia 1.0\n\n${law('lonely-law', 'advisory')}\n${law('far-law', 'blocking', 'far-check')}\n${check('far-check', 'COMP-SCHEMA')}`,
  );
  const { exitCode, envelope } = await json(root, env);
  expect(exitCode).toBe(0);
  expect(envelope.laws).toEqual([
    {
      identity: named('far-law'),
      severity: 'blocking',
      state: 'enforced',
      checks: [named('far-check')],
      suspendedBy: null,
    },
    { identity: named('lonely-law'), severity: 'advisory', state: 'pending', checks: [], suspendedBy: null },
  ]);
  expect(envelope.counts).toMatchObject({ lawsPending: 1, lawsSuspended: 0 });
});

it('restore and update install over a blocking canon finding, which validate still reports with exit 1', async () => {
  const { root, env } = await initialized();
  put(
    root,
    '.ia/src/laws.ia',
    `#! ia 1.0\n\n${law('placement-law', 'blocking', 'placement-check')}\n${check('placement-check', 'CANON-WORK-PLACEMENT')}`,
  );
  put(root, OFFENDING_PATH, `#! ia 1.0\n\n${OFFENDING}`);
  // A canon finding fails only validate and preview: installing never refuses on one (Task 13e ruling).
  const restore = await run(['restore', '--root', root, '--offline', '--apply', '--yes', '--json'], { env });
  expect(restore.exitCode, restore.stderr).toBe(0);
  expect(JSON.parse(restore.stdout).applied.status).toBe('installed');
  const update = await run(
    ['update', 'inventarch/language', '--to', '^3.2.1', '--root', root, '--offline', '--apply', '--yes', '--json'],
    { env },
  );
  expect(update.exitCode, update.stderr).toBe(0);
  const validated = await json(root, env);
  expect(validated.exitCode).toBe(1);
  expect(validated.envelope.findings).toContainEqual(
    expect.objectContaining({ code: 'IA-COMP-CANON-WORK-PLACEMENT', severity: 'error', path: OFFENDING_PATH }),
  );
});

it('restore still refuses a closure with a non-canon admission error', async () => {
  const { root, env } = await initialized();
  put(
    root,
    '.ia/src/bad.ia',
    `#! ia 1.0\n\n@law bad-law\n  meaning\n    says "A law whose severity is not one."\n    answers "Which law has a bad severity?"\n  governance\n    severity sideways\n`,
  );
  const restore = await run(['restore', '--root', root, '--offline', '--apply', '--yes', '--json'], { env });
  expect(restore.exitCode).toBe(3);
  const refusal = JSON.parse(restore.stdout || restore.stderr);
  expect(refusal).toMatchObject({ ok: false, code: 'IA-DIST-ADMISSION-FAILED' });
  expect(refusal.message).toContain('IA-GRAPH-DIMENSION-UNKNOWN');
});
