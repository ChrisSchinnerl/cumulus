import { AtUri } from "@atproto/api";
import { useCallback, useEffect, useState } from "react";
import {
  deleteSharePost,
  getPublicAgent,
  listSharePosts,
  SHARE_VALID_UNTIL,
  writeSharePost,
} from "../../lib/atproto";
import { NSID_SHARE_POST, type SharePost } from "../../lib/lexicons";
import { useAtprotoStore } from "../../stores/atproto";
import { useAuthStore } from "../../stores/auth";
import { FeedItem } from "./FeedItem";

type Author = {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
};

type FeedEntry = {
  uri: string;
  author: Author;
  post: SharePost;
};

/** Which slice of share posts to render. */
export type FeedTab = "following" | "library";

/**
 * Maximum number of follows we page through when building the "Following"
 * feed. Prevents unbounded fanout for users with very large follow graphs.
 */
const MAX_FOLLOWS = 200;

/**
 * Max in-flight `listRecords` calls when loading the feed. Each call hits a
 * different PDS, but plc.directory rate-limits and the Bluesky-hosted PDSes
 * also push back if you fan out hundreds of requests at once.
 */
const FEED_FETCH_CONCURRENCY = 8;

/** localStorage key for the last-selected tab — restored across reloads. */
const FEED_TAB_KEY = "cumulus:feed-tab";

/** Read the persisted tab; falls back to "following" on any error. */
function loadPersistedTab(): FeedTab {
  try {
    const v = localStorage.getItem(FEED_TAB_KEY);
    if (v === "library" || v === "following") return v;
  } catch {
    // localStorage disabled or quota exceeded — fall through to default.
  }
  return "following";
}

/**
 * Build the list of authors to query for the given tab.
 *
 * - `following` → everyone the viewer follows (paged, up to {@link MAX_FOLLOWS}).
 * - `library` → just the viewer (their own posts + saves).
 *
 * Uses the public AppView agent — `app.bsky.*` calls aren't reliably served
 * by the user's own PDS through OAuth tokens.
 */
async function loadAuthors(viewerDid: string, tab: FeedTab): Promise<Author[]> {
  const pub = getPublicAgent();
  const viewerProfile = await pub.app.bsky.actor.getProfile({
    actor: viewerDid,
  });
  const self: Author = {
    did: viewerDid,
    handle: viewerProfile.data.handle,
    displayName: viewerProfile.data.displayName ?? null,
    avatar: viewerProfile.data.avatar ?? null,
  };
  if (tab === "library") return [self];

  const follows: Author[] = [];
  let cursor: string | undefined;
  while (follows.length < MAX_FOLLOWS) {
    const res = await pub.app.bsky.graph.getFollows({
      actor: viewerDid,
      limit: 100,
      cursor,
    });
    for (const f of res.data.follows) {
      follows.push({
        did: f.did,
        handle: f.handle,
        displayName: f.displayName ?? null,
        avatar: f.avatar ?? null,
      });
    }
    if (!res.data.cursor || res.data.follows.length === 0) break;
    cursor = res.data.cursor;
  }
  return follows;
}

/**
 * Apply `fn` to `items` with at most `limit` concurrent in-flight calls. The
 * `onItem` callback fires as each item resolves, in completion order — used
 * to stream feed entries into the UI as they arrive.
 */
