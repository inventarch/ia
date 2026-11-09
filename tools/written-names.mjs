/**
 * The one switch of the repository tools for the names they write into shared documents (decision dec-008,
 * amendment A15): the committed `.ia/authoring.resources.json`, the host payload and the projection fixtures.
 *
 * Older, separately released programs read those documents and refuse anything but the exact literals they were
 * released with. While this is `false` every writer emits the released name and shape; the plain names stay accepted
 * wherever a document is read. The follow-up release flips it to `true`. The release ledgers (`npm-change-note`,
 * `npm-changeset`, `native-release-notes`, `public-package-inputs`) are read only by these tools at the same commit,
 * so they stay plain and do not consult it.
 */
export const WRITE_PLAIN_NAMES = false;
