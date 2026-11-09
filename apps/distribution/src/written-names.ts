/**
 * The one switch of this package for the names it writes into shared documents (decision dec-008, amendment A15).
 *
 * Older, separately released programs read the registry content, host and registration state, journals and receipts
 * this package writes, and refuse anything but the exact literals they were released with. While this is `false`
 * every writer emits the released name and shape; the plain names stay accepted wherever a document is read. The
 * follow-up release flips it to `true`, and every writer then emits the plain name with its `formatVersion`. Saved
 * plans are read only by the build that made them, so they stay plain either way.
 */
export const WRITE_PLAIN_NAMES: boolean = false;
