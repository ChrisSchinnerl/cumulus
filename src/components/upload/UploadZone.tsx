import { useCallback, useEffect, useRef, useState } from 'react'
import { encodedSize, PinnedObject, type ShardProgress } from '@siafoundation/sia-storage'
import { APP_KEY, DATA_SHARDS, PARITY_SHARDS } from '../../lib/constants'
import { useAuthStore } from '../../stores/auth'
import { DevNote } from '../DevNote'

type FileMetadata = {
  name: string
  type: string
  size: number
  hash: string
  createdAt?: number
  updatedAt?: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`
}

function decodeMetadata(bytes: Uint8Array): FileMetadata | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as FileMetadata
  } catch {
    return null
  }
}

type UploadedFile = {
  id: string
  metadata: FileMetadata
  object: PinnedObject
}

type UploadProgress = {
  fileName: string
  fileSize: number
  shardsDone: number
  bytesUploaded: number
  encodedTotal: number
}

type DownloadProgress = {
  shardsDone: number
  bytesDownloaded: number
  totalBytes: number
}

const isPlaceholderKey = APP_KEY.startsWith('{' + '{')

export function UploadZone() {
  const sdk = useAuthStore((s) => s.sdk)
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [activeUpload, setActiveUpload] = useState<UploadProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadFiles = useCallback(async () => {
    if (!sdk) return
    try {
      const events = await sdk.objectEvents(undefined, 100)
      const loaded: UploadedFile[] = []
      for (const event of events) {
        if (event.deleted || !event.object) continue
        const meta = decodeMetadata(event.object.metadata())
        if (meta?.name) {
          loaded.push({ id: event.id, metadata: meta, object: event.object })
        }
      }
      setFiles(loaded)
    } catch (e) {
      console.error('Failed to load files:', e)
    }
  }, [sdk])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  async function uploadFile(file: File) {
    if (!sdk) return
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

      const metadata: FileMetadata = {
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

      setFiles((prev) => [
        { id: pinnedObject.id(), metadata, object: pinnedObject },
        ...prev,
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
      setActiveUpload(null)
    }
  }

  async function downloadFile(file: UploadedFile) {
    if (!sdk) return
    setDownloading(file.id)
    setDownloadProgress({
      shardsDone: 0,
      bytesDownloaded: 0,
      totalBytes: file.metadata.size,
    })
    try {
      let shardsDone = 0
      const stream = sdk.download(file.object, {
        maxInflight: 10,
        onShardDownloaded: () => {
          shardsDone++
          setDownloadProgress((prev) => ({
            shardsDone,
            bytesDownloaded: prev?.bytesDownloaded ?? 0,
            totalBytes: file.metadata.size,
          }))
        },
      })

      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let bytesDownloaded = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        bytesDownloaded += value.length
        setDownloadProgress((prev) => ({
          shardsDone: prev?.shardsDone ?? 0,
          bytesDownloaded,
          totalBytes: file.metadata.size,
        }))
      }

      const blob = new Blob(chunks as BlobPart[], { type: file.metadata.type })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.metadata.name
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setDownloading(null)
      setDownloadProgress(null)
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
    <div className="flex-1 p-6 space-y-5 max-w-5xl mx-auto w-full">
      {/* Dev notes — remove these when shipping */}
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

      <DevNote title="Upload & Download">
        <p>
          <code className="text-amber-700">
            sdk.upload(object, file.stream(), opts)
          </code>{' '}
          encrypts, erasure-codes, and streams shards directly to Sia hosts.{' '}
          <code className="text-amber-700">sdk.download(object, opts)</code>{' '}
          returns a <code className="text-amber-700">ReadableStream</code> of
          decrypted bytes. Per-shard progress is reported via{' '}
          <code className="text-amber-700">onShardUploaded</code> /{' '}
          <code className="text-amber-700">onShardDownloaded</code>.
        </p>
      </DevNote>

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

      {/* Dropzone */}
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
        className={`relative block border-2 border-dashed rounded-xl p-16 text-center transition-all duration-150 ${
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
          <div className="space-y-4">
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
              {activeUpload.shardsDone} shards &middot;{' '}
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
              Drop files here or click to browse
            </p>
            <p className="text-neutral-500 text-xs">
              Encrypted end-to-end and stored on the Sia network
            </p>
          </div>
        )}
      </label>

      {/* File list */}
      {files.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            {files.length} file{files.length !== 1 ? 's' : ''}
          </h2>
          <div className="divide-y divide-neutral-200/80">
            {files.map((file) => {
              const isDownloading = downloading === file.id
              return (
                <div
                  key={file.id}
                  className="flex items-center justify-between py-3 group"
                >
                  <div className="flex-1 min-w-0 mr-4">
                    <p className="text-sm text-neutral-900 truncate">
                      {file.metadata.name}
                    </p>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      {formatBytes(file.metadata.size)}
                      {file.metadata.type !== 'application/octet-stream' && (
                        <span> &middot; {file.metadata.type}</span>
                      )}
                      {isDownloading && downloadProgress && (
                        <span>
                          {' '}
                          &middot;{' '}
                          {formatBytes(downloadProgress.bytesDownloaded)} /{' '}
                          {formatBytes(downloadProgress.totalBytes)} (
                          {downloadProgress.shardsDone} shards)
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={() => downloadFile(file)}
                      disabled={downloading !== null}
                      className="text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-30 disabled:cursor-default transition-colors"
                      title="Download"
                    >
                      {isDownloading ? (
                        <svg
                          className="w-4 h-4 animate-spin"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden="true"
                        >
                          <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                          <path d="M12 2a10 10 0 019.17 6" />
                        </svg>
                      ) : (
                        <svg
                          className="w-4 h-4"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          aria-hidden="true"
                        >
                          <path d="M12 4v12m0 0l-4-4m4 4l4-4" />
                          <path d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" />
                        </svg>
                      )}
                    </button>
                    <span
                      className="text-[11px] text-neutral-400 font-mono group-hover:text-neutral-700 transition-colors"
                      title={file.metadata.hash}
                    >
                      {file.metadata.hash.slice(0, 8)}...
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
