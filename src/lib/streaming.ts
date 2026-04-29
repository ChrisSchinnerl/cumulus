import type { PinnedObject, Sdk } from '@siafoundation/sia-storage'
import { useAuthStore } from '../stores/auth'

/** URL the Service Worker is served from (matches `public/sia-stream-sw.js`). */
const SW_URL = '/sia-stream-sw.js'

/** Path prefix under which the SW intercepts requests. Must match the SW. */
const STREAM_PREFIX = '/_sia-stream/'

const log = (...args: unknown[]) => console.log('[sia-stream]', ...args)
const warn = (...args: unknown[]) => console.warn('[sia-stream]', ...args)

/** Per-stream state held on the main thread. */
type StreamEntry = {
  shareUrl: string
  /**
   * Resolved {@link PinnedObject}. Cached for the lifetime of the stream so
   * we don't pay `sharedObject(url)` cost on every Range request.
   */
  object: PinnedObject
  size: number
  mimeType: string
}

/**
 * HMR-safe shared state. Vite re-evaluates this module on every save, which
 * would otherwise leave a stale `message` listener attached to the SW with a
 * captured-but-empty `streams` Map — that stale listener races the new one
 * and replies "stream not registered" to every range request. Pinning the
 * Map and the handler reference to `globalThis` makes them survive module
 * reloads.
 */
type SharedState = {
  streams: Map<string, StreamEntry>
  handler: ((e: MessageEvent) => void) | null
}
const globalScope = globalThis as typeof globalThis & {
  __siaStreaming?: SharedState
}
if (!globalScope.__siaStreaming) {
  globalScope.__siaStreaming = { streams: new Map(), handler: null }
}
const shared = globalScope.__siaStreaming
const streams = shared.streams

let bridgeReady: Promise<void> | null = null

/**
 * Register the streaming Service Worker and attach the main-thread message
 * handler that answers byte-range requests. Idempotent — call on app boot.
 */
export async function initStreaming(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('Service Worker API not available')
  }
  if (!bridgeReady) {
    bridgeReady = (async () => {
      log('registering Service Worker at', SW_URL)
      await navigator.serviceWorker.register(SW_URL, { scope: '/' })
      await navigator.serviceWorker.ready
      log(
        'Service Worker ready, controller =',
        navigator.serviceWorker.controller
          ? 'present'
          : 'NULL (page not yet controlled — may need reload)',
      )
      // Detach any prior handler from a previous module instance (HMR) before
      // attaching this one — otherwise stale handlers race for the same
      // postMessage and the loser's reply is dropped.
      if (shared.handler) {
        navigator.serviceWorker.removeEventListener('message', shared.handler)
      }
      shared.handler = handleSwMessage
      navigator.serviceWorker.addEventListener('message', handleSwMessage)
    })()
  }
  return bridgeReady
}

/**
 * Register a Sia object as a streamable source. Resolves the
 * {@link PinnedObject} once and stashes it; returns a URL the browser can use
 * directly as a `<video src=...>`. Call {@link unregisterStream} when the
 * player closes to free memory.
 */
export async function registerStream(
  shareUrl: string,
  mimeType: string,
): Promise<{ streamId: string; streamUrl: string; size: number }> {
  const sdk = useAuthStore.getState().sdk
  if (!sdk) throw new Error('Sia SDK not ready')

  await initStreaming()

  log('registerStream — resolving sharedObject for', shareUrl.slice(0, 60))
  const t0 = performance.now()
  const object = await sdk.sharedObject(shareUrl)
  const size = Number(object.size())
  const streamId = crypto.randomUUID()
  streams.set(streamId, { shareUrl, object, size, mimeType })
  log(
    `registerStream — id=${streamId.slice(0, 8)}… size=${size}b mime=${mimeType} resolved in ${Math.round(performance.now() - t0)}ms`,
  )

  return {
    streamId,
    streamUrl: `${STREAM_PREFIX}${streamId}`,
    size,
  }
}

/** Drop a previously-registered stream; safe to call with unknown ids. */
export function unregisterStream(streamId: string): void {
  streams.delete(streamId)
}

type ParsedRange = { start: number | null; end: number | null }

type StreamRequestMessage = {
  type: 'sia-stream-request'
  streamId: string
  range: ParsedRange | null
}

