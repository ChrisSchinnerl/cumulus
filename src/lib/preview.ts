/**
 * Maximum dimension (width or height in px) for generated thumbnails.
 * Tuned so a JPEG-encoded preview comfortably fits in a single atproto
 * record without bloating the listRecords payload.
 */
const THUMBNAIL_MAX_DIM = 320

/** JPEG quality for generated thumbnails (0..1). */
const THUMBNAIL_QUALITY = 0.72

/** Hard cap on the resulting data URL length. Anything bigger gets dropped. */
const THUMBNAIL_MAX_BYTES = 80 * 1024

/**
 * Per-step timeout for video preview extraction (metadata load, seek). Bounds
 * the worst case if the browser can't decode the file or the file's headers
 * are at the end (slow `loadedmetadata`).
 */
const VIDEO_PREVIEW_TIMEOUT_MS = 6000

/**
 * Generate a small JPEG preview as a `data:` URL for an image or video file.
 * Returns `null` for unsupported MIME types, files the browser can't decode,
 * or thumbnails that end up too large after encoding (preserves the cap on
 * record size).
 *
 * Runs entirely client-side via canvas; no upload or external service.
 */
export async function generateThumbnail(file: File): Promise<string | null> {
  if (file.type.startsWith('image/')) return generateImageThumbnail(file)
  if (file.type.startsWith('video/')) return generateVideoThumbnail(file)
  return null
}

async function generateImageThumbnail(file: File): Promise<string | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  try {
    return drawAndEncode(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

/**
 * Pull a single poster frame out of a video. Loads just enough of the file
 * to decode the first frame, paints it to a canvas, and JPEG-encodes the
 * result. Returns `null` if the browser can't decode the codec or any step
 * times out.
 */
async function generateVideoThumbnail(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  video.src = url

  try {
    await waitForEvent(video, 'loadedmetadata', VIDEO_PREVIEW_TIMEOUT_MS)

    // Seek slightly past 0 so we don't grab a black/loading frame. Clamp to
    // 10% of the duration for very short clips.
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const seekTime = Math.min(0.1, Math.max(0, duration / 10 || 0.1))

    const seeked = waitForEvent(video, 'seeked', VIDEO_PREVIEW_TIMEOUT_MS)
    video.currentTime = seekTime
    await seeked

    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null
    return drawAndEncode(video, w, h)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
    video.removeAttribute('src')
    video.load()
  }
}

/**
 * Resize `source` (image or video element) to fit within
 * {@link THUMBNAIL_MAX_DIM}, paint it to a 2D canvas, and JPEG-encode the
 * result. Returns `null` if the canvas is unavailable or the encoded
 * thumbnail exceeds {@link THUMBNAIL_MAX_BYTES}.
 */
function drawAndEncode(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): string | null {
  const ratio = Math.min(
    THUMBNAIL_MAX_DIM / sourceWidth,
    THUMBNAIL_MAX_DIM / sourceHeight,
    1,
  )
  const w = Math.max(1, Math.round(sourceWidth * ratio))
  const h = Math.max(1, Math.round(sourceHeight * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, w, h)

  const dataUrl = canvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY)
  if (dataUrl.length > THUMBNAIL_MAX_BYTES) return null
  return dataUrl
}

/**
 * Resolve when `target` fires `eventName`, reject on `error` or after
 * `timeoutMs`. Cleans up listeners on settle.
 */
function waitForEvent(
  target: EventTarget,
  eventName: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent)
      target.removeEventListener('error', onError)
      clearTimeout(timer)
    }
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(`media error before ${eventName}`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timeout waiting for ${eventName}`))
    }, timeoutMs)
    target.addEventListener(eventName, onEvent, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}