async function pMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onItem: (result: R, item: T) => void,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx];
      try {
        const r = await fn(item);
        onItem(r, item);
      } catch (e) {
        console.warn("feed: author load failed", item, e);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/**
 * Whether the source author of an entry is the viewer (i.e. the content
 * originated from one of the viewer's own posts, even when we're seeing it
 * via a friend's repost). Used to suppress the Save button on reposts of
 * our own originals — there's nothing to "save," we already have it.
 */
function isSourceAuthorMe(entry: FeedEntry, myDid: string | null): boolean {
  if (!myDid) return false;
  const source = entry.post.sourceUri ?? entry.uri;
  try {
    return new AtUri(source).host === myDid;
  } catch {
    return false;
  }
}

/** A reference to one of the viewer's own save records. */
type MySave = { uri: string; post: SharePost };

/** Newest-first sort over share entries by `createdAt`. */
function sortByCreatedAtDesc(entries: FeedEntry[]): FeedEntry[] {
  return [...entries].sort(
    (a, b) =>
      new Date(b.post.createdAt).getTime() -
      new Date(a.post.createdAt).getTime(),
  );
}

/**
 * The main social feed. Switches between two tabs:
 *
 * - "Following" — shares from everyone the viewer follows on Bluesky.
 * - "Library" — the viewer's own shares (uploads + saves), with delete buttons.
 */
export function Feed() {
  const agent = useAtprotoStore((s) => s.agent);
  const did = useAtprotoStore((s) => s.did);
  const sdk = useAuthStore((s) => s.sdk);
  const [tab, setTab] = useState<FeedTab>(loadPersistedTab);

  useEffect(() => {
    try {
      localStorage.setItem(FEED_TAB_KEY, tab);
    } catch {
      // ignore — best-effort persistence
    }
  }, [tab]);
  const [entries, setEntries] = useState<FeedEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Map of `sourceUri → my save record` for every save currently in the
   * viewer's repo. In the Following tab this drives both (a) detection of
   * already-saved entries and (b) the Delete action — we need the *my-side*
   * record's at-uri to delete, not the friend's post we're looking at.
   */
  const [savesBySource, setSavesBySource] = useState<Map<string, MySave>>(
    new Map(),
  );

  const refresh = useCallback(async () => {
    if (!agent || !did) return;
    setLoading(true);
    setError(null);
    setEntries([]);
    try {
      // For Following tab, also load my own records in parallel so we know
      // which entries are already saved. Skipped for Library tab (the entries
      // *are* my own, so the question doesn't apply). Build a map keyed by
      // sourceUri so the Delete action can find the right *my-side* record.
      const mySavesPromise =
        tab === "following"
          ? listSharePosts(did, 100)
              .then((records) => {
                const map = new Map<string, MySave>();
                for (const r of records) {
                  if (r.value.sourceUri) {
                    map.set(r.value.sourceUri, { uri: r.uri, post: r.value });
                  }
                }
                return map;
              })
              .catch(() => new Map<string, MySave>())
          : Promise.resolve(new Map<string, MySave>());

      const authors = await loadAuthors(did, tab);
      const accumulated: FeedEntry[] = [];
      await pMap(
        authors,
        FEED_FETCH_CONCURRENCY,
        async (author) => {
          const records = await listSharePosts(author.did, 20);
          return records.map((r) => ({
            uri: r.uri,
            author,
            post: r.value,
          }));
        },
        (batch) => {
          if (batch.length === 0) return;
          accumulated.push(...batch);
          setEntries(sortByCreatedAtDesc(accumulated));
        },
      );

      setSavesBySource(await mySavesPromise);
    } catch (e) {
      console.error("feed load failed:", e);
      setError(e instanceof Error ? e.message : "Failed to load feed");
    } finally {
      setLoading(false);
    }
  }, [agent, did, tab]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Delete one of the viewer's own records — both the Sia indexer object and
   * the atproto share record. Shared by `handleDelete` (Library tab) and
   * `handleUnsave` (Following tab → red Delete on a previously saved post).
   *
   * Order: indexer first, atproto second. If the indexer call fails we
   * abort and leave the atproto record intact for retry. "Object not found"
   * from the indexer is treated as success since the delete's intent is
   * already satisfied. Sia object key comes from `siaKey`; if the record
   * predates that field, we reconstruct a PinnedObject from the share URL.
   */
  const deleteMyRecord = useCallback(
    async (uri: string, post: SharePost): Promise<void> => {
      if (!agent || !sdk) throw new Error("Not connected");
      let siaKey = post.siaKey;
      if (!siaKey) {
        const obj = await sdk.sharedObject(post.shareUrl);
        siaKey = obj.id();
      }
      try {
        await sdk.deleteObject(siaKey);
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        if (!msg.includes("not found")) throw e;
      }
      await deleteSharePost(agent, uri);
    },
    [agent, sdk],
  );

  /** Library tab: delete the user's own entry from view + repo + indexer. */
  const handleDelete = useCallback(
    async (entry: FeedEntry): Promise<void> => {
      await deleteMyRecord(entry.uri, entry.post);
      setEntries((prev) =>
        prev ? prev.filter((e) => e.uri !== entry.uri) : prev,
      );
      const sourceUri = entry.post.sourceUri;
      if (sourceUri) {
        setSavesBySource((prev) => {
          if (!prev.has(sourceUri)) return prev;
          const next = new Map(prev);
          next.delete(sourceUri);
          return next;
        });
      }
    },
    [deleteMyRecord],
  );

  /**
   * Following tab: undo a save. The friend's post stays in the feed (it's
   * theirs), but our save record is removed so the button flips back to
   * green Save.
   */
  const handleUnsave = useCallback(
    async (save: MySave): Promise<void> => {
      await deleteMyRecord(save.uri, save.post);
      const sourceUri = save.post.sourceUri;
      if (sourceUri) {
        setSavesBySource((prev) => {
          if (!prev.has(sourceUri)) return prev;
          const next = new Map(prev);
          next.delete(sourceUri);
          return next;
        });
      }
    },
    [deleteMyRecord],
  );

  /**
   * Repin one of a friend's shares onto the viewer's own indexer + repo.
   *
   * Pinning Sia objects is content-addressed — the indexer just registers a
   * reference; the underlying shards already live on hosts. We then mint a
   * fresh share URL from our indexer (so my followers can fetch from me even
   * if the original author later deletes) and write a copy of the record to
   * my repo. All metadata fields from the original (thumbnail, mimeType,
   * future show/season/episode, etc.) are preserved by spreading; only
   * `shareUrl`, `siaKey`, and `createdAt` are overridden.
   *
   * `sourceUri` propagates: if we're saving a post that itself was a save
   * (already has `sourceUri` set), we keep that original URI rather than
   * pointing at the intermediate save. This way the chain always credits
   * the first creator, regardless of how many hops the post has taken.
   */
  const handleSave = useCallback(
    async (entry: FeedEntry): Promise<void> => {
      if (!agent || !sdk) throw new Error("Not connected");
      const obj = await sdk.sharedObject(entry.post.shareUrl);
      await sdk.pinObject(obj);
      await sdk.updateObjectMetadata(obj);
      const myShareUrl = sdk.shareObject(obj, SHARE_VALID_UNTIL);
      const siaKey = obj.id();

      const { $type: _type, ...rest } = entry.post;
      const sourceUri = rest.sourceUri ?? entry.uri;
      const newPost: SharePost = {
        $type: NSID_SHARE_POST,
        ...rest,
        shareUrl: myShareUrl,
        siaKey,
        createdAt: new Date().toISOString(),
        sourceUri,
      };
      const result = await writeSharePost(agent, {
        ...rest,
        shareUrl: myShareUrl,
        siaKey,
        createdAt: newPost.createdAt,
        sourceUri,
      });

      setSavesBySource((prev) => {
        const next = new Map(prev);
        next.set(sourceUri, { uri: result.uri, post: newPost });
        return next;
      });
    },
    [agent, sdk],
  );

  const tabClass = (active: boolean): string =>
    `text-xs px-3 py-1.5 rounded-lg transition-colors ${
      active
        ? "bg-neutral-900 text-white"
        : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100"
    }`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab("following")}
            className={tabClass(tab === "following")}
          >
            Following
          </button>
          <button
            type="button"
            onClick={() => setTab("library")}
            className={tabClass(tab === "library")}
          >
            Library
          </button>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-40 transition-colors"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
          {error}
        </div>
      )}

      {entries && entries.length > 0 && (
        <div className="divide-y divide-neutral-200/80">
          {entries.map((e) => {
            // Compute the per-entry action callbacks. Library tab → always
            // Delete on the entry itself. Following tab → if we've saved
            // it, Delete that *save* (lets the user undo accidental saves);
            // if we authored the original, no button (nothing to do); else
            // Save.
            const sourceOfP = e.post.sourceUri ?? e.uri;
            const mySave = savesBySource.get(sourceOfP);
            const sourceIsMine = isSourceAuthorMe(e, did);
            const onDelete =
              tab === "library"
                ? () => handleDelete(e)
                : tab === "following" && mySave
                  ? () => handleUnsave(mySave)
                  : undefined;
            const onSave =
              tab === "following" && !mySave && !sourceIsMine
                ? () => handleSave(e)
                : undefined;
            return (
              <FeedItem
                key={e.uri}
                handle={e.author.handle}
                displayName={e.author.displayName}
                avatar={e.author.avatar}
                name={e.post.name}
                mimeType={e.post.mimeType}
                size={e.post.size}
                createdAt={e.post.createdAt}
                shareUrl={e.post.shareUrl}
                posterDid={e.author.did}
                sourceUri={e.post.sourceUri}
                thumbnail={e.post.thumbnail}
                onDelete={onDelete}
                onSave={onSave}
              />
            );
          })}
        </div>
      )}

      {(!entries || entries.length === 0) && loading && (
        <p className="text-sm text-neutral-500 py-8 text-center">
          Loading feed...
        </p>
      )}

      {entries && entries.length === 0 && !loading && (
        <p className="text-sm text-neutral-500 py-8 text-center">
          {tab === "library"
            ? "You haven\u2019t shared anything yet — drop a file above."
            : "No shares yet — follow someone who has, or switch to Library."}
        </p>
      )}
    </div>
  );
}
