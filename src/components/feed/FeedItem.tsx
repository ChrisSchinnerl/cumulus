import { AtUri } from "@atproto/api";
import { useEffect, useState } from "react";
import { getProfileByDid } from "../../lib/atproto";
import { registerStream, unregisterStream } from "../../lib/streaming";
import { useAuthStore } from "../../stores/auth";

/** File extensions we treat as video when the stored MIME type is missing or generic. */
const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".m4v",
  ".avi",
  ".mpg",
  ".mpeg",
  ".ogv",
  ".wmv",
  ".flv",
  ".3gp",
];

/**
 * True if the file is a video, based on MIME type or filename extension.
 * Falls back to extension matching because `application/octet-stream` records
 * (uploaded when the browser couldn't infer a MIME) still need to render with
 * the video affordance.
 */
function isVideoFile(name: string, mimeType: string): boolean {
  if (mimeType.startsWith("video/")) return true;
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Format a byte count as a short human-readable string (e.g. "1.2 MB"). */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

/** Format an ISO date as a short relative-ish string (e.g. "2h ago", "3d ago"). */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const ms = Date.now() - then;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

export type FeedItemProps = {
  /** The author's handle (e.g. `alice.bsky.social`) — shown in the byline. */
  handle: string;
  /** Optional display name; falls back to handle when absent. */
  displayName?: string | null;
  /** Optional avatar URL fetched from the bsky AppView. */
  avatar?: string | null;
  /** Original file name for download. */
  name: string;
  mimeType: string;
  size: number;
  /** ISO datetime when the share was published. */
  createdAt: string;
  /** Sia share URL — opaque pointer fed into `sdk.sharedObject(...)`. */
  shareUrl: string;
  /** DID of the user whose repo this post lives in (the poster). */
  posterDid: string;
  /**
   * `at://` URI of the original post this is a save of, if any. When the
   * URI's DID differs from {@link posterDid}, the byline shows an
   * "originally posted by @handle" attribution line.
   */
  sourceUri?: string;
  /**
   * Optional inline preview (JPEG `data:` URL). Rendered above the metadata
   * row when present — typically only for image uploads.
   */
  thumbnail?: string | null;
  /**
   * Optional delete callback. When provided, a Delete button is rendered
   * alongside Download. The parent owns the actual deletion (atproto record
   * + Sia object) and is expected to remove this item from its list.
   */
  onDelete?: () => Promise<void>;
  /**
   * Optional repin callback. When provided, a green Save button is rendered.
   * Mutually exclusive with `onDelete` in practice — once a post is saved,
   * the parent flips this off and provides `onDelete` instead so the user
   * can undo the save.
   */
  onSave?: () => Promise<void>;
};

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
  posterDid,
  sourceUri,
  thumbnail,
  onDelete,
  onSave,
}: FeedItemProps) {
  const sdk = useAuthStore((s) => s.sdk);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const isVideo = isVideoFile(name, mimeType);
  const isImage = mimeType.startsWith("image/");
  const [viewing, setViewing] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [originalAuthor, setOriginalAuthor] = useState<{
    handle: string;
  } | null>(null);

  useEffect(() => {
    if (!sourceUri) {
      setOriginalAuthor(null);
      return;
    }
    let sourceDid: string;
    try {
      sourceDid = new AtUri(sourceUri).host;
    } catch {
      setOriginalAuthor(null);
      return;
    }
    if (sourceDid === posterDid) {
      setOriginalAuthor(null);
      return;
    }
    let cancelled = false;
    getProfileByDid(sourceDid).then((p) => {
      if (cancelled) return;
      setOriginalAuthor(p ? { handle: p.handle } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceUri, posterDid]);

  useEffect(() => {
    return () => {
      if (streamId) unregisterStream(streamId);
    };
  }, [streamId]);

  // Revoke any held image blob URL on unmount so memory doesn't leak when a
  // user scrolls away with the lightbox closed via component teardown.
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  // ESC closes the open lightbox.
  useEffect(() => {
    if (!viewing) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") closeImageView();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // closeImageView is intentionally omitted — it's stable enough for this
    // narrow case and including it would re-bind the listener every render.
  }, [viewing]);

  function closeImageView() {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null);
    setViewing(false);
    setImageError(null);
  }

  /**
   * Open the full-size image lightbox. Streams the original image bytes from
   * Sia into a Blob, then sets that as the displayed source. Spinner shows
   * while downloading; errors land inside the overlay.
   */
  async function handleViewImage() {
    if (!sdk || viewing) return;
    setViewing(true);
    setImageLoading(true);
    setImageError(null);
    try {
      const object = await sdk.sharedObject(shareUrl);
      const stream = sdk.download(object, { maxInflight: 10 });
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const blob = new Blob(chunks as BlobPart[], { type: mimeType });
      setImageUrl(URL.createObjectURL(blob));
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "Failed to load image");
    } finally {
      setImageLoading(false);
    }
  }

  async function handlePlay() {
    if (opening || streamUrl) return;
    setOpening(true);
    setError(null);
    try {
      const reg = await registerStream(shareUrl, mimeType);
      setStreamId(reg.streamId);
      setStreamUrl(reg.streamUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stream failed");
    } finally {
      setOpening(false);
    }
  }

  function handleStop() {
    if (streamId) unregisterStream(streamId);
    setStreamId(null);
    setStreamUrl(null);
  }

  async function handleDownload() {
    if (!sdk) return;
    setDownloading(true);
    setError(null);
    setProgress({ done: 0, total: size });
    try {
      const object = await sdk.sharedObject(shareUrl);
      const stream = sdk.download(object, { maxInflight: 10 });
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let done = 0;
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        chunks.push(value);
        done += value.length;
        setProgress({ done, total: size });
      }
      const blob = new Blob(chunks as BlobPart[], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  }

  async function handleDelete() {
    if (!onDelete || deleting) return;
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setDeleting(false);
      setError(e instanceof Error ? e.message : "Delete failed");
    }
    // On success, the parent removes this row from its list, so we don't
    // bother resetting `deleting` — the component unmounts.
  }

  async function handleSave() {
    if (!onSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
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
          <a
            href={`#/profile/${encodeURIComponent(handle)}`}
            className="font-medium text-neutral-900 hover:underline truncate"
          >
            {displayName || handle}
          </a>
          <a
            href={`#/profile/${encodeURIComponent(handle)}`}
            className="text-neutral-500 hover:text-neutral-900 hover:underline truncate"
          >
            @{handle}
          </a>
          <span className="text-neutral-400 text-xs shrink-0">
            · {formatRelative(createdAt)}
          </span>
        </div>
        {originalAuthor && (
          <p className="text-xs text-neutral-500 mt-0.5">
            originally posted by{" "}
            <a
              href={`#/profile/${encodeURIComponent(originalAuthor.handle)}`}
              className="hover:text-neutral-900 hover:underline"
            >
              @{originalAuthor.handle}
            </a>
          </p>
        )}
        {streamUrl ? (
          <div className="mt-2 space-y-1">
            {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded clip, no captions to attach */}
            <video
              src={streamUrl}
              controls
              autoPlay
              playsInline
              className="block max-h-96 max-w-full rounded-lg bg-black"
            />
            <button
              type="button"
              onClick={handleStop}
              className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors"
            >
              Close player
            </button>
          </div>
        ) : isVideo ? (
          <button
            type="button"
            onClick={handlePlay}
            disabled={opening}
            className="relative mt-2 block rounded-lg overflow-hidden border border-neutral-200/80 bg-neutral-50 max-w-full p-0 disabled:opacity-70"
            aria-label={`Play ${name}`}
          >
            {thumbnail ? (
              <img
                src={thumbnail}
                alt={`Preview of ${name}`}
                className="block max-h-60 max-w-full"
              />
            ) : (
              <div className="block w-80 max-w-full aspect-video bg-black" />
            )}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/20">
              {opening ? (
                <svg
                  className="w-10 h-10 animate-spin text-white drop-shadow-md"
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
                  className="w-12 h-12 text-white drop-shadow-md"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </div>
          </button>
        ) : (
          thumbnail &&
          (isImage ? (
            <button
              type="button"
              onClick={handleViewImage}
              className="relative mt-2 block rounded-lg overflow-hidden border border-neutral-200/80 bg-neutral-50 max-w-full p-0 hover:opacity-90 transition-opacity"
              aria-label={`View ${name}`}
            >
              <img
                src={thumbnail}
                alt={`Preview of ${name}`}
                className="block max-h-60 max-w-full"
              />
            </button>
          ) : (
            <div className="relative mt-2 rounded-lg overflow-hidden border border-neutral-200/80 bg-neutral-50 inline-block max-w-full">
              <img
                src={thumbnail}
                alt={`Preview of ${name}`}
                className="block max-h-60 max-w-full"
              />
            </div>
          ))
        )}
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-neutral-900 truncate">{name}</p>
            <p className="text-xs text-neutral-500 mt-0.5">
              {formatBytes(size)}
              {mimeType !== "application/octet-stream" && (
                <span> · {mimeType}</span>
              )}
              {progress && (
                <span>
                  {" "}
                  · {formatBytes(progress.done)} / {formatBytes(progress.total)}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading || deleting || saving}
              className="text-xs px-3 py-1.5 border border-neutral-300 rounded-lg hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              {downloading ? "Downloading..." : "Download"}
            </button>
            {onSave && (
              <button
                type="button"
                onClick={handleSave}
                disabled={downloading || saving}
                className="text-xs px-3 py-1.5 border border-green-200 text-green-700 rounded-lg hover:bg-green-50 disabled:opacity-40 disabled:cursor-default transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={downloading || deleting || saving}
                className="text-xs px-3 py-1.5 border border-red-200 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-40 disabled:cursor-default transition-colors"
              >
                {deleting ? "Deleting..." : "Delete"}
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
    {viewing && (
      // biome-ignore lint/a11y/useKeyWithClickEvents: ESC handled via window listener; click-outside-to-dismiss is the dialog idiom
      <div
        onClick={closeImageView}
        className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4"
      >
        {imageLoading && !imageUrl && (
          <svg
            className="w-12 h-12 animate-spin text-white drop-shadow-md"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 019.17 6" />
          </svg>
        )}
        {imageError && (
          <p className="text-white text-sm bg-red-900/40 border border-red-500/40 rounded-lg px-4 py-2.5">
            {imageError}
          </p>
        )}
        {imageUrl && (
          <img
            src={imageUrl}
            alt={name}
            onClick={(ev) => ev.stopPropagation()}
            className="max-w-full max-h-full object-contain"
          />
        )}
        <button
          type="button"
          onClick={closeImageView}
          aria-label="Close"
          className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl leading-none"
        >
          ×
        </button>
      </div>
    )}
    </>
  );
}
