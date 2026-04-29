import { useState } from 'react'
import { useAuthStore } from '../../stores/auth'

/** Format a byte count as a short human-readable string (e.g. "1.2 MB"). */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`
}

/** Format an ISO date as a short relative-ish string (e.g. "2h ago", "3d ago"). */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const ms = Date.now() - then
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.round(hr / 24)
  return `${days}d ago`
}

export type FeedItemProps = {
  /** The author's handle (e.g. `alice.bsky.social`) — shown in the byline. */
  handle: string
  /** Optional display name; falls back to handle when absent. */
  displayName?: string | null
  /** Optional avatar URL fetched from the bsky AppView. */
  avatar?: string | null
  /** Original file name for download. */
  name: string
  mimeType: string
  size: number
  /** ISO datetime when the share was published. */
  createdAt: string
  /** Sia share URL — opaque pointer fed into `sdk.sharedObject(...)`. */
  shareUrl: string
  /**
   * Optional inline preview (JPEG `data:` URL). Rendered above the metadata
   * row when present — typically only for image uploads.
   */
  thumbnail?: string | null
  /**
   * Optional delete callback. When provided, a Delete button is rendered
   * alongside Download. The parent owns the actual deletion (atproto record
   * + Sia object) and is expected to remove this item from its list.
   */
  onDelete?: () => Promise<void>
}

/**
 * A single share entry in the feed. Renders author + file metadata, and
 * provides a download button that fetches the underlying object from Sia.
 * If `onDelete` is supplied, also renders a Delete button.
 */
export function FeedItem({
  handle,
  displayName,
  avatar,
  name,
  mimeType,
  size,
  createdAt,
  shareUrl,
  thumbnail,
  onDelete,
}: FeedItemProps) {
  const sdk = useAuthStore((s) => s.sdk)
  const [downloading, setDownloading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [progress, setProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleDownload() {
    if (!sdk) return
    setDownloading(true)
    setError(null)
    setProgress({ done: 0, total: size })
    try {
      const object = await sdk.sharedObject(shareUrl)
      const stream = sdk.download(object, { maxInflight: 10 })
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let done = 0
      while (true) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        chunks.push(value)
        done += value.length
        setProgress({ done, total: size })
      }
      const blob = new Blob(chunks as BlobPart[], { type: mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setDownloading(false)
      setProgress(null)
    }
  }

  async function handleDelete() {
    if (!onDelete || deleting) return
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
    setDeleting(true)
    setError(null)
    try {
      await onDelete()
    } catch (e) {
      setDeleting(false)
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
    // On success, the parent removes this row from its list, so we don't
    // bother resetting `deleting` — the component unmounts.
  }

  return (
    <div className="flex items-start gap-3 py-4">
      {avatar ? (
        <img
          src={avatar}
          alt=""
          className="w-9 h-9 rounded-full bg-neutral-200 shrink-0"
        />
      ) : (
        <div className="w-9 h-9 rounded-full bg-neutral-200 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-neutral-900 truncate">
            {displayName || handle}
          </span>
          <span className="text-neutral-500 truncate">@{handle}</span>
          <span className="text-neutral-400 text-xs shrink-0">
            · {formatRelative(createdAt)}
          </span>
        </div>
        {thumbnail && (
          <div className="relative mt-2 rounded-lg overflow-hidden border border-neutral-200/80 bg-neutral-50 inline-block max-w-full">
            <img
              src={thumbnail}
              alt={`Preview of ${name}`}
              className="block max-h-60 max-w-full"
            />
            {mimeType.startsWith('video/') && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
                <svg
                  className="w-12 h-12 text-white drop-shadow-md"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            )}
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-neutral-900 truncate">{name}</p>
            <p className="text-xs text-neutral-500 mt-0.5">
              {formatBytes(size)}
              {mimeType !== 'application/octet-stream' && (
                <span> · {mimeType}</span>
              )}
              {progress && (
                <span>
                  {' '}
                  · {formatBytes(progress.done)} / {formatBytes(progress.total)}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading || deleting}
              className="text-xs px-3 py-1.5 border border-neutral-300 rounded-lg hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              {downloading ? 'Downloading...' : 'Download'}
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={downloading || deleting}
                className="text-xs px-3 py-1.5 border border-red-200 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-40 disabled:cursor-default transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            )}
          </div>
        </div>
        {error && (
          <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
