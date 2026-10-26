/**
 * The user guide's walkthrough (docs/guide/walkthrough.md), end to end against examples/pantry: a fresh `local/pantry`
 * workspace with the example's records copied in admits, its built-in check passes, `ia next` reads the recorded
 * observation as exit evidence at the task's current digest, the task's position carries the law and the convention,
 * evidence goes stale when the task changes, an open decision blocks the plan, and the kitchen system defines a word.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { Result } from '../src/consumer.js';
import { cleanup, repository, run, scratch } from './workspace-fixture.js';

afterAll(cleanup);

const example = resolve(repository, 'examples/pantry');
const json = (result: Result): any => JSON.parse(result.stdout);
const TASK = 'work-system/definition/task/write-exporter';

/** A fresh workspace named after `id`'s last part, initialized the way the walkthrough's first step does. */
async function initialized(id: string, extra: readonly string[] = []): Promise<string> {
  const root = resolve(scratch('walkthrough'), id.split('/')[1]!);
  mkdirSync(root);
  const result = await run(['init', root, '--id', id, '--host', 'none', '--apply', '--yes', '--json', ...extra]);
  expect(result.exitCode, result.stdout).toBe(0);
  return root;
}
/** The Pantry workspace with every example record copied into `.ia/src/`, minus `omit`. */
async function pantry(omit: readonly string[] = []): Promise<string> {
  const root = await initialized('local/pantry');
  for (const name of readdirSync(resolve(example, 'records')))
    if (!omit.includes(name)) cpSync(resolve(example, 'records', name), resolve(root, '.ia/src', name));
  return root;
}
async function admitted(root: string): Promise<any> {
  const validated = await run(['validate', '--root', root, '--json']);
  expect(validated.exitCode, validated.stdout).toBe(0);
  const result = json(validated);
  expect(result.status).toBe('admitted');
  expect(result.findings.filter((finding: { severity: string }) => finding.severity === 'error')).toEqual([]);
  return result;
}
async function tasks(root: string): Promise<Record<string, any>> {
  const next = await run(['next', '--root', root, '--json']);
  expect(next.exitCode, next.stdout).toBe(0);
  return Object.fromEntries(json(next).view.tasks.map((task: { identity: string }) => [task.identity, task]));
}

it('admits the finished example, passes its built-in check and reads its observation as exit evidence', async () => {
  const root = await pantry();
  const validated = await admitted(root);
  expect(validated.checks.results).toEqual([
    expect.objectContaining({ name: 'records-conform', runner: 'COMP-SCHEMA', status: 'bound', outcome: 'pass' }),
  ]);
  const byIdentity = await tasks(root);
  expect(byIdentity[TASK]).toMatchObject({
    verdict: 'evidenced',
    evidence: { observation: 'learning-system/definition/observation/write-exporter-tests-pass' },
  });
  expect(byIdentity['work-system/definition/task/add-export-button']?.verdict).toBe('unblocked');
  expect(byIdentity['work-system/definition/task/document-export']?.verdict).toBe('blocked');
});

it("delivers the task's law as a reserved rule and its convention by word", async () => {
  const root = await pantry();
  const position = await run(['position', '--root', root, '--seat', TASK, '--shape', 'sequence', '--json']);
  expect(position.exitCode, position.stdout).toBe(0);
  const body = json(position).body;
  expect(body.rules.map((rule: { identity: string }) => rule.identity)).toContain(
    'governance-system/governance/law/lists-stay-local',
  );
  expect(body.appliesByWord.map((rule: { identity: string }) => rule.identity)).toContain(
    'governance-system/governance/convention/plain-ingredient-names',
  );
});

it('stops counting the evidence once the task changes', async () => {
  const root = await pantry();
  const file = resolve(root, '.ia/src/shopping-list.ia');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('title "Write the exporter"', 'title "Write the Markdown exporter"'),
  );
  await admitted(root);
  expect((await tasks(root))[TASK]?.verdict).toBe('unblocked');
});

it('blocks the plan on the open decision until it has a choice', async () => {
  const root = await pantry(['evidence.ia']);
  const file = resolve(root, '.ia/src/shopping-list.ia');
  const finished = readFileSync(file, 'utf8');
  writeFileSync(file, finished.replace('    choice "Markdown checklist"\n', ''));
  await admitted(root);
  const blocked = (await tasks(root))[TASK];
  expect(blocked?.verdict).toBe('blocked');
  expect(JSON.stringify(blocked)).toContain('no choice');
  writeFileSync(file, finished);
  expect((await tasks(root))[TASK]?.verdict).toBe('unblocked');
});

it("defines the kitchen system's @allergen word and admits a record of it", async () => {
  const root = await initialized('local/kitchen', ['--system']);
  const folder = resolve(root, '.ia/src/systems/kitchen');
  cpSync(resolve(example, 'kitchen/system.ia'), resolve(folder, 'system.ia'));
  mkdirSync(resolve(folder, 'schemas'));
  cpSync(resolve(example, 'kitchen/schemas/allergen.schema.ia'), resolve(folder, 'schemas/allergen.schema.ia'));
  cpSync(resolve(example, 'kitchen/allergens.ia'), resolve(root, '.ia/src/allergens.ia'));
  await admitted(root);
  const inspected = await run(['inspect', '--root', root, '--path', '.ia/src/allergens.ia', '--json']);
  expect(inspected.exitCode, inspected.stdout).toBe(0);
  expect(json(inspected).records.map((record: { identity: string }) => record.identity)).toEqual([
    'kitchen/definition/allergen/peanuts',
  ]);
});
