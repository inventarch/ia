import { SHAPE_ROWS } from '@ia/language';

export type Shape = keyof typeof SHAPE_ROWS;
export interface Classifier {
  classify(text: string): string;
}
// Request-prose signals ported from the donor runtime/matrix/classify.ts.
// These are replaceable host hints, not grammar or kernel-authored semantics.
const SIGNALS: Readonly<Record<Shape, RegExp>> = {
  governance:
    /\b(govern|enforce|forbid|forbidden|constrain|allow|deny|denied|policy|policies|rule|guardrail|compliance|conformance|permission|permitted|grant|must not|may not|never)\b/i,
  execution:
    /\b(run|execute|invoke|dispatch|trigger|build|render|materiali[sz]e|deploy|apply|call|generate|emit|project|implement|fix|patch|refactor|migrate|author|write|create|add|wire|integrate|scaffold|ship|install)\b/i,
  sequence:
    /\b(before|after|then|next|order|sequence|depends? on|prerequisite|blocked? by|supersede[sd]?|first|finally|roadmap|milestones?|schedule)\b/i,
  learning:
    /\b(learn|learned|observe|capture|distill|why did|outcome|retro|retrospective|improve|feedback|lesson|postmortem|debrief)\b/i,
  context: /\b(what|where|which|find|show|explain|context|about|understand|look up|recall|how does|describe|locate)\b/i,
};
export function scoreShapes(text: string): readonly { readonly shape: Shape; readonly score: number }[] {
  return Object.freeze(
    (Object.keys(SHAPE_ROWS) as Shape[])
      .map((shape) => Object.freeze({ shape, score: SIGNALS[shape].test(text) ? 1 : 0 }))
      .sort((a, b) => b.score - a.score || SHAPE_ROWS[a.shape].tiePrecedence - SHAPE_ROWS[b.shape].tiePrecedence),
  );
}
export function classify(text: string): Shape {
  const top = scoreShapes(text)[0];
  return top !== undefined && top.score > 0 ? top.shape : 'context';
}
export const defaultClassifier: Classifier = Object.freeze({ classify });
