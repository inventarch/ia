import { canonicalPath } from '../../packages/language/src/index.js';
import type { CompiledField, CompiledRecord, CompiledValue } from '../../packages/language/src/index.js';

export interface ReleaseWorkFinding {
  readonly code:
    | 'IA-NATIVE-RELEASE-WORK-PLACEMENT'
    | 'IA-NATIVE-RELEASE-VERSION-LITERAL'
    | 'IA-NATIVE-RELEASE-COUNT-LITERAL';
  readonly severity: 'error';
  readonly identity: string;
  readonly path: string;
  readonly line: number;
  readonly field?: string;
  readonly message: string;
}

const WORK = new Set(['plan', 'milestone', 'task', 'decision', 'spec']);
const MUTABLE = new Set(['releases/current.json', 'tools/distribution/system-package-policy.json']);
const INTENT: Readonly<Record<string, readonly string[]>> = {
  meaning: ['says', 'answers'],
  work: ['title', 'action', 'expected-artifact', 'exit'],
  decision: ['question', 'options', 'choice', 'rationale', 'constraints'],
};
const VERSION = /\b(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/;
const NUMBER =
  '(?:\\d[\\d,]*|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine|hundred|thousand))*)';
const COUNT = new RegExp(
  `\\b${NUMBER}[ -]+(?:(?:public|npm|published|release|cohort)[ -]+)*packages?\\b|\\b(?:package count|cohort size|cohort of)[ :=]+${NUMBER}\\b`,
  'i',
);

function fields(record: CompiledRecord, section: string): readonly CompiledField[] {
  return record.sections
    .filter((row) => row.name === section)
    .flatMap((row) => row.fields)
    .filter((row): row is CompiledField => 'key' in row);
}
function texts(value: CompiledValue): readonly string[] {
  if (value.kind === 'list') return value.items.flatMap(texts);
  return 'text' in value ? [value.text] : [];
}
function text(record: CompiledRecord, section: string, key: string): string | undefined {
  const field = fields(record, section).find((row) => row.key === key);
  return field === undefined ? undefined : texts(field.value)[0];
}
/** A source locator may have a line/fragment suffix; lexical aliases still name the same repository control. */
function source(record: CompiledRecord): string | undefined {
  const locator = text(record, 'work', 'source');
  return locator === undefined
    ? undefined
    : canonicalPath(locator.split('#')[0]!.replace(/:\d+(?::\d+)?$/, '')).toLowerCase();
}
function historicalSource(locator: string | undefined): boolean {
  return locator !== undefined && /^releases\/(?:changesets\/)?\d+\.\d+\.\d+(?:-[\w.-]+)?\.json$/.test(locator);
}

/**
 * Repository release policy is an instance, not public work-system vocabulary. Its mutable controls own the
 * selected npm version and package membership. Reject copying either into live intent even when it matches
 * today's selection: comparison to today's JSON would allow the same defect at the next release.
 *
 * Only compiled work records connected to those controls are inspected. Immutable release sources retain
 * historical facts; unrelated native/protocol versions are untouched. Self-declared terminal status cannot turn a
 * mutable source into historical evidence. The hierarchy and require/ground
 * links carry release scope to work that omits a repeated source locator. Supersession does not carry that scope.
 * This is a repository lint for explicit semantic-version and package-count wording, not an English truth evaluator.
 */
export function checkReleaseWork(records: readonly CompiledRecord[]): readonly ReleaseWorkFinding[] {
  const work = records.filter((record) => WORK.has(record.discriminator));
  const byIdentity = new Map(work.map((record) => [record.identity, record]));
  const links = new Map(work.map((record) => [record.identity, new Set<string>()]));
  const link = (from: string, to: string | undefined): void => {
    if (to === undefined || !byIdentity.has(to)) return;
    links.get(from)!.add(to);
    links.get(to)!.add(from);
  };
  for (const record of work) {
    for (const field of fields(record, 'work')) {
      if (!['plan', 'milestone'].includes(field.key) || field.value.kind !== 'ref') continue;
      const reference = field.value;
      link(
        record.identity,
        work.find((target) => target.discriminator === reference.discriminator && target.name === reference.name)
          ?.identity,
      );
    }
    for (const edge of record.edges)
      if (['require', 'ground'].includes(edge.predicate)) link(record.identity, edge.target ?? undefined);
  }
  const roots = work.filter((record) => MUTABLE.has(source(record) ?? ''));
  const release = new Set(roots.map((record) => record.identity));
  const pending = [...release];
  for (let index = 0; index < pending.length; index++)
    for (const linked of links.get(pending[index]!)!)
      if (!release.has(linked)) {
        release.add(linked);
        pending.push(linked);
      }

  const findings: ReleaseWorkFinding[] = [];
  for (const record of work) {
    const locator = source(record);
    const historical = historicalSource(locator);
    if (!release.has(record.identity) && !historical) continue;
    const at = { identity: record.identity, path: record.source.path, severity: 'error' as const };
    if (canonicalPath(record.source.path).toLowerCase().startsWith('.ia/src/systems/'))
      findings.push({
        ...at,
        code: 'IA-NATIVE-RELEASE-WORK-PLACEMENT',
        line: record.source.line,
        message: 'Repository release work belongs under .ia/src/records/, outside distributable vocabulary systems.',
      });
    if (historical) continue;
    for (const [section, selected] of Object.entries(INTENT))
      for (const field of fields(record, section)) {
        if (!selected.includes(field.key)) continue;
        const content = texts(field.value).join('\n');
        const version = VERSION.exec(content);
        const count = COUNT.exec(content);
        const location = { ...at, line: field.span.line, field: `${section}.${field.key}` };
        if (version)
          findings.push({
            ...location,
            code: 'IA-NATIVE-RELEASE-VERSION-LITERAL',
            message: `Live release intent copies version "${version[0]}"; select the npm cohort version from releases/current.json, or pin a historical release source.`,
          });
        if (count)
          findings.push({
            ...location,
            code: 'IA-NATIVE-RELEASE-COUNT-LITERAL',
            message: `Live release intent copies package membership "${count[0]}"; derive the cohort from package manifests and release policy, or pin a historical release source.`,
          });
      }
  }
  return findings;
}
