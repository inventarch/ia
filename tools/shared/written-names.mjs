/**
 * The one switch of the repository tools for the names they write into shared documents:
 * the committed `.ia/authoring.resources.json` and the product-structure selection.
 *
 * Older, separately released programs read those documents and refuse anything but the exact literals they were
 * released with. While this is `false` every writer emits the released name and shape; the plain names stay accepted
 * wherever a document is read. The follow-up release flips it to `true`.
 */
export const WRITE_PLAIN_NAMES = false;
