import { FLOOR_SYSTEM } from '../registry/floor.js';
import type { Registration, SchemaDeclaration } from '../registry/types.js';
import type { Spelling } from './values.js';

/** The head keys spec 2.2 names. A schema spells more under `head.<key>` fields. */
export const HEAD_SPELLINGS: readonly Spelling[] = [
  ['facet'],
  ['version'],
  ['provider'],
  ['describes'],
  ['steward'],
  ['lowers', 'to'],
];

/** What the floor spells inside its own two records (spec 4.2 and 4.3). An entry `agent lowers to binding` keeps `agent` as its key: the registry reads it, compile only carries it. */
const FLOOR: ReadonlyMap<string, ReadonlyMap<string, readonly Spelling[]>> = new Map([
  [
    'system',
    new Map<string, readonly Spelling[]>([
      ['requires', []],
      ['discriminators', []],
      ['edges', []],
      ['relationships', []],
    ]),
  ],
  [
    'schema',
    new Map<string, readonly Spelling[]>([
      ['sections', [['must', 'have'], ['may', 'have'], ['closed'], ['open']]],
      [
        'fields',
        [
          ['must', 'have'],
          ['may', 'have'],
        ],
      ],
      ['edges', [['must'], ['may']]],
    ]),
  ],
]);

/** The keys spelled for one section of a record, or for its head. */
export function spellingsFor(
  registration: Registration,
  schema: SchemaDeclaration | undefined,
  section: 'head' | string,
): readonly Spelling[] {
  const floor = registration.system === FLOOR_SYSTEM ? FLOOR.get(registration.keyword) : undefined;
  if (floor !== undefined) return section === 'head' ? HEAD_SPELLINGS : (floor.get(section) ?? []);
  if (schema === undefined) return section === 'head' ? HEAD_SPELLINGS : [];
  let bySection = spelledBy.get(schema);
  if (bySection === undefined) {
    bySection = new Map();
    for (const field of schema.fields) {
      const spellings = bySection.get(field.section) ?? [];
      spellings.push(field.key.split(' '));
      bySection.set(field.section, spellings);
    }
    bySection.set('head', [...HEAD_SPELLINGS, ...(bySection.get('head') ?? [])]);
    spelledBy.set(schema, bySection);
  }
  return bySection.get(section) ?? [];
}
/** A schema's spellings by section, read once: a schema of many fields is read for every field that uses it. */
const spelledBy = new WeakMap<SchemaDeclaration, Map<string, Spelling[]>>();
