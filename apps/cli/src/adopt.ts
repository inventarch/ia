import { applyAdoption, openRegistry, planAdoption, selectCollection } from '@inventarch/distribution/registry';
import type { WorkspaceRelease } from '@inventarch/distribution/registry';
import type { Context, Result } from './consumer.js';
import { confirm, Refusal, requireRoot } from './consumer.js';
import { UsageError } from './args.js';
import { collectCapture } from './capture.js';
import { hostRegistryChooser, registeredProjections, REQUEST, requireProjectionsClean } from './distribute.js';
import { applyHostProjection, renderProjectionFor } from './host-projection.js';

export async function registryWorkspace(
  context: Context,
  root: string,
  locator: string,
): Promise<{ id: string; release: WorkspaceRelease }> {
  const match = REQUEST.exec(locator);
  if (!match) throw new UsageError('Adoption locator must be <provider/name>[@version]');
  const id = match[1]!,
    choose = hostRegistryChooser(context.host, root, context.args.value('registry'));
  const registry = await openRegistry(choose(id).base, { signal: context.host.signal });
  return { id, release: await selectCollection(registry, 'workspace', id, match[2] ?? '*') };
}
export async function runAdopt(context: Context): Promise<Result> {
  const root = requireRoot(context),
    selected = await registryWorkspace(context, root, context.args.positionals[0]!);
  const plan = planAdoption(root, selected.id, selected.release);
  const hosts = registeredProjections(root, 'update');
  const summary = `Adopt ${selected.id}@${selected.release.version} at ${plan.tree}/.ia/src @open (band 50).\n`;
  if (!context.args.flag('apply'))
    return {
      exitCode: 0,
      stdout: context.json
        ? JSON.stringify({ command: 'adopt', applied: false, plan, refresh: hosts }) + '\n'
        : summary + 'Apply with --apply --yes.\n',
      stderr: '',
    };
  requireProjectionsClean(root, hosts, true);
  if (!context.args.flag('yes') && !(await confirm(context.host.interaction, summary, 'Apply this adoption?')))
    return { exitCode: 0, stdout: 'Adoption declined.\n', stderr: '' };
  context.host.signal?.throwIfAborted();
  applyAdoption(plan);
  try {
    const capture = collectCapture(root, root);
    const projections = hosts.map((host) => applyHostProjection(root, host, renderProjectionFor(root, host)));
    return {
      exitCode: 0,
      stdout: context.json
        ? JSON.stringify({
            command: 'adopt',
            applied: true,
            id: selected.id,
            revision: selected.release.revision,
            tree: plan.tree,
            capture: capture.snapshot.revision,
            projections,
          }) + '\n'
        : summary + 'Adopted, captured and refreshed registered projections.\n',
      stderr: '',
    };
  } catch (error) {
    throw new Refusal(
      'IA-CLI-ADOPTION-APPLIED',
      `The adoption is applied; capture/projection failed: ${error instanceof Error ? error.message : String(error)}`,
      3,
      { path: root },
      [
        `ia capture --root ${JSON.stringify(root)}`,
        ...hosts.map((host) => `ia project ${host} --root ${JSON.stringify(root)} --apply --yes`),
      ].join('; '),
    );
  }
}
