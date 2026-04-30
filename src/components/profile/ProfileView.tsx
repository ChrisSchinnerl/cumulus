import { useEffect, useState } from 'react'
import { getPublicAgent, listSharePosts } from '../../lib/atproto'
import type { SharePost } from '../../lib/lexicons'
import { FeedItem } from '../feed/FeedItem'

type Profile = {
  did: string
  handle: string
  displayName: string | null
  avatar: string | null
}

type Entry = { uri: string; post: SharePost }

export type ProfileViewProps = {
  /** Handle (e.g. `alice.bsky.social`) of the user whose profile to render. */
  handle: string
}

/**
 * In-app profile page for a single Bluesky user. Shows their public profile
 * header (avatar, name, link to bsky.app) and a feed of their cumulus shares.
 *
 * Navigation in/out is handled by the parent via hash routing — set
 * `window.location.hash = '#/profile/<handle>'` to enter, clear it to leave.
 */
export function ProfileView({ handle }: ProfileViewProps) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setProfile(null)
    setEntries(null)
    ;(async () => {
      try {
        const pub = getPublicAgent()
        const profRes = await pub.app.bsky.actor.getProfile({ actor: handle })
        if (cancelled) return
        const resolved: Profile = {
          did: profRes.data.did,
          handle: profRes.data.handle,
          displayName: profRes.data.displayName ?? null,
          avatar: profRes.data.avatar ?? null,
        }
        setProfile(resolved)

        const records = await listSharePosts(resolved.did, 50)
        if (cancelled) return
        const sorted = records
          .map((r) => ({ uri: r.uri, post: r.value }))
          .sort(
            (a, b) =>
              new Date(b.post.createdAt).getTime() -
              new Date(a.post.createdAt).getTime(),
          )
        setEntries(sorted)
      } catch (e) {
        if (!cancelled) {
          console.error('profile load failed:', e)
          setError(e instanceof Error ? e.message : 'Failed to load profile')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [handle])

  return (
    <div className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            window.location.hash = ''
          }}
          className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors"
        >
          ← Back to feed
        </button>
      </div>

      <div className="flex items-center gap-4">
        {profile?.avatar ? (
          <img
            src={profile.avatar}
            alt=""
            className="w-16 h-16 rounded-full bg-neutral-200"
          />
        ) : (
          <div className="w-16 h-16 rounded-full bg-neutral-200" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-neutral-900 truncate">
            {profile?.displayName || handle}
          </p>
          <a
            href={`https://bsky.app/profile/${handle}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm text-neutral-500 hover:text-neutral-900 hover:underline transition-colors"
          >
            @{handle}
          </a>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
          {error}
        </div>
      )}

      {entries && entries.length > 0 && profile && (
        <div className="space-y-3">
          {entries.map((e) => (
            <FeedItem
              key={e.uri}
              handle={profile.handle}
              displayName={profile.displayName}
              avatar={profile.avatar}
              name={e.post.name}
              mimeType={e.post.mimeType}
              size={e.post.size}
              createdAt={e.post.createdAt}
              shareUrl={e.post.shareUrl}
              posterDid={profile.did}
              sourceUri={e.post.sourceUri}
              thumbnail={e.post.thumbnail}
              tags={e.post.tags}
            />
          ))}
        </div>
      )}

      {(!entries || entries.length === 0) && loading && (
        <p className="text-sm text-neutral-500 py-8 text-center">
          Loading profile...
        </p>
      )}

      {entries && entries.length === 0 && !loading && (
        <p className="text-sm text-neutral-500 py-8 text-center">
          @{handle} hasn&apos;t shared anything yet.
        </p>
      )}
    </div>
  )
}
