/**
 * The one switch of this package for the names it writes into shared documents.
 *
 * Older, separately released programs read those documents and refuse anything but the exact literals they were
 * released with. While this is `false` every writer emits the released name and shape; the plain names stay accepted
 * wherever a document is read. The follow-up release flips it to `true`.
 */
export const WRITE_PLAIN_NAMES: boolean = false;
