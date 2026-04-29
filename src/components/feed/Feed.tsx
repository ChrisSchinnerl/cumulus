import type { Agent } from '@atproto/api'
import { useCallback, useEffect, useState } from 'react'
import { deleteSharePost, listSharePosts } from '../../lib/atproto'
import type { SharePost } from '../../lib/lexicons'
import { useAtprotoStore } from '../../stores/atproto'
import { useAuthStore } from '../../stores/auth'
import { FeedItem } from './FeedItem'

type Author = {
  did: string
  handle: string
  displayName: string | null
  avatar: string | null
}

type FeedEntry = {
  uri: string
  author: Author
  post: SharePost
}

/** Which slice of share posts to render. */
export type FeedTab = 'following' | 'mine'

/**
 * Maximum number of follows we page through when building the "Following"
 * feed. Prevents unbounded fanout for users with very large follow graphs.
 */
const MAX_FOLLOWS = 200

/**
 * Max in-flight `listRecords` calls when loading the feed. Each call hits a
 * different PDS, but plc.directory rate-limits and the Bluesky-hosted PDSes
 * also push back if you fan out hundreds of requests at once.
 */
const FEED_FETCH_CONCURRENCY = 8

/**
 * Build the list of authors to query for the given tab.
 *
 * - `following` → everyone the viewer follows (paged, up to {@link MAX_FOLLOWS}).
 * - `mine` → just the viewer.
 */
async function loadAuthors(
  agent: Agent,
  viewerDid: string,
  tab: FeedTab,
): Promise<Author[]> {
  const viewerProfile = await agent.app.bsky.actor.getProfile({
    actor: viewerDid,
  })
  const self: Author = {
    did: viewerDid,
    handle: viewerProfile.data.handle,
    displayName: viewerProfile.data.displayName ?? null,
    avatar: viewerProfile.data.avatar ?? null,
  }
  if (tab === 'mine') return [self]

  const follows: Author[] = []
  let cursor: string | undefined
  while (follows.length < MAX_FOLLOWS) {
    const res = await agent.app.bsky.graph.getFollows({
      actor: viewerDid,
      limit: 100,
      cursor,
    })
    for (const f of res.data.follows) {
      follows.push({
        did: f.did,
        handle: f.handle,
        displayName: f.displayName ?? null,
        avatar: f.avatar ?? null,
      })
    }
    if (!res.data.cursor || res.data.follows.length === 0) break
    cursor = res.data.cursor
  }
  return follows
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
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      const item = items[idx]
      try {
        const r = await fn(item)
        onItem(r, item)
      } catch (e) {
        console.warn('feed: author load failed', item, e)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )
}

/** Newest-first sort over share entries by `createdAt`. */
function sortByCreatedAtDesc(entries: FeedEntry[]): FeedEntry[] {
  return [...entries].sort(
    (a, b) =>
      new Date(b.post.createdAt).getTime() -
      new Date(a.post.createdAt).getTime(),
  )
}

/**
 * The main social feed. Switches between two tabs:
 *
 * - "Following" — shares from everyone the viewer follows on Bluesky.
 * - "Mine" — the viewer's own shares, with delete buttons.
 */
export function Feed() {
  const agent = useAtprotoStore((s) => s.agent)
  const did = useAtprotoStore((s) => s.did)
  const sdk = useAuthStore((s) => s.sdk)
  const [tab, setTab] = useState<FeedTab>('following')
  const [entries, setEntries] = useState<FeedEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!agent || !did) return
    setLoading(true)
    setError(null)
    setEntries([])
    try {
      const authors = await loadAuthors(agent, did, tab)
      const accumulated: FeedEntry[] = []
      await pMap(
        authors,
        FEED_FETCH_CONCURRENCY,
        async (author) => {
          const records = await listSharePosts(author.did, 20)
          return records.map((r) => ({
            uri: r.uri,
            author,
            post: r.value,
          }))
        },
        (batch) => {
          if (batch.length === 0) return
          accumulated.push(...batch)
          setEntries(sortByCreatedAtDesc(accumulated))
        },
      )
    } catch (e) {
      console.error('feed load failed:', e)
      setError(e instanceof Error ? e.message : 'Failed to load feed')
    } finally {
      setLoading(false)
    }
  }, [agent, did, tab])

  useEffect(() => {
    refresh()
  }, [refresh])

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
      if (!agent || !sdk) throw new Error('Not connected')
      let siaKey = entry.post.siaKey
      if (!siaKey) {
        const obj = await sdk.sharedObject(entry.post.shareUrl)
        siaKey = obj.id()
      }
      await sdk.deleteObject(siaKey)
      await deleteSharePost(agent, entry.uri)
      setEntries((prev) =>
        prev ? prev.filter((e) => e.uri !== entry.uri) : prev,
      )
    },
    [agent, sdk],
  )

  const tabClass = (active: boolean): string =>
    `text-xs px-3 py-1.5 rounded-lg transition-colors ${
      active
        ? 'bg-neutral-900 text-white'
        : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100'
    }`

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab('following')}
            className={tabClass(tab === 'following')}
          >
            Following
          </button>
          <button
            type="button"
            onClick={() => setTab('mine')}
            className={tabClass(tab === 'mine')}
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
          {loading ? 'Refreshing...' : 'Refresh'}
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
              thumbnail={e.post.thumbnail}
              onDelete={tab === 'mine' ? () => handleDelete(e) : undefined}
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
          {tab === 'mine'
            ? 'You haven\u2019t shared anything yet — drop a file above.'
            : 'No shares yet — follow someone who has, or switch to Mine.'}
        </p>
      )}
    </div>
  )
}
