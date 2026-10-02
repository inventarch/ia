import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

// The toolchain refuses symlinked path components on purpose. macOS keeps the per-user temporary
// directory under /var, a symlink to /private/var, so every fixture root created under tmpdir()
// would be refused. Import this module before anything creates a temporary root: it points TMPDIR
// at the physical directory for this process and the children it starts. Windows reads TEMP/TMP
// instead, and canonical-temp.mjs covers its runners. An unreadable TMPDIR is left as it is, so the
// operation that uses it reports the real error.
if (process.platform !== 'win32') {
  const selected = tmpdir();
  let physical;
  try {
    physical = realpathSync.native(selected);
  } catch {
    physical = selected;
  }
  if (physical !== selected) process.env.TMPDIR = physical;
}
