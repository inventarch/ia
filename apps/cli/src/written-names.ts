/**
 * The one switch of this package for the names it writes into shared documents (decision dec-008).
 *
 * Older, separately released programs read the capture snapshot, the tracked-workspaces list, the migration journal and
 * the machine output this package writes, and refuse anything but the exact literals they were released with. While
 * this is `false` every writer emits the released name and shape; the plain names stay accepted wherever a document is
 * read. The follow-up release flips it to `true`, and every writer then emits the plain name with its `formatVersion`.
 */
export const WRITE_PLAIN_NAMES: boolean = false;
