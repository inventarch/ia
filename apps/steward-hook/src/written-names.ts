/**
 * The one switch of this package for the names it writes into shared documents (decision dec-008).
 *
 * Older, separately released programs probe this hook's identity and compare the implementation digest it reports,
 * and refuse anything but the exact literals they were released with. While this is `false` the identity and the
 * implementation digest carry the released names; the plain names stay accepted wherever a document is read. The
 * follow-up release flips it to `true`.
 */
export const WRITE_PLAIN_NAMES: boolean = false;
