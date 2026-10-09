import type { NativeInput } from './compile.js';
export const fixtureInstances: readonly NativeInput[] = [
  {
    path: '.ia/src/systems/hook-authoring-system/records/minimal-hook.ia',
    text: '#! ia 1.0\n@hook minimal-hook\n  meaning\n    says "An inert instance for structural coverage."\n    answers "Which word is exercised?"\n  hook\n    event PreToolUse\n    tools [Write]\n    paths ["fixture"]\n    message "Fixture only."\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    path: '.ia/src/systems/learning-system/records/minimal-improvement.ia',
    text: '#! ia 1.0\n@improvement minimal-improvement\n  meaning\n    says "An inert instance for structural coverage."\n    answers "Which word is exercised?"\n  proposal\n    target agent-system/binding/agent/agent-steward\n    system agent-system\n    path "fixture.ia"\n    before "Before."\n    candidate "After."\n    digest "fixture"\n    applies "Fixture only."\n    verification "Not run."\n    reversal "Restore fixture."\n  review\n    status proposed\n  publication\n    status pending\n  relationships\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    path: '.ia/src/systems/template-system/records/minimal-template.ia',
    text: '#! ia 1.0\n@template minimal-template\n  meaning\n    says "An inert instance for structural coverage."\n    answers "Which word is exercised?"\n  template\n    filename "fixture.md"\n    parameters []\n    lines ["Fixture."]\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    path: '.ia/src/systems/agent-composition-system/records/minimal-voice.ia',
    text: '#! ia 1.0\n@voice minimal-voice\n  meaning\n    says "An inert instance for structural coverage."\n    answers "Which word is exercised?"\n  communication\n    tone "Fixture tone."\n    terminology "Fixture labels."\n    explanation "Fixture explanation."\n    uncertainty "Fixture unknowns."\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    path: '.ia/src/systems/authoring-system/records/minimal-operation.ia',
    text: '#! ia 1.0\n@operation minimal-operation\n  meaning\n    says "An inert instance for structural coverage."\n    answers "Which word is exercised?"\n  execution\n    handler fixture-read\n    effects read-only\n    input fixture-input\n    output fixture-output\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    path: '.ia/src/systems/governance-system/records/minimal-law.ia',
    text: '#! ia 1.0\n@law minimal-law\n  meaning\n    says "An inert rule for structural coverage of the subject section."\n    answers "Which fixture rule names the records it covers?"\n  governance\n    severity blocking\n    requires "Fixture only."\n  subject\n    subject-kind definition\n    covers ["docs/**"]\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    path: '.ia/src/systems/governance-system/records/minimal-playbook.ia',
    text: '#! ia 1.0\n@playbook minimal-playbook\n  meaning\n    says "An inert procedure with one primary cell in every phase."\n    answers "Which fixture procedure declares a core cell for each phase?"\n  cognition\n    orient\n      primary Memory\n      Memory means "Recall the fixture."\n    plan\n      primary Inference\n      Inference means "Infer the fixture step."\n    act\n      primary Decision\n      Decision means "Decide the fixture step."\n    learn\n      primary Learning\n      Learning means "Record the fixture outcome."\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    path: '.ia/src/systems/authoring-system/records/minimal-authoring-guide.ia',
    text: '#! ia 1.0\n@authoring-guide minimal-authoring-guide\n  meaning\n    says "An inert instance for structural coverage."\n    answers "Which word is exercised?"\n  reference\n    owner agent-system\n    word agent\n    schema @schema agent\n    document "fixture.md"\n    default-file "agent.ia"\n  guidance\n    select-when "Testing."\n    avoid-when "Not testing."\n    consider "Fixture only."\n  relationships\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    path: '.ia/src/systems/agent-system/records/minimal-mandate.ia',
    text: '#! ia 1.0\n@mandate minimal-mandate\n  meaning\n    says "An inert authority for structural coverage of the authority section."\n    answers "Which fixture mandate binds a participant to closed moves?"\n  governance\n    requires "Fixture only."\n  authority\n    participant @agent agent-steward\n    moves [Observation, Verification]\n    scope [@workspace foundation-workspace]\n    excluded-words [hook]\n    covers ["docs/**"]\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
  {
    // The public work example names this steward as a task owner-agent; the conformance tree declares work-steward.
    path: '.ia/src/systems/work-system/records/public-steward.ia',
    text: '#! ia 1.0\n@agent public-work-system-steward\n  meaning\n    says "Identifies the owner of work-system contracts in this example."\n    answers "Who owns the plan, milestone, task, decision and spec words in this example?"\n  governance\n    applies [plan, milestone, task, decision, spec]\n',
    location: { placement: { kind: 'authored', band: 100, reach: '' }, provenance: 'workspace' },
  },
];
