import { FLOOR_SYSTEM, canonicalPath } from '@ia/language';
import type { CompiledRecord, FrozenRegistry, Source } from '@ia/language';
import { assess } from './types.js';
import type { Assessment, CompCode, Finding } from './types.js';

export interface SystemFolder {
  readonly name: string;
  readonly path: string;
  readonly sources: readonly Source[];
  readonly records: readonly CompiledRecord[];
  readonly roots?: readonly string[];
}
export function validateSystems(
  folders: readonly SystemFolder[],
  registry: FrozenRegistry,
  pool: readonly CompiledRecord[],
): readonly Assessment[] {
  const results: Assessment[] = [];
  const finding = (code: CompCode, path: string, line: number, message: string, warning = false): Finding => ({
    code,
    path,
    line,
    severity: warning ? 'warning' : 'error',
    message: `${path}:${line}: ${message}`,
  });
  for (const folder of folders) {
    const expected = `${canonicalPath(folder.path)}/system.ia`;
    const declarations = folder.sources.flatMap((s) => {
      const visit = (records: typeof s.ast.records): typeof s.ast.records =>
        records.flatMap((r) => [r, ...visit(r.nested)]);
      return visit(s.ast.records)
        .filter((r) => r.discriminator === 'system')
        .map((r) => ({ record: r, path: s.ast.path }));
    });
    if (
      declarations.length !== 1 ||
      declarations[0]!.record.name.toLowerCase() !== folder.name ||
      !(folder.roots ?? [folder.path]).some(
        (root) => canonicalPath(declarations[0]!.path) === `${canonicalPath(root)}/system.ia`,
      )
    ) {
      results.push(
        assess('COMP-SYSTEM', folder.path, [
          finding(
            'IA-COMP-SYSTEM-MALFORMED',
            expected,
            1,
            `Folder ${folder.name} requires exactly one matching @system in its direct system.ia`,
          ),
        ]),
      );
      continue;
    }
    const system = registry.systems.get(folder.name);
    if (system === undefined) continue; // Already refused by language; do not diagnose its consequences.
    const shape: Finding[] = [];
    const requires = new Set(system.requires.map((r) => r.name));
    for (const record of folder.records) {
      const owner = registry.registrations.get(record.discriminator)?.system;
      if (owner !== undefined && owner !== FLOOR_SYSTEM && owner !== system.name && !requires.has(owner))
        shape.push(
          finding(
            'IA-COMP-DISCRIMINATOR-FOREIGN',
            record.source.path,
            record.source.line,
            `${record.identity} uses '${record.discriminator}' owned by ${owner}, which ${system.name} does not directly require`,
          ),
        );
    }
    results.push(assess('COMP-SYSTEM', folder.path, shape));
    const steward = system.steward;
    const candidates =
      steward?.discriminator === 'agent'
        ? pool.filter(
            (r) =>
              r.discriminator === 'agent' &&
              r.name === steward.name &&
              folder.records.some(
                (local) =>
                  local.identity === r.identity &&
                  local.source.path === r.source.path &&
                  local.source.line === r.source.line,
              ),
          )
        : [];
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    const applies = candidate?.variants.filter((v) => v.key === 'applies' && v.condition === undefined) ?? [];
    const covered = new Set(
      applies.flatMap((f) =>
        f.value.kind === 'list'
          ? f.value.items.flatMap((v) => (v.kind === 'scalar' || v.kind === 'string' ? [v.text] : []))
          : [],
      ),
    );
    const missing = system.entries.map((e) => e.keyword).filter((word) => !covered.has(word));
    const agentAllowed = system.name === 'agent-system' || requires.has('agent-system');
    results.push(
      assess(
        'COMP-STEWARD',
        folder.path,
        candidate === undefined || !agentAllowed || missing.length > 0
          ? [
              finding(
                'IA-COMP-STEWARD-MISSING',
                system.path,
                system.span.line,
                `${system.name} needs exactly one local @agent steward and unconditioned governance.applies coverage for ${missing.length > 0 ? missing.join(', ') : 'its minted words'}`,
              ),
            ]
          : [],
      ),
    );
    const consent: Finding[] = [];
    for (const entry of system.entries)
      if (
        !system.consent.some(
          (r) =>
            r.sources === '*' ||
            r.targets === '*' ||
            r.sources.includes(entry.keyword) ||
            r.targets.includes(entry.keyword),
        )
      )
        consent.push(
          finding(
            'IA-COMP-CONSENT-EMPTY',
            system.path,
            entry.span.line,
            `${system.name} has no consent row naming ${entry.keyword}`,
            true,
          ),
        );
    results.push(assess('COMP-CONSENT-DECLARED', folder.path, consent));
  }
  const enrollment: Finding[] = [];
  for (const schema of registry.schemas.values()) {
    const users = [...registry.registrations.values()].filter((r) => r.schema === schema.name);
    if (users.length !== 1)
      enrollment.push(
        finding(
          users.length === 0 ? 'IA-COMP-SCHEMA-UNREFERENCED' : 'IA-COMP-SCHEMA-MULTIPLE',
          schema.path,
          schema.span.line,
          `@schema ${schema.name} is enrolled ${users.length} times; expected exactly one registration`,
        ),
      );
  }
  results.push(assess('COMP-SCHEMA-ENROLLED', 'registry', enrollment));
  const ordering: Finding[] = [];
  for (const system of registry.systems.values())
    for (const required of system.requires) {
      const before = registry.order.indexOf(required.name);
      const after = registry.order.indexOf(system.name);
      if (before < 0 || after < 0 || before >= after)
        ordering.push(
          finding(
            'IA-COMP-BOOTSTRAP-ORDER',
            system.path,
            required.span.line,
            `${required.name} must load before ${system.name}`,
          ),
        );
    }
  results.push(assess('COMP-BOOTSTRAP', 'registry', ordering));
  return results;
}
