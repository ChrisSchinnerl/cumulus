import { AtUri } from "@atproto/api";
import { useCallback, useEffect, useState } from "react";
import {
  deleteSharePost,
  getPublicAgent,
  listSharePosts,
  SHARE_VALID_UNTIL,
  writeSharePost,
} from "../../lib/atproto";
import type { SharePost } from "../../lib/lexicons";
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
export type FeedTab = "following" | "mine";

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
    if (v === "mine" || v === "following") return v;
  } catch {
    // localStorage disabled or quota exceeded — fall through to default.
  }
  return "following";
}

/**
 * Build the list of authors to query for the given tab.
 *
 * - `following` → everyone the viewer follows (paged, up to {@link MAX_FOLLOWS}).
 * - `mine` → just the viewer.
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
  if (tab === "mine") return [self];

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
 * Whether a feed entry represents content the viewer "already has." Two
 * cases trigger this:
 *
 * 1. **The post's source is one we've already saved.** The post's "source"
 *    is `post.sourceUri ?? post.uri` — an original post is its own source.
 *    If that URI is in our saved-sources set, we've repinned this content.
 *
 * 2. **The post's source author is us.** A friend's repost of *our* original
 *    has `sourceUri` whose DID is ours; in that case we have the content
 *    natively without ever having saved it.
 */
function isAlreadyMine(
  entry: FeedEntry,
  savedSourceUris: Set<string>,
  myDid: string | null,
): boolean {
  const source = entry.post.sourceUri ?? entry.uri;
  if (savedSourceUris.has(source)) return true;
  if (!myDid) return false;
  try {
    return new AtUri(source).host === myDid;
  } catch {
    return false;
  }
}

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
 * - "Mine" — the viewer's own shares, with delete buttons.
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
   * Source URIs (the original at-uri of each repinned post) currently in the
   * viewer's own repo. Used in the Following tab to render "Saved" — paired
   * with a separate "the source author is me" DID check so we also recognize
   * reposts of our own originals.
   */
  const [savedSourceUris, setSavedSourceUris] = useState<Set<string>>(
    new Set(),
  );

  const refresh = useCallback(async () => {
    if (!agent || !did) return;
    setLoading(true);
    setError(null);
    setEntries([]);
    try {
      // For Following tab, also load my own records in parallel so we know
      // which entries are already saved. Skipped for Mine tab (the entries
      // *are* my own, so the question doesn't apply). We collect the
      // `sourceUri` field from each of my records — that's the at-uri of
      // the original post the save came from.
      const mySourcesPromise =
        tab === "following"
          ? listSharePosts(did, 100)
              .then(
                (records) =>
                  new Set(
                    records
                      .map((r) => r.value.sourceUri)
                      .filter((u): u is string => !!u),
                  ),
              )
              .catch(() => new Set<string>())
          : Promise.resolve(new Set<string>());

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

      setSavedSourceUris(await mySourcesPromise);
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
   * Delete one of the viewer's own share entries — both the Sia indexer
   * object and the atproto share record.
   *
   * Order: indexer first, atproto second. If the indexer call fails, we
   * abort and leave the atproto record intact so the user can retry. If the
   * indexer succeeds but the atproto delete fails, the file is already gone
   * but the orphan record is harmless and self-evident on retry.
   *
   * The Sia object key comes from the share record's `siaKey` field. For
   * legacy records (pre-`siaKey`) we fall back to reconstructing a
   * PinnedObject from the share URL — this works when `sharedObject(url)`
   * yields the same id as the originally pinned object.
   */
  const handleDelete = useCallback(
    async (entry: FeedEntry): Promise<void> => {
      if (!agent || !sdk) throw new Error("Not connected");
      let siaKey = entry.post.siaKey;
      if (!siaKey) {
        const obj = await sdk.sharedObject(entry.post.shareUrl);
        siaKey = obj.id();
      }
      try {
        await sdk.deleteObject(siaKey);
      } catch (e) {
        // Treat "object not found" as success — if the indexer doesn't
        // know about it, the delete's intent is already satisfied. Lets us
        // clean up orphan atproto records when the indexer state diverged
        // (e.g. unpinned via another client, repos restored, etc.).
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        if (!msg.includes("not found")) throw e;
      }
      await deleteSharePost(agent, entry.uri);
      setEntries((prev) =>
        prev ? prev.filter((e) => e.uri !== entry.uri) : prev,
      );
      // If the deleted record was a save, drop its source URI from the set
      // so the original re-shows "Save" in Following.
      const sourceUri = entry.post.sourceUri;
      if (sourceUri) {
        setSavedSourceUris((prev) => {
          if (!prev.has(sourceUri)) return prev;
          const next = new Set(prev);
          next.delete(sourceUri);
          return next;
        });
      }
    },
    [agent, sdk],
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
      await writeSharePost(agent, {
        ...rest,
        shareUrl: myShareUrl,
        siaKey,
        createdAt: new Date().toISOString(),
        sourceUri,
      });

      setSavedSourceUris((prev) => {
        const next = new Set(prev);
        next.add(sourceUri);
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
            onClick={() => setTab("mine")}
            className={tabClass(tab === "mine")}
          >
            Mine
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
          {entries.map((e) => (
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
              onDelete={tab === "mine" ? () => handleDelete(e) : undefined}
              onSave={tab === "following" ? () => handleSave(e) : undefined}
              isSaved={
                tab === "following" && isAlreadyMine(e, savedSourceUris, did)
              }
            />
          ))}
        </div>
      )}

      {(!entries || entries.length === 0) && loading && (
        <p className="text-sm text-neutral-500 py-8 text-center">
          Loading feed...
        </p>
      )}

      {entries && entries.length === 0 && !loading && (
        <p className="text-sm text-neutral-500 py-8 text-center">
          {tab === "mine"
            ? "You haven\u2019t shared anything yet — drop a file above."
            : "No shares yet — follow someone who has, or switch to Mine."}
        </p>
      )}
    </div>
  );
}
