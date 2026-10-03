import { isAbsolute, relative, resolve } from 'node:path';
import { captureWorkspace, installedImplementationDigest } from '@inventarch/agent-composition-system';
import { resourceOccurrences, verifyResources } from '@inventarch/agent-composition-system/resources';
import { renderCapturedTemplate } from '@inventarch/agent-composition-system/templates';
import {
  claudeProseCatalog,
  codexProseCatalog,
  compileProjection,
  verifyProjectionDescriptor,
} from '@inventarch/agent-composition-system/projections';
import { bytes, fail, portable, utf8, workspace } from './files.js';
import { formatSource, openWorkspaceSession, writeWorkOutput } from './services.js';
import { checkProjection, publishProjection, recoverProjection, removeProjection } from './publication.js';

export const HELP = `ia-distribution <command> --root <absolute workspace>
  validate
  format --path <logical .ia source path> --input <text file> [--out <draft file>]
  render --template <native identity> --resources <file> --values <JSON file>
         [--source-id project] [--out <draft file>]
  project --descriptor <file> --resources <file> --host claude|codex
          --name <name> --version <version> --out <absolute existing directory>
          [--source-id project] [--check]
  explain --record <native identity>
  explain --resource <source:relative-path> --resources <file>
  recover-projection --out <absolute existing directory>
  remove-projection --id <publication id> --out <absolute existing directory>

Inputs are workspace-relative regular files. Project compiles exact pinned inputs;
--check performs no writes. Output roots must be explicit existing directories.
These authoring/projection commands do not change native installation or global host settings.
`;
function argumentsOf(argv: readonly string[]): { command: string; flags: Map<string, string> } {
  const command = argv[0] ?? '',
    flags = new Map<string, string>();
  const allowed: Record<string, readonly string[]> = {
    validate: ['root'],
    format: ['root', 'path', 'input', 'out'],
    project: ['root', 'descriptor', 'resources', 'host', 'name', 'version', 'out', 'source-id', 'check'],
    render: ['root', 'template', 'resources', 'values', 'source-id', 'out'],
    explain: ['root', 'record', 'resource', 'resources', 'source-id'],
    'recover-projection': ['root', 'out'],
    'remove-projection': ['root', 'out', 'id'],
  };
  if (!Object.hasOwn(allowed, command)) fail('INPUT-INVALID', 'Unknown command; use --help');
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]?.slice(2);
    if (!argv[i]?.startsWith('--') || !key || !allowed[command]!.includes(key) || flags.has(key))
      fail('INPUT-INVALID', 'Unknown, duplicate or positional argument');
    const value = key === 'check' ? 'true' : argv[++i];
    if (value === undefined || value.startsWith('--')) fail('INPUT-INVALID', `Missing --${key} value`);
    flags.set(key, value);
  }
  return { command, flags };
}
export function run(argv: readonly string[]): { exitCode: number; result: unknown } {
  const { command, flags } = argumentsOf(argv);
  const need = (key: string): string => flags.get(key) ?? fail('INPUT-INVALID', `--${key} is required`);
  const root = workspace(need('root'));
  const read = (key: string, limit: number): string => {
    const supplied = need(key);
    // Absolute inputs are accepted only inside the explicit root.
    const path = isAbsolute(supplied) ? relative(root, resolve(supplied)).replaceAll('\\', '/') : supplied;
    const content = bytes(root, path, limit);
    if (content === null) fail('SOURCE-UNAVAILABLE', `Missing --${key} file`);
    return utf8(content);
  };
  const draft = (text: string): void => {
    if (!flags.has('out')) return;
    writeWorkOutput({
      root,
      path: need('out'),
      acceptAbsolute: true,
      refusal: 'Draft --out must be inside the explicit workspace .ia/work directory',
      content: Buffer.from(text),
    });
  };
  if (command === 'recover-projection') return { exitCode: 0, result: recoverProjection(need('out')) };
  if (command === 'remove-projection') return { exitCode: 0, result: removeProjection(need('out'), need('id')) };
  const session = openWorkspaceSession({ root }),
    reader = session.reader;
  try {
    if (command === 'validate') {
      const admission = session.admission();
      return { exitCode: admission.status === 'refused' ? 1 : 0, result: admission };
    }
    const within = session.within();
    if (command === 'render') {
      const sourceId = flags.get('source-id') ?? 'project',
        capture = captureWorkspace(root, sourceId);
      const resourceText = read('resources', 26 * 1024 * 1024),
        values = read('values', 65536),
        resources = verifyResources(resourceText, capture);
      const owner = resourceOccurrences(capture).occurrences.find((o) => o.identity === need('template'));
      if (!owner) fail('SOURCE-UNAVAILABLE', 'Template identity is not admitted');
      const result = renderCapturedTemplate(capture, resources, {
        reader,
        within,
        owner,
        allowedResources: resources.files.map((f) => f.key),
        expectedResourcesDigest: resources.digest,
        values,
      });
      if (result.status === 'refused') return { exitCode: 1, result };
      if (
        captureWorkspace(root, sourceId).revision !== capture.revision ||
        read('resources', 26 * 1024 * 1024) !== resourceText ||
        read('values', 65536) !== values
      )
        fail('PLAN-STALE', 'Template inputs changed before returning the draft');
      draft(result.artifact.text);
      return { exitCode: 0, result };
    }
    if (command === 'format') {
      const path = portable(need('path')),
        source = read('input', 1024 * 1024);
      const outcome = formatSource({ session, path, text: source, reread: () => read('input', 1024 * 1024) });
      if (outcome.status === 'refused') return { exitCode: 1, result: outcome };
      draft(outcome.text);
      return { exitCode: 0, result: outcome };
    }
    if (command === 'explain') {
      if (flags.has('record') === flags.has('resource'))
        fail('INPUT-INVALID', 'Select exactly one --record or --resource');
      if (flags.has('record')) {
        const record = reader.get(need('record'), { within });
        if (!record) fail('SOURCE-UNAVAILABLE', 'Record is not admitted in this workspace');
        return { exitCode: 0, result: { revision: reader.revision, record } };
      }
      const envelope = verifyResources(
        read('resources', 24 * 1024 * 1024),
        captureWorkspace(root, flags.get('source-id') ?? 'project'),
      );
      const file = envelope.files.find((f) => `${f.key.source}:${f.key.path}` === need('resource'));
      if (!file) fail('SOURCE-UNAVAILABLE', 'Resource is not in the selected envelope');
      const { content: _content, ...metadata } = file;
      return {
        exitCode: 0,
        result: {
          digest: envelope.digest,
          resource: metadata,
          associations: envelope.associations.filter((a) =>
            a.resources.some((r) => JSON.stringify(r.key) === JSON.stringify(file.key)),
          ),
        },
      };
    }
    const descriptorText = read('descriptor', 2 * 1024 * 1024),
      resourceText = read('resources', 24 * 1024 * 1024);
    const sourceId = flags.get('source-id') ?? 'project',
      capture = captureWorkspace(root, sourceId);
    const descriptor = verifyProjectionDescriptor(descriptorText),
      resources = verifyResources(resourceText, capture);
    const host = need('host');
    if (host !== 'claude' && host !== 'codex') fail('HOST-UNSUPPORTED', 'Host must be claude or codex');
    const fields = [
      ...new Set(
        descriptor.exports.flatMap((e) =>
          e.presentation.kind === 'agent' ? [] : e.presentation.arguments.map((a) => a.target),
        ),
      ),
    ];
    const catalog = (host === 'codex' ? codexProseCatalog : claudeProseCatalog)(installedImplementationDigest(), {
      models: [{ id: 'inherit', name: 'inherit' }],
      tools: [
        { id: 'read', name: host === 'codex' ? 'read' : 'Read' },
        { id: 'glob', name: host === 'codex' ? 'glob' : 'Glob' },
        { id: 'grep', name: host === 'codex' ? 'grep' : 'Grep' },
        { id: 'bash', name: host === 'codex' ? 'shell' : 'Bash' },
        { id: 'web-fetch', name: host === 'codex' ? 'web' : 'WebFetch' },
      ],
      inputFields: fields.map((name) => ({ name, type: 'text' as const })),
    });
    const name = need('name'),
      version = need('version');
    const result = compileProjection(capture, descriptor, resources, {
      reader,
      within,
      allowedResources: resources.files.map((f) => f.key),
      expectedResourcesDigest: resources.digest,
      inventoryDigest: descriptor.inventoryDigest,
      catalog,
      name,
      version,
    });
    if (result.status !== 'compiled') return { exitCode: 1, result };
    const fresh = (): void => {
      if (
        captureWorkspace(root, sourceId).revision !== capture.revision ||
        read('descriptor', 2 * 1024 * 1024) !== descriptorText ||
        read('resources', 24 * 1024 * 1024) !== resourceText
      )
        fail('PLAN-STALE', 'Native or projection inputs changed; compile again');
    };
    fresh();
    const id = `${name}-${host}-${descriptor.product}`,
      output = need('out');
    const publication = flags.has('check')
      ? checkProjection(output, id, result)
      : publishProjection(output, id, result, { fresh });
    return { exitCode: publication.status === 'stale' ? 1 : 0, result: { ...publication, manifest: result.manifest } };
  } finally {
    session.close();
  }
}
