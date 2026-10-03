import { isId, isKind } from '@inventarch/language';
import type { CompiledValue, FieldType, TextForm, ValueType } from '@inventarch/language';

/** Whether a schema field type is `list of T`: the one family a key may carry more than once (D3). */
export function isListType(type: FieldType): boolean {
  return type.startsWith('list of ');
}
/** Type predicates over already parsed values, never over IA source. */
export function matchesType(value: CompiledValue, type: FieldType): boolean {
  if (isListType(type)) {
    return value.kind === 'list' && value.items.every((item) => matchesScalar(item, type.slice(8) as ValueType));
  }
  return matchesScalar(value, type as ValueType);
}
function matchesScalar(value: CompiledValue, type: ValueType): boolean {
  if (type === 'ref') return value.kind === 'ref';
  if (type === 'flag')
    return value.kind === 'none' || (value.kind === 'scalar' && ['true', 'false'].includes(value.text));
  if (type === 'text') return value.kind === 'scalar' || value.kind === 'string' || value.kind === 'prose';
  if (value.kind !== 'scalar' && value.kind !== 'string') return false;
  switch (type) {
    case 'id':
      return isId(value.text);
    case 'number':
      return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.text) && Number.isFinite(Number(value.text));
    case 'qname': {
      const slots = value.text.split('/');
      return slots.length === 4 && slots.every((slot) => /^[a-z][a-z0-9-]*$/.test(slot)) && isKind(slots[1]!);
    }
  }
}

/** Text-form predicates (W0-L5) over already type-checked text. `iso-date` is `YYYY-MM-DD` and a real calendar date. */
export function matchesForm(text: string, form: TextForm): boolean {
  switch (form) {
    case 'iso-date': {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      if (match === null) return false;
      const year = Number(match[1]),
        month = Number(match[2]),
        day = Number(match[3]);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
      return days !== undefined && day >= 1 && day <= days;
    }
  }
}
