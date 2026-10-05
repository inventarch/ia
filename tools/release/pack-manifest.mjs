/** Resolve the supported workspace protocol before pnpm's asynchronous pack rewrite.
 * Only isolated pack staging is changed; dependency sections and other values survive.
 */
export function packManifest(manifest, versions) {
  const result = structuredClone(manifest);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (result[section] === undefined) continue;
    for (const [name, value] of Object.entries(result[section])) {
      if (typeof value !== 'string') throw new Error(`Invalid package dependency ${section}.${name}`);
      if (!value.startsWith('workspace:')) continue;
      if (value !== 'workspace:*') throw new Error(`Unsupported pack workspace dependency: ${name}=${value}`);
      const version = versions.get(name);
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
        throw new Error(`Missing exact pack workspace version: ${name}`);
      result[section][name] = version;
    }
  }
  return result;
}
