import type { ViewStamp } from '@ia/runtime/editor';
export const METHOD = 'ia/editor/v1/';
export interface EditorRequest {
  readonly protocol: 1;
  readonly operation: string;
  readonly stamp?: ViewStamp;
  readonly action?: string;
  readonly occurrence?: string;
  readonly path?: string;
  readonly files?: readonly { readonly path: string; readonly text: string }[];
  readonly discriminator?: string;
  readonly name?: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly coordinate?: Readonly<Record<string, string>>;
  readonly depth?: number;
}
export function request(value: unknown): EditorRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid editor request');
  const object = value as Record<string, unknown>;
  if (object['protocol'] !== 1 || typeof object['operation'] !== 'string')
    throw new Error('Unsupported editor protocol');
  if (
    object['depth'] !== undefined &&
    (typeof object['depth'] !== 'number' ||
      !Number.isInteger(object['depth']) ||
      object['depth'] < 0 ||
      object['depth'] > 3)
  )
    throw new Error('Invalid graph depth');
  for (const key of ['action', 'occurrence', 'path', 'discriminator', 'name'])
    if (object[key] !== undefined && typeof object[key] !== 'string') throw new Error(`Invalid ${key}`);
  if (
    object['files'] !== undefined &&
    (!Array.isArray(object['files']) ||
      object['files'].length > 10 ||
      object['files'].some(
        (f: unknown) =>
          f === null ||
          typeof f !== 'object' ||
          typeof (f as Record<string, unknown>)['path'] !== 'string' ||
          typeof (f as Record<string, unknown>)['text'] !== 'string',
      ))
  )
    throw new Error('Invalid proposal files');
  for (const key of ['coordinate', 'fields'])
    if (
      object[key] !== undefined &&
      (object[key] === null ||
        typeof object[key] !== 'object' ||
        Array.isArray(object[key]) ||
        Object.values(object[key] as object).some((v) => typeof v !== 'string'))
    )
      throw new Error(`Invalid ${key}`);
  return object as unknown as EditorRequest;
}