function handleSwMessage(event: MessageEvent): void {
  const data = event.data as StreamRequestMessage | undefined
  if (!data || data.type !== 'sia-stream-request') return
  const port = event.ports[0]
  if (!port) return

  const reqTag = `[${data.streamId.slice(0, 8)}…/${data.range?.start ?? '∅'}-${data.range?.end ?? '∅'}]`
  log(
    `${reqTag} SW request: range start=${data.range?.start ?? '(open)'} end=${data.range?.end ?? '(open)'}`,
  )

  const entry = streams.get(data.streamId)
  if (!entry) {
    warn(`${reqTag} stream not registered`)
    port.postMessage({ error: `Stream ${data.streamId} not registered` })
    return
  }

  const sdk = useAuthStore.getState().sdk
  if (!sdk) {
    warn(`${reqTag} SDK not ready`)
    port.postMessage({ error: 'Sia SDK not ready' })
    return
  }

  const resolved = resolveRange(data.range, entry.size)
  if (!resolved) {
    warn(`${reqTag} invalid range against size=${entry.size}`)
    port.postMessage({ error: 'Invalid range' })
    return
  }
  const { start, end } = resolved
  const length = end - start + 1
  log(
    `${reqTag} resolved → fetching bytes ${start}-${end} (${length}b, total=${entry.size})`,
  )

  const t0 = performance.now()
  fetchRange(sdk, entry.object, start, length).then(
    (bytes) => {
      log(
        `${reqTag} got ${bytes.byteLength}b in ${Math.round(performance.now() - t0)}ms`,
      )
      port.postMessage(
        {
          bytes: bytes.buffer,
          start,
          end,
          total: entry.size,
          mimeType: entry.mimeType,
        },
        [bytes.buffer],
      )
    },
    (e) => {
      warn(
        `${reqTag} fetchRange failed after ${Math.round(performance.now() - t0)}ms:`,
        e instanceof Error ? e.message : e,
      )
      port.postMessage({
        error: e instanceof Error ? e.message : String(e),
      })
    },
  )
}

/**
 * Cap on bytes returned per Range response. Open-ended ranges
 * (`bytes=N-`, common from `<video>` elements) are clamped to this size so
 * we never try to pull a multi-hundred-MB file in a single download —
 * which would open hundreds of concurrent WebTransport sessions per shard
 * and trip the browser's per-origin 64-pending-session cap. The browser
 * sees Content-Range telling it more bytes exist and issues follow-up
 * ranges as the player buffers.
 */
const RANGE_RESPONSE_CAP_BYTES = 4 * 1024 * 1024

/**
 * Resolve a parsed Range against the total file size, applying the three
 * RFC 7233 forms (`N-M`, `N-`, `-N`). Clamps the upper bound to the last
 * byte AND to {@link RANGE_RESPONSE_CAP_BYTES} from the start. Returns
 * `null` if the resulting range is unsatisfiable.
 */
function resolveRange(
  range: ParsedRange | null,
  total: number,
): { start: number; end: number } | null {
  let start: number
  let end: number
  if (!range) {
    start = 0
    end = total - 1
  } else if (range.start === null && range.end !== null) {
    start = Math.max(0, total - range.end)
    end = total - 1
  } else if (range.start !== null && range.end === null) {
    start = range.start
    end = total - 1
  } else if (range.start !== null && range.end !== null) {
    start = range.start
    end = Math.min(total - 1, range.end)
  } else {
    return null
  }
  if (start < 0 || start > end || start >= total) return null
  // Clamp to the cap. Browser will request more if needed.
  end = Math.min(end, start + RANGE_RESPONSE_CAP_BYTES - 1)
  return { start, end }
}

/**
 * Hard deadline for a single Range fetch. If hosts can't deliver in this
 * time the underlying transport is almost certainly stuck (e.g. blocked
 * UDP for QUIC), and we want to surface the failure instead of spinning.
 */
const RANGE_TIMEOUT_MS = 30000

/**
 * Concurrent shard fetches per Range. Kept low so a video player issuing
 * many Range requests doesn't blow through the browser's per-origin
 * WebTransport session cap (Chromium = 64 pending).
 */
const RANGE_MAX_INFLIGHT = 4

/** Pull `[offset, offset+length)` from Sia and concat into a single buffer. */
async function fetchRange(
  sdk: Sdk,
  object: PinnedObject,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  // The WASM SDK's actual download options take plain `number`s for
  // offset/length even though the node-flavored .d.ts declares `bigint` —
  // the browser export resolves to wasm types where these are numbers.
  // Passing bigints made the SDK silently ignore length and stream the
  // whole file from offset, which times out for large objects.
  const stream = sdk.download(object, {
    offset,
    length,
    maxInflight: RANGE_MAX_INFLIGHT,
  } as unknown as Parameters<typeof sdk.download>[1])
  const reader = stream.getReader()

  const drain = async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
    const out = new Uint8Array(total)
    let p = 0
    for (const c of chunks) {
      out.set(c, p)
      p += c.length
    }
    return out
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel('range fetch timeout').catch(() => undefined)
      reject(
        new Error(
          `Range ${offset}-${offset + length - 1} timed out after ${RANGE_TIMEOUT_MS}ms`,
        ),
      )
    }, RANGE_TIMEOUT_MS)
    drain().then(
      (bytes) => {
        clearTimeout(timer)
        resolve(bytes)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
