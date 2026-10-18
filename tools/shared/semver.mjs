import assert from 'node:assert/strict';

/** Stable numeric package version, with no tag, leading zeros or prerelease. @param {unknown} value @returns {boolean} */
export function stableVersion(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}
/** @param {string} left @param {string} right @returns {-1 | 0 | 1} */
export function compareVersions(left, right) {
  assert.ok(stableVersion(left) && stableVersion(right), 'Stable package versions are required');
  const a = left.split('.').map(Number),
    b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0) ? -1 : 1;
  return 0;
}
