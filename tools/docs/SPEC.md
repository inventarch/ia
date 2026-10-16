# Public language contract

This owner supplies the public language definitions or their structural checking mechanism. See the root language reference for schemas, identity and evaluation limits. Private design and assessment methods are not part of this owner.

## Roadmap sync adapter

`roadmap-sync-config.mjs` prepares the external roadmap sync tool's configuration at `.ia/work/roadmap-sync/config.json` from `docs/roadmap/config.json`. It reads and writes local files only and never invokes that tool. It judges an existing output through a descriptor opened without following a final link: a link at the output refuses rather than being followed, and a FIFO or device refuses as unmanaged rather than blocking the read.

Maintenance notes: the adapter writes the new configuration to a file it creates beside the output, `.config.json.<uuid>.tmp`, and renames that file over the output instead of writing in place. An output hard-linked elsewhere is therefore given a new file, and its other names keep the old bytes. On POSIX systems the new file takes a new file's default mode (0644 under the default umask), so a read-only managed output in a writable directory is replaced, and a writable output in a directory that is not writable is left as it was, because the temporary file cannot be created. On Windows, the rename can fail with `EPERM`, `EACCES` or `EBUSY` while another process holds the output open; the temporary file is then removed and the output is left as it was. Every thrown error removes the temporary file, but a process killed between creating it and the rename, by `SIGKILL` for example, leaves it beside the output as residue to delete by hand.
