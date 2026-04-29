import {
  encodedSize,
  PinnedObject,
  type ShardProgress,
} from '@siafoundation/sia-storage'
import { useRef, useState } from 'react'
import { writeSharePost } from '../../lib/atproto'
import { APP_KEY, DATA_SHARDS, PARITY_SHARDS } from '../../lib/constants'
import { generateImageThumbnail } from '../../lib/preview'
import { useAtprotoStore } from '../../stores/atproto'
import { useAuthStore } from '../../stores/auth'
import { DevNote } from '../DevNote'

type UploadProgress = {
  fileName: string
  fileSize: number
  shardsDone: number
  bytesUploaded: number
  encodedTotal: number
}

/** Format a byte count as a short human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`
}

const isPlaceholderKey = APP_KEY.startsWith('{' + '{')

/**
 * `validUntil` for share URLs. We use a far-future date so shares effectively
 * never expire — atproto records are the source of truth for visibility.
 */
const SHARE_VALID_UNTIL = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000)

export type UploadZoneProps = {
  /** Called after a successful upload + share-record write. Used to refresh the feed. */
  onUploaded?: () => void
}

/**
 * Compose-only dropzone. Encrypts + uploads the file to Sia, then publishes
 * an `app.cumulus.share.post` record to the user's atproto repo so it
 * appears in followers' feeds. Owns no file list of its own — the {@link Feed}
 * component renders the user's own posts alongside their friends'.
 */
export function UploadZone({ onUploaded }: UploadZoneProps) {
  const sdk = useAuthStore((s) => s.sdk)
  const agent = useAtprotoStore((s) => s.agent)
  const [uploading, setUploading] = useState(false)
  const [activeUpload, setActiveUpload] = useState<UploadProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function uploadFile(file: File) {
    if (!sdk || !agent) return
    setUploading(true)
    setError(null)
    const encodedTotal = encodedSize(file.size, DATA_SHARDS, PARITY_SHARDS)
    setActiveUpload({
      fileName: file.name,
      fileSize: file.size,
      shardsDone: 0,
      bytesUploaded: 0,
      encodedTotal,
    })

    try {
      const hashBuffer = await crypto.subtle.digest(
        'SHA-256',
        await file.arrayBuffer(),
      )
      const hash = new Uint8Array(hashBuffer).toHex()

      const object = new PinnedObject()
      let shardsDone = 0
      let bytesUploaded = 0
      const pinnedObject = await sdk.upload(object, file.stream(), {
        maxInflight: 10,
        dataShards: DATA_SHARDS,
        parityShards: PARITY_SHARDS,
        onShardUploaded: (progress: ShardProgress) => {
          shardsDone++
          bytesUploaded += progress.shardSize
          setActiveUpload({
            fileName: file.name,
            fileSize: file.size,
            shardsDone,
            bytesUploaded,
            encodedTotal,
          })
        },
      })

      const metadata = {
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        hash,
        createdAt: Date.now(),
      }

      pinnedObject.updateMetadata(
        new TextEncoder().encode(JSON.stringify(metadata)),
      )
      await sdk.pinObject(pinnedObject)
      await sdk.updateObjectMetadata(pinnedObject)

      const shareUrl = sdk.shareObject(pinnedObject, SHARE_VALID_UNTIL)
      const thumbnail = await generateImageThumbnail(file).catch(() => null)
      await writeSharePost(agent, {
        shareUrl,
        siaKey: pinnedObject.id(),
        name: metadata.name,
        mimeType: metadata.type,
        size: metadata.size,
        createdAt: new Date(metadata.createdAt).toISOString(),
        ...(thumbnail ? { thumbnail } : {}),
      })
      onUploaded?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
      setActiveUpload(null)
    }
  }

  async function handleFiles(fileList: FileList) {
    for (const file of Array.from(fileList)) {
      await uploadFile(file)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  const uploadPercent = activeUpload
    ? Math.min(
        100,
        Math.round(
          (activeUpload.bytesUploaded / activeUpload.encodedTotal) * 100,
        ),
      )
    : 0

  return (
    <div className="space-y-4">
      {isPlaceholderKey && (
        <DevNote title="Replace Your App Key">
          <p>
            You&apos;re using the template placeholder. Set your own key in{' '}
            <code className="text-amber-700">src/lib/constants.ts</code> or
            scaffold a fresh project with{' '}
            <code className="text-amber-700">bunx create-sia-app</code>.
          </p>
        </DevNote>
      )}

      {error && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-600 hover:text-red-900 text-xs ml-4 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <label
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
        className={`relative block border-2 border-dashed rounded-xl p-10 text-center transition-all duration-150 ${
          uploading
            ? 'border-neutral-300 cursor-default'
            : dragOver
              ? 'border-green-600 bg-green-600/5 cursor-pointer'
              : 'border-neutral-300 hover:border-neutral-400 cursor-pointer'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {activeUpload ? (
          <div className="space-y-3">
            <p className="text-neutral-700 text-sm">
              Uploading{' '}
              <span className="text-neutral-900">{activeUpload.fileName}</span>{' '}
              <span className="text-neutral-500">
                ({formatBytes(activeUpload.fileSize)})
              </span>
            </p>
            <div className="w-full max-w-xs mx-auto bg-neutral-200 rounded-full h-1.5 overflow-hidden">
              {activeUpload.shardsDone === 0 ? (
                <div className="bg-green-600 h-full rounded-full w-1/4 animate-indeterminate" />
              ) : (
                <div
                  className="bg-green-600 h-full rounded-full transition-all duration-300"
                  style={{ width: `${uploadPercent}%` }}
                />
              )}
            </div>
            <p className="text-neutral-500 text-xs font-mono">
              {activeUpload.shardsDone} shards ·{' '}
              {formatBytes(
                (activeUpload.bytesUploaded / activeUpload.encodedTotal) *
                  activeUpload.fileSize,
              )}{' '}
              / {formatBytes(activeUpload.fileSize)}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <svg
              className="w-8 h-8 mx-auto text-neutral-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M12 16V4m0 0l-4 4m4-4l4 4" />
              <path d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" />
            </svg>
            <p className="text-neutral-600 text-sm">
              Drop a file to share with your followers
            </p>
            <p className="text-neutral-500 text-xs">
              Encrypted on Sia, indexed on atproto
            </p>
          </div>
        )}
      </label>
    </div>
  )
}
