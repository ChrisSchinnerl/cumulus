/**
 * Sia stream Service Worker.
 *
 * Intercepts requests to `/_sia-stream/<streamId>` and answers them with a
 * 206 Partial Content response. The actual byte fetching happens on the main
 * thread (only it can talk to the Sia WASM SDK) — we use MessageChannel to
 * round-trip a single request → response per Range header.
 */
const STREAM_PREFIX = '/_sia-stream/'
const REQUEST_TIMEOUT_MS = 60000

const log = (...args) => console.log('[sia-sw]', ...args)
const warn = (...args) => console.warn('[sia-sw]', ...args)

self.addEventListener('install', () => {
  log('install — skipWaiting')
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  log('activate — claiming clients')
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!url.pathname.startsWith(STREAM_PREFIX)) return
  event.respondWith(handleStreamRequest(event))
})

async function handleStreamRequest(event) {
  const reqId = Math.random().toString(36).slice(2, 8)
  const url = new URL(event.request.url)
  const streamId = url.pathname.slice(STREAM_PREFIX.length)
  const rangeHeader = event.request.headers.get('range')
  const range = rangeHeader ? parseRange(rangeHeader) : null
  const t0 = performance.now()

  log(
    `[${reqId}] fetch streamId=${streamId.slice(0, 8)}… range=${rangeHeader || '(none)'} method=${event.request.method}`,
  )

  let client = await self.clients.get(event.clientId)
  if (!client) {
    log(`[${reqId}] no event.clientId match, falling back to first window client`)
    const all = await self.clients.matchAll({ type: 'window' })
    client = all[0]
  }
  if (!client) {
    warn(`[${reqId}] no client available, returning 503`)
    return new Response('No client available', { status: 503 })
  }
  log(`[${reqId}] dispatching to client ${client.id?.slice(0, 8) ?? '?'}`)

  const channel = new MessageChannel()
  const reply = new Promise((resolve, reject) => {
    channel.port1.onmessage = (e) => {
      if (e.data?.error) reject(new Error(e.data.error))
      else resolve(e.data)
    }
    setTimeout(
      () =>
        reject(
          new Error(`SW outer timeout after ${REQUEST_TIMEOUT_MS}ms`),
        ),
      REQUEST_TIMEOUT_MS,
    )
  })

  client.postMessage(
    { type: 'sia-stream-request', streamId, range },
    [channel.port2],
  )

  try {
    const { bytes, start, end, total, mimeType } = await reply
    const elapsed = Math.round(performance.now() - t0)
    log(
      `[${reqId}] reply ${start}-${end}/${total} (${bytes.byteLength}b, ${elapsed}ms) → 206`,
    )
    return new Response(bytes, {
      status: 206,
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(bytes.byteLength),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    const elapsed = Math.round(performance.now() - t0)
    warn(`[${reqId}] error after ${elapsed}ms:`, e?.message ?? e)
    return new Response(`Stream error: ${e?.message ?? e}`, { status: 500 })
  }
}

/**
 * Parse an HTTP Range header for a single byte range. Returns `{ start, end }`
 * where either may be `null` to mean "open" (the main thread resolves against
 * total size). Returns `null` for unsupported formats (multi-range etc.).
 */
function parseRange(header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const start = match[1] === '' ? null : parseInt(match[1], 10)
  const end = match[2] === '' ? null : parseInt(match[2], 10)
  if (start === null && end === null) return null
  return { start, end }
}
