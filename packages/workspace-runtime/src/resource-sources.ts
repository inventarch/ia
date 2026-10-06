import type { Capture } from './corpus.js';
import type { ResourceKey } from './resource-format.js';
export const installedSource = (path: string): RegExpExecArray | null =>
  /^\.ia\/distributions\/store\/([a-f0-9]{64})\/(\.ia\/src\/.+)$/.exec(path);
export const installedId = (archive: string): string => `installed-${archive.slice(0, 48)}`;
export function resourcePrefix(capture: Capture, key: Pick<ResourceKey, 'source' | 'revision'>): string {
  if (key.source === capture.id) return '';
  for (const source of capture.sources) {
    const match = installedSource(source.path);
    if (match && installedId(match[1]!) === key.source) return `.ia/distributions/store/${match[1]}/`;
  }
  return `.ia/adopted/${key.source}/${key.revision}/`;
}
export function nativeResourcePath(capture: Capture, key: ResourceKey): string {
  return resourcePrefix(capture, key) + key.path;
}
