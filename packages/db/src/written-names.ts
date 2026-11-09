/**
 * The one switch of this package for the names it writes into shared documents (decision dec-008, amendment A15).
 *
 * Older, separately released programs read the runner evidence this package writes and refuse anything but the exact
 * literal they were released with. While this is `false` every writer emits the released name and shape; the plain
 * names stay accepted wherever a document is read. The follow-up release flips it to `true`. The graph cache is read
 * only by the build that wrote it, so it stays plain.
 */
export const WRITE_PLAIN_NAMES: boolean = false;
