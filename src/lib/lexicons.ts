/**
 * NSID for cumulus share post records — used as the `collection` parameter
 * when reading/writing records via `com.atproto.repo.*` XRPC methods.
 */
export const NSID_SHARE_POST = "app.cumulus.share.post";

/**
 * Free-form tags attached to a {@link SharePost}. Each key carries a single
 * string value; multi-value lists are encoded as comma-separated text inside
 * the value (`genre: "romance, action"`). Both keys and values are
 * user-defined and matched case-insensitively at search time.
 */
export type Tags = Record<string, string>;

/**
 * The shape of a single share record stored in the user's atproto repo.
 * `shareUrl` is what `sdk.shareObject(...)` returns and is fed back into
 * `sdk.sharedObject(url)` on the consumer side. The record itself is public;
 * encryption lives in the Sia layer.
 */
export type SharePost = {
  $type: typeof NSID_SHARE_POST;
  shareUrl: string;
  name: string;
  mimeType: string;
  size: number;
  /** ISO-8601 datetime; used as the feed sort key. */
  createdAt: string;
  /**
   * Indexer object key (`PinnedObject.id()`). Required on the author's own
   * indexer to call `sdk.deleteObject(...)`; surfacing it in the public
   * record means cross-device deletion works without local bookkeeping.
   * Optional for backwards compatibility with records written before this
   * field existed — old records fall back to `sharedObject(url).id()`.
   */
  siaKey?: string;
  /**
   * Optional inline preview as a `data:image/jpeg;base64,...` URL. Generated
   * client-side at upload time for image MIME types. Capped at a few KB so
   * the atproto record stays small.
   */
  thumbnail?: string;
  /**
   * `at://` URI of the original record this post was repinned from. Set when
   * a user clicks "Save" on someone else's share; absent on original uploads.
   * Used internally to render the Save → Saved state in the Following feed —
   * not displayed in the UI.
   */
  sourceUri?: string;
  /**
   * Optional user-defined metadata. Used by the search bar and rendered as
   * clickable chips on each post (clicking adds `key:value` to the query).
   */
  tags?: Tags;
};

/** A `SharePost` paired with its repo URI + CID (as returned by listRecords). */
export type SharePostRecord = {
  uri: string;
  cid: string;
  value: SharePost;
};

/**
 * Runtime guard for {@link SharePost}. Use when reading records from arbitrary
 * repos — values are untrusted JSON until validated.
 */
export function isSharePost(value: unknown): value is SharePost {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.$type === NSID_SHARE_POST &&
    typeof v.shareUrl === "string" &&
    typeof v.name === "string" &&
    typeof v.mimeType === "string" &&
    typeof v.size === "number" &&
    typeof v.createdAt === "string" &&
    (v.siaKey === undefined || typeof v.siaKey === "string") &&
    (v.thumbnail === undefined || typeof v.thumbnail === "string") &&
    (v.sourceUri === undefined || typeof v.sourceUri === "string") &&
    (v.tags === undefined || isTags(v.tags))
  );
}

/** Runtime guard for the {@link Tags} shape. */
function isTags(value: unknown): value is Tags {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== "string") return false;
  }
  return true;
}
