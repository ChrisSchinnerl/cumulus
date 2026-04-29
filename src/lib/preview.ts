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
 * Generate a small JPEG preview as a `data:` URL for image files. Returns
 * `null` for non-images, files the browser can't decode, or thumbnails that
 * end up too large after encoding (preserves the cap on record size).
 *
 * Runs entirely client-side via {@link createImageBitmap} + a 2D canvas; no
 * upload or external service is involved.
 */
export async function generateImageThumbnail(
  file: File,
): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  try {
    const ratio = Math.min(
      THUMBNAIL_MAX_DIM / bitmap.width,
      THUMBNAIL_MAX_DIM / bitmap.height,
      1,
    )
    const w = Math.max(1, Math.round(bitmap.width * ratio))
    const h = Math.max(1, Math.round(bitmap.height * ratio))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)

    const dataUrl = canvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY)
    if (dataUrl.length > THUMBNAIL_MAX_BYTES) return null
    return dataUrl
  } finally {
    bitmap.close()
  }
}
