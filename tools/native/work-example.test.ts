import { fileURLToPath } from 'node:url';
import { EditorSnapshot } from '@inventarch/db/editor';
import { deliveryView } from '@inventarch/runtime';
import type { DeliveryView } from '@inventarch/runtime';
import { describe, expect, it } from 'vitest';
import { distributionSnapshot } from '../../apps/distribution/src/snapshot.js';
import { checkNative } from './check.js';
import type { NativeInput } from './compile.js';
import { publicLanguageInputs } from './public-language.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const example = publicLanguageInputs(root);
const plan = 'work-system/definition/plan/example-plan';
const milestone = 'work-system/definition/milestone/example-milestone';
const writer = 'work-system/definition/task/example-task';
const reviewer = 'work-system/definition/task/example-reference-review';
// Resolve the sample's open formatting decision in memory, so this regression isolates writing vs review evidence.
const inputs = example.inputs.map((input) => {
  if (!input.path.endsWith('/records/work.ia')) return input;
  expect(input.text).toContain('    decider "example owner"');
  return {
    ...input,
    text: input.text.replace(
      '    decider "example owner"',
      '    decider "example owner"\n    choice "written by hand"',
    ),
  };
});

function snapshot(sources: readonly NativeInput[] = inputs): EditorSnapshot {
  return new EditorSnapshot({
    root: '',
    ...distributionSnapshot({ sources, folders: example.folders, floorOrigin: 'explicit' }),
  });
}
function view(sources: readonly NativeInput[]): DeliveryView {
  const reader = snapshot(sources);
  try {
    expect(reader.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const result = deliveryView(reader, reader.resolveScope().token, plan);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.view;
  } finally {
    reader.close();
  }
}
/** Synthetic observations qualify fixture behavior only; they are never written to the repository. */
function observed(
  subjects: readonly { identity: string; verdict: 'success' | 'refusal'; actor: string }[],
): NativeInput[] {
  const reader = snapshot();
  try {
    const scope = reader.resolveScope().token;
    const observations = subjects.map(({ identity, verdict, actor }, index) => {
      const digest = reader.get(identity, { within: scope })!.digest;
      return [
        `@observation work-example-evidence-${index}`,
        '  meaning',
        '    says "Synthetic exit evidence for the public work example regression."',
        `    answers "Which synthetic fixture verdict concerns ${identity}?"`,
        '  evidence',
        '    origin check',
        `    actor "${actor}"`,
        '    observed-at "2026-10-11T00:00:00Z"',
        '    captured-at "2026-10-11T00:00:00Z"',
        '    workspace "work-example-test"',
        `    locator "${identity}"`,
        `    revision "${digest}"`,
        `    bundle ".ia/learning/work-example-${index}.json"`,
        `    digest "${'0'.repeat(64)}"`,
        '    availability unavailable',
        `    subject @task ${identity.split('/').at(-1)}`,
        `    subject-revision "${digest}"`,
        `    evaluator "${actor}"`,
        '    move Verification',
        `    verdict ${verdict}`,
        '  interpretation',
        '    applies "This synthetic subject at this fixture digest only."',
        '    limits "Does not establish actual reference-page review or authenticate a reviewer."',
        '    reason "Exercise delivery milestone satisfaction."',
        '    basis inference',
        '  retention',
        '    status retained',
      ].join('\n');
    });
    return [
      ...inputs,
      {
        path: '.ia/src/records/work-example-evidence.ia',
        text: '#! ia 1.0\n\n' + observations.join('\n\n') + '\n',
        location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
      },
    ];
  } finally {
    reader.close();
  }
}
const writing = { identity: writer, verdict: 'success' as const, actor: 'fixture-writer-check' };
const review = { identity: reviewer, verdict: 'success' as const, actor: 'fixture-reviewer-check' };

describe('first reference page milestone evidence', () => {
  it('includes writing and review in one milestone, and makes review wait for writing evidence', () => {
    const result = view(inputs);
    expect(result.tasks.map((task) => task.identity)).toEqual([writer, reviewer]);
    expect(result.milestones).toEqual([
      expect.objectContaining({ identity: milestone, tasks: [writer, reviewer], satisfied: false }),
    ]);
    expect(result.tasks[0]!.verdict).toBe('unblocked');
    expect(result.tasks[1]).toMatchObject({
      verdict: 'blocked',
      prerequisites: [{ target: writer, word: 'task', satisfied: false }],
    });
  });
  it('does not satisfy reviewer approval with writing evidence alone', () => {
    const result = view(observed([writing]));
    expect(result.tasks[0]!.verdict).toBe('evidenced');
    expect(result.tasks[1]).toMatchObject({
      verdict: 'unblocked',
      prerequisites: [{ target: writer, satisfied: true }],
    });
    expect(result.tasks[1]!.evidence).toBeUndefined();
    expect(result.milestones[0]).toMatchObject({
      identity: milestone,
      satisfied: false,
      basis: 'exit evidence missing for 1 of 2 tasks',
    });
    expect(result.next).toContain(reviewer);
  });
  it('can satisfy the milestone when writing and reviewer approval both have current success evidence', () => {
    const result = view(observed([writing, review]));
    expect(result.tasks.map((task) => task.verdict)).toEqual(['evidenced', 'evidenced']);
    expect(result.tasks[1]!.evidence?.evaluator).toBe('fixture-reviewer-check');
    expect(result.milestones[0]).toMatchObject({
      identity: milestone,
      satisfied: true,
      basis: 'every task has exit evidence',
    });
    expect(result.next).toBeNull();
  });
  it('does not turn reviewer refusal into approval even after writing succeeds', () => {
    const result = view(observed([writing, { ...review, verdict: 'refusal' }]));
    expect(result.tasks[1]!.verdict).toBe('unblocked');
    expect(result.tasks[1]!.evidence).toBeUndefined();
    expect(result.milestones[0]!.satisfied).toBe(false);
  });
});

it('refuses a workspace composed from a task even though that reference resolves', () => {
  let changed = false;
  const sources = example.inputs.map((input) => {
    if (!input.path.endsWith('/records/language.ia')) return input;
    const text = input.text.replace('systems [@system agent-system,', 'systems [@task example-task,');
    changed = text !== input.text;
    return { ...input, text };
  });
  expect(changed).toBe(true);
  const result = checkNative(sources, example.folders);
  expect(result.ok).toBe(false);
  expect(result.assessments.flatMap((assessment) => assessment.findings)).toContainEqual(
    expect.objectContaining({
      code: 'IA-COMP-FIELD-REF-TARGET',
      path: '.ia/src/systems/workspace-system/records/language.ia',
    }),
  );
});
