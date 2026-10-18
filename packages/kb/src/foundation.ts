import { verifyCapture } from '@inventarch/workspace-runtime';
import type { Capture } from '@inventarch/workspace-runtime';
import { admitSourceCapture, readSourceInstallation } from '@inventarch/workspace-runtime/sources';
import type { RetainedSourceInstallation } from '@inventarch/workspace-runtime/sources';
import { readInstalledGeneration } from '@inventarch/db/distribution';
import type { InstalledGeneration } from '@inventarch/db/distribution';
import { KERNEL_SOURCES, LANGUAGE_VERSION } from '@inventarch/language';
import { digest as nativeDigest } from '@inventarch/session-system';
import { closed, data, digest, fail, frozen, sha } from './format.js';

export interface NativeProfile {
  readonly id: string;
  readonly version: string;
  readonly archive: string;
  readonly manifest: string;
}
export interface Foundation {
  readonly capture: Capture;
  readonly pin: string;
  readonly installed: readonly { readonly name: string; readonly version: string }[];
  readonly native: NativeProfile;
  readonly grammar: string;
  readonly engine: string;
}
export interface FoundationInput {
  readonly installation: RetainedSourceInstallation;
}
type Profile = Omit<Foundation, 'pin'>;
const trusted = new WeakSet<Foundation>();
export function requireFoundation(value: Foundation): void {
  if (!trusted.has(value)) fail('Host-owned foundation required');
}
export function capture(body: Omit<Capture, 'revision'>): Capture {
  return verifyCapture({ ...body, revision: nativeDigest(body) });
}
export const nativeInput = (c: Capture) => ({
  root: process.cwd(),
  sources: c.sources,
  folders: c.folders,
  floorOrigin: c.floorOrigin,
  fingerprint: c.revision,
  ...(c.activation ? { activation: c.activation } : {}),
});
function admit(input: Profile, pin: string): Foundation {
  const c = verifyCapture(input.capture);
  closed(input.native, ['id', 'version', 'archive', 'manifest']);
  sha(input.native.archive);
  sha(input.native.manifest);
  if (
    input.native.id !== 'inventarch/language' ||
    !/^\d+\.\d+\.\d+$/.test(input.native.version) ||
    input.grammar !== '1.0' ||
    typeof input.engine !== 'string'
  )
    fail('Unsupported foundation profile');
  if (c.floorOrigin !== 'embedded' || !c.activation)
    return fail('Exact installed foundation with embedded package floor required');
  const prefix = '.ia/distributions/store/' + input.native.archive + '/.ia/src/';
  const composition = '.ia/distributions/generations/' + c.activation.generation + '/workspace.ia';
  if (
    c.sources.some(
      (s) =>
        !(
          (s.location.placement.kind === 'floor' && s.path.startsWith('.ia/src/floor/')) ||
          (s.location.placement.kind === 'adopted' && s.path.startsWith(prefix)) ||
          (s.location.placement.kind === 'authored' && s.path === composition)
        ),
    )
  )
    fail('Injected source outside public foundation');
  if (!admitSourceCapture(c).ok) fail('Native foundation admission failed');
  const result = frozen({ ...input, capture: c, pin });
  trusted.add(result);
  return result;
}
/** Host-selected installation evidence; metadata and source bytes are verified by their native owner. */
export function createFoundation(input: FoundationInput): Foundation {
  const value = closed<FoundationInput>(data(input, 48 * 1024 * 1024), ['installation']);
  const installed = readSourceInstallation(value.installation);
  return installedFoundation(installed);
}
function installedFoundation(installed: Pick<InstalledGeneration, 'pointer' | 'lock' | 'sources'>): Foundation {
  const pkg = installed.lock.packages[0];
  if (installed.lock.packages.length !== 1 || pkg?.id !== 'inventarch/language')
    return fail('Exactly one public native foundation required');
  const sources = [
    ...KERNEL_SOURCES.map((s) => ({
      ...s,
      location: {
        placement: { kind: 'floor' as const, band: 10 as const, reach: '' },
        provenance: 'bootstrap' as const,
      },
    })),
    ...installed.sources,
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  const folders = [
    ...new Set(
      sources.flatMap((s) => {
        const m = /\/systems\/([^/]+)\//.exec(s.path);
        return m ? [m[1]!] : [];
      }),
    ),
  ].sort();
  const c = capture({
    version: 1,
    id: 'foundation',
    sources,
    folders,
    floorOrigin: 'embedded',
    activation: installed.pointer,
  });
  const profile = {
    capture: c,
    installed: [],
    native: { id: pkg.id, version: pkg.version, archive: pkg.archive, manifest: pkg.manifest },
    grammar: LANGUAGE_VERSION,
    engine: installed.lock.engine,
  };
  return admit(profile, digest({ format: 'ia.kb.foundation.v1', ...profile }));
}
/** Reconstruct the original v1 pin from retained inputs, never expanded executing dependencies. */
export function createLegacyFoundation(input: unknown): Foundation {
  const value = closed<Foundation>(data(input), ['capture', 'pin', 'installed', 'native', 'grammar', 'engine']);
  if (value.native.version !== '3.1.1' || !Array.isArray(value.installed) || !value.installed.length)
    fail('Exact legacy 3.1.1 inventory required');
  for (const p of value.installed) {
    closed(p, ['name', 'version']);
    if (!/^@inventarch\/[a-z][a-z0-9-]*$/.test(p.name) || p.version !== '3.1.1')
      fail('Invalid legacy package inventory');
  }
  if (
    new Set(value.installed.map((p) => p.name)).size !== value.installed.length ||
    value.installed.map((p) => p.name).join('\n') !==
      [...value.installed]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => p.name)
        .join('\n')
  )
    fail('Noncanonical legacy package inventory');
  const native = { ...value.native, dependencies: [], location: 'sha256:' + value.native.archive };
  const pin = digest({ native, capture: value.capture.revision, installed: value.installed });
  if (pin !== value.pin) fail('Legacy foundation input/pin mismatch');
  const { pin: _pin, ...profile } = value;
  return admit(profile, pin);
}
export function foundationFromWorkspace(root: string): Foundation {
  const installed = readInstalledGeneration(root);
  if (!installed) return fail('Installed native foundation required');
  return installedFoundation(installed);
}
