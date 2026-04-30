import { encodedSize, type ShardProgress } from "@siafoundation/sia-storage";
import { useEffect, useRef, useState } from "react";
import { SHARE_VALID_UNTIL, writeSharePost } from "../../lib/atproto";
import { APP_KEY, DATA_SHARDS, PARITY_SHARDS } from "../../lib/constants";
import { expandDataTransferToFiles } from "../../lib/dropzone";
import type { Tags } from "../../lib/lexicons";
import { generateThumbnail } from "../../lib/preview";
import { autoTagsFromFile } from "../../lib/tags";
import { useAtprotoStore } from "../../stores/atproto";
import { useAuthStore } from "../../stores/auth";
import { DevNote } from "../DevNote";

type UploadProgress = {
  /** Display label — file name for single uploads, "N files" for batches. */
  label: string;
  totalBytes: number;
  shardsDone: number;
  bytesUploaded: number;
  encodedTotal: number;
  /** Number of files in the batch (≥1). */
  fileCount: number;
  /** Pinning/record-write phase counter (0..fileCount). Set after slabs upload completes. */
  finalizedCount: number;
};

/** A staged file in the review dialog: file ref + per-file editable tags. */
type StagedFile = {
  file: File;
  /** Editable list of (key, value) pairs. Same key may appear twice for multi-value tagging. */
  tags: Array<{ key: string; value: string }>;
  /** Whether the per-file tag editor is folded open. */
  expanded: boolean;
};

/** Format a byte count as a short human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

const isPlaceholderKey = APP_KEY.startsWith("{" + "{");

/** Per-file pre-processing output: hash + optional preview. */
type PreparedFile = {
  file: File;
  hash: string;
  thumbnail: string | null;
};

/**
 * Compose-only dropzone with a review step. Drop file(s) or a folder → opens
 * a dialog listing every file with its size and a foldable tag editor; user
 * adjusts tags then confirms. Confirmed batch goes through one packed Sia
 * upload (amortizing erasure-coding overhead across small files), and one
 * `app.cumulus.share.post` record per file is written. Live-update of the
 * feed after upload is handled by the Feed component's own Jetstream
 * subscription, so we don't need a callback here.
 */
export function UploadZone() {
  const sdk = useAuthStore((s) => s.sdk);
  const agent = useAtprotoStore((s) => s.agent);
  const [uploading, setUploading] = useState(false);
  const [activeUpload, setActiveUpload] = useState<UploadProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedFile[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  /**
   * Stage a list of dropped/picked files into the review dialog. Files start
   * with empty tag editors — auto-tagging is opt-in via the magic-wand
   * button in the dialog so the user always controls what gets attached.
   */
  function stage(files: File[]) {
    if (files.length === 0) return;
    const items: StagedFile[] = files.map((file) => ({
      file,
      tags: [],
      expanded: false,
    }));
    setStaged(items);
  }

  /**
   * Bulk-set a tag across every staged file. Replaces any existing pairs
   * with the same key — call this with `genre: action` and every file
   * ends up with exactly that one genre, regardless of what they had
   * before. To preserve multi-value, type the comma list yourself
   * (`genre: action, drama`).
   */
  function applyBulkTag(key: string, value: string) {
    const k = key.trim().toLowerCase();
    const v = value.trim();
    if (!k || !v) return;
    setStaged((prev) => {
      if (!prev) return prev;
      return prev.map((sf) => {
        const filtered = sf.tags.filter(
          (p) => p.key.trim().toLowerCase() !== k,
        );
        return {
          ...sf,
          tags: [...filtered, { key: k, value: v }],
          expanded: true,
        };
      });
    });
  }

  /**
   * Bulk-remove every pair with the given key from every staged file. The
   * dialog's "remove" picker lists the union of keys across all files —
   * picking `genre` clears all genre tags from the batch regardless of
   * each file's specific value.
   */
  function removeBulkTag(key: string) {
    const k = key.trim().toLowerCase();
    if (!k) return;
    setStaged((prev) => {
      if (!prev) return prev;
      return prev.map((sf) => ({
        ...sf,
        tags: sf.tags.filter((p) => p.key.trim().toLowerCase() !== k),
      }));
    });
  }

  /**
   * Recompute auto-detected tags for every staged file and overwrite the
   * inferred keys with fresh values. User-added keys outside the auto-tag
   * set (e.g. `genre`, `mood`, custom tags) are preserved as-is — only the
   * keys auto-tagging actually produces get replaced. All files get
   * auto-expanded so the user can verify what landed.
   */
  function applyAutoTags() {
    setStaged((prev) => {
      if (!prev) return prev;
      return prev.map((sf) => {
        const auto = autoTagsFromFile(sf.file.name, sf.file.type);
        const autoKeys = new Set(
          Object.keys(auto).map((k) => k.toLowerCase()),
        );
        const preserved = sf.tags.filter(
          (p) => !autoKeys.has(p.key.trim().toLowerCase()),
        );
        const additions = Object.entries(auto).map(([key, value]) => ({
          key,
          value,
        }));
        return {
          ...sf,
          tags: [...preserved, ...additions],
          expanded: true,
        };
      });
    });
  }

  /** Esc closes the review dialog. */
  useEffect(() => {
    if (!staged) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setStaged(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [staged]);

  function toggleExpand(idx: number) {
    setStaged((prev) =>
      prev
        ? prev.map((sf, i) =>
            i === idx ? { ...sf, expanded: !sf.expanded } : sf,
          )
        : prev,
    );
  }

  /**
   * Update a tag row. If the row is the trailing "always-blank" row and the
   * user has typed anything, promote it into a real tag (which causes a
   * fresh trailing row to appear on next render).
   */
  function updateTagRow(
    fileIdx: number,
    tagIdx: number,
    next: { key: string; value: string },
  ) {
    setStaged((prev) => {
      if (!prev) return prev;
      const out = prev.slice();
      const sf = out[fileIdx];
      const isTrailing = tagIdx === sf.tags.length;
      if (isTrailing) {
        if (next.key.length === 0 && next.value.length === 0) return prev;
        out[fileIdx] = { ...sf, tags: [...sf.tags, next] };
      } else {
        const newTags = sf.tags.slice();
        newTags[tagIdx] = next;
        out[fileIdx] = { ...sf, tags: newTags };
      }
      return out;
    });
  }

  function removeTagRow(fileIdx: number, tagIdx: number) {
    setStaged((prev) => {
      if (!prev) return prev;
      const out = prev.slice();
      const sf = out[fileIdx];
      out[fileIdx] = {
        ...sf,
        tags: sf.tags.filter((_, i) => i !== tagIdx),
      };
      return out;
    });
  }

  /** Collapse a per-file tag list into the storage-format Tags object. */
  function pairsToTags(
    pairs: Array<{ key: string; value: string }>,
  ): Tags | undefined {
    const out: Tags = {};
    for (const { key, value } of pairs) {
      const k = key.trim().toLowerCase();
      const v = value.trim();
      if (!k || !v) continue;
      out[k] = out[k] ? `${out[k]}, ${v}` : v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * Read each file in turn, computing SHA-256 + (for images) a JPEG preview.
   * Sequential rather than parallel to bound peak memory at one file at a time.
   */
  async function prepareFiles(files: File[]): Promise<PreparedFile[]> {
    const prepared: PreparedFile[] = [];
    for (const file of files) {
      const hashBuffer = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const hash = new Uint8Array(hashBuffer).toHex();
      const thumbnail = await generateThumbnail(file).catch(() => null);
      prepared.push({ file, hash, thumbnail });
    }
    return prepared;
  }

  async function uploadStaged(items: StagedFile[]) {
    if (!sdk || !agent || items.length === 0) return;
    setUploading(true);
    setError(null);
    setStaged(null);

    const totalBytes = items.reduce((acc, sf) => acc + sf.file.size, 0);
    const encodedTotal = Number(
      encodedSize(totalBytes, DATA_SHARDS, PARITY_SHARDS),
    );
    setActiveUpload({
      label: items.length === 1 ? items[0].file.name : `${items.length} files`,
      totalBytes,
      shardsDone: 0,
      bytesUploaded: 0,
      encodedTotal,
      fileCount: items.length,
      finalizedCount: 0,
    });

    try {
      const prepared = await prepareFiles(items.map((sf) => sf.file));

      let shardsDone = 0;
      let bytesUploaded = 0;
      const packed = sdk.uploadPacked({
        maxInflight: 10,
        dataShards: DATA_SHARDS,
        parityShards: PARITY_SHARDS,
        onShardUploaded: (progress: ShardProgress) => {
          shardsDone++;
          bytesUploaded += progress.shardSize;
          setActiveUpload((prev) =>
            prev ? { ...prev, shardsDone, bytesUploaded } : prev,
          );
        },
      });

      try {
        for (const p of prepared) {
          await packed.add(p.file.stream());
        }
        const objects = await packed.finalize();

        for (let i = 0; i < objects.length; i++) {
          const obj = objects[i];
          const p = prepared[i];
          const item = items[i];
          const meta = {
            name: p.file.name,
            type: p.file.type || "application/octet-stream",
            size: p.file.size,
            hash: p.hash,
            createdAt: Date.now(),
          };
          obj.updateMetadata(new TextEncoder().encode(JSON.stringify(meta)));
          await sdk.pinObject(obj);
          await sdk.updateObjectMetadata(obj);

          const shareUrl = sdk.shareObject(obj, SHARE_VALID_UNTIL);
          const tags = pairsToTags(item.tags);
          await writeSharePost(agent, {
            shareUrl,
            siaKey: obj.id(),
            name: meta.name,
            mimeType: meta.type,
            size: meta.size,
            createdAt: new Date(meta.createdAt).toISOString(),
            ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}),
            ...(tags ? { tags } : {}),
          });

          setActiveUpload((prev) =>
            prev ? { ...prev, finalizedCount: i + 1 } : prev,
          );
        }
      } catch (e) {
        try {
          packed.cancel();
        } catch {
          // ignore — primary error is what we'll surface
        }
        throw e;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      setActiveUpload(null);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = await expandDataTransferToFiles(e.dataTransfer);
    stage(files);
  }

  function handlePicked(fileList: FileList) {
    stage(Array.from(fileList));
  }

  const uploadPercent = activeUpload
    ? Math.min(
        100,
        Math.round(
          (activeUpload.bytesUploaded / activeUpload.encodedTotal) * 100,
        ),
      )
    : 0;

  return (
    <div className="space-y-4">
      {isPlaceholderKey && (
        <DevNote title="Replace Your App Key">
          <p>
            You&apos;re using the template placeholder. Set your own key in{" "}
            <code className="text-amber-700">src/lib/constants.ts</code> or
            scaffold a fresh project with{" "}
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
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        className={`relative block border-2 border-dashed rounded-xl p-10 text-center transition-all duration-150 ${
          uploading
            ? "border-neutral-300 cursor-default"
            : dragOver
              ? "border-green-600 bg-green-600/5 cursor-pointer"
              : "border-neutral-300 hover:border-neutral-400 cursor-pointer"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            if (e.target.files) handlePicked(e.target.files);
            e.target.value = "";
          }}
        />

        {activeUpload ? (
          <div className="space-y-3">
            <p className="text-neutral-700 text-sm">
              Uploading{" "}
              <span className="text-neutral-900">{activeUpload.label}</span>{" "}
              <span className="text-neutral-500">
                ({formatBytes(activeUpload.totalBytes)})
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
              {activeUpload.shardsDone} shards
              {activeUpload.fileCount > 1 && (
                <>
                  {" "}
                  · {activeUpload.finalizedCount}/{activeUpload.fileCount}{" "}
                  posted
                </>
              )}
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
              Drop files or a folder to share with your followers
            </p>
            <p className="text-neutral-500 text-xs">
              Each file becomes a separate post · Stored on Sia, shared on
              atproto
            </p>
          </div>
        )}
      </label>

      {!activeUpload && (
        <div className="text-center">
          <input
            ref={(el) => {
              folderInputRef.current = el;
              // `webkitdirectory` isn't in React's standard HTMLInputElement
              // attribute typings — set it imperatively.
              if (el) el.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              if (e.target.files) handlePicked(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            disabled={uploading}
            className="text-xs text-neutral-500 hover:text-neutral-900 underline disabled:opacity-40 transition-colors"
          >
            or choose a folder
          </button>
        </div>
      )}

      {staged && (
        <ReviewDialog
          staged={staged}
          onCancel={() => setStaged(null)}
          onConfirm={() => uploadStaged(staged)}
          onToggleExpand={toggleExpand}
          onUpdateTag={updateTagRow}
          onRemoveTag={removeTagRow}
          onAutoTag={applyAutoTags}
          onBulkTag={applyBulkTag}
          onBulkRemove={removeBulkTag}
        />
      )}
    </div>
  );
}

type ReviewDialogProps = {
  staged: StagedFile[];
  onCancel: () => void;
  onConfirm: () => void;
  onToggleExpand: (fileIdx: number) => void;
  onUpdateTag: (
    fileIdx: number,
    tagIdx: number,
    next: { key: string; value: string },
  ) => void;
  onRemoveTag: (fileIdx: number, tagIdx: number) => void;
  /** Apply auto-detected tags to every staged file (filename + MIME hints). */
  onAutoTag: () => void;
  /** Set `key=value` on every staged file, replacing any existing pairs with the same key. */
  onBulkTag: (key: string, value: string) => void;
  /** Remove every pair with the given key from every staged file that has it. */
  onBulkRemove: (key: string) => void;
};

/**
 * Pre-upload review modal. Lists every staged file with its size and a
 * foldable per-file tag editor. Header shows the batch size, the Sia-encoded
 * size, and the viewer's remaining indexer quota. Confirm kicks off the
 * actual upload.
 */
function ReviewDialog({
  staged,
  onCancel,
  onConfirm,
  onToggleExpand,
  onUpdateTag,
  onRemoveTag,
  onAutoTag,
  onBulkTag,
  onBulkRemove,
}: ReviewDialogProps) {
  const sdk = useAuthStore((s) => s.sdk);
  const totalBytes = staged.reduce((acc, sf) => acc + sf.file.size, 0);
  // What the indexer actually charges quota for: data shards + slab padding,
  // *without* the parity-shard redundancy multiplier. Derived from
  // `encodedSize` (which includes parity) by scaling back by data/(data+parity).
  const encodedTotal = Number(
    encodedSize(totalBytes, DATA_SHARDS, PARITY_SHARDS),
  );
  const siaSize = Math.round(
    (encodedTotal * DATA_SHARDS) / (DATA_SHARDS + PARITY_SHARDS),
  );
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!sdk) return;
    let cancelled = false;
    sdk
      .account()
      .then((a) => {
        if (!cancelled) setRemaining(Number(a.remainingStorage));
      })
      .catch(() => {
        // Best-effort — quota line is hidden if the lookup fails.
      });
    return () => {
      cancelled = true;
    };
  }, [sdk]);

  const wouldExceed = remaining !== null && siaSize > remaining;

  // Bulk-add tool state — typed key/value applied to every file on submit.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkKey, setBulkKey] = useState("");
  const [bulkValue, setBulkValue] = useState("");
  // Bulk-remove tool state — pick from the union of pairs across all files.
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removePicked, setRemovePicked] = useState("");

  /** Union of every distinct key across all staged files (alphabetized). */
  const allKeys = (() => {
    const seen = new Set<string>();
    for (const sf of staged) {
      for (const p of sf.tags) {
        const k = p.key.trim().toLowerCase();
        if (k) seen.add(k);
      }
    }
    return Array.from(seen).sort();
  })();

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: ESC handled via window listener; click-outside-to-dismiss is the dialog idiom
    <div
      onClick={onCancel}
      className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col"
        role="dialog"
        aria-label="Review upload"
      >
        <div className="px-6 py-4 border-b border-neutral-200/80">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-neutral-900">
              Review {staged.length} {staged.length === 1 ? "file" : "files"}
            </h2>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="text-neutral-400 hover:text-neutral-700 text-2xl leading-none"
            >
              ×
            </button>
          </div>
          <p className="text-xs text-neutral-500 mt-1">
            {formatBytes(totalBytes)} on disk ·{" "}
            <span className="text-neutral-700">{formatBytes(siaSize)}</span>{" "}
            on Sia
            {remaining !== null && (
              <>
                {" · "}
                <span
                  className={
                    wouldExceed
                      ? "text-red-700 font-medium"
                      : "text-neutral-700"
                  }
                >
                  {formatBytes(remaining)} remaining
                </span>
              </>
            )}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onAutoTag}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-neutral-300 rounded-lg hover:bg-neutral-50 text-neutral-700 transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
                <path d="M18.45 4.5l.038.123a3 3 0 0 0 2.092 2.092l.123.038-.123.038a3 3 0 0 0-2.092 2.092l-.038.123-.038-.123a3 3 0 0 0-2.092-2.092l-.123-.038.123-.038a3 3 0 0 0 2.092-2.092l.038-.123Z" />
              </svg>
              Auto-tag
            </button>
            <button
              type="button"
              onClick={() => {
                setBulkOpen((o) => !o);
                if (removeOpen) setRemoveOpen(false);
              }}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-neutral-300 rounded-lg hover:bg-neutral-50 text-neutral-700 transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Tag all
            </button>
            <button
              type="button"
              onClick={() => {
                setRemoveOpen((o) => !o);
                if (bulkOpen) setBulkOpen(false);
              }}
              disabled={allKeys.length === 0}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 border border-neutral-300 rounded-lg hover:bg-neutral-50 text-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <path d="M5 12h14" />
              </svg>
              Remove tag
            </button>
          </div>
          {bulkOpen && (
            <div className="mt-2 flex items-center gap-1.5">
              <input
                type="text"
                value={bulkKey}
                onChange={(e) => setBulkKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onBulkTag(bulkKey, bulkValue);
                    setBulkKey("");
                    setBulkValue("");
                  }
                }}
                placeholder="key"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-32 shrink-0 px-2 py-1 text-xs bg-white border border-neutral-300 rounded text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
              />
              <span className="text-xs text-neutral-400">:</span>
              <input
                type="text"
                value={bulkValue}
                onChange={(e) => setBulkValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onBulkTag(bulkKey, bulkValue);
                    setBulkKey("");
                    setBulkValue("");
                  }
                }}
                placeholder="value (comma-separated for multi-value)"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-white border border-neutral-300 rounded text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
              />
              <button
                type="button"
                onClick={() => {
                  onBulkTag(bulkKey, bulkValue);
                  setBulkKey("");
                  setBulkValue("");
                }}
                disabled={!bulkKey.trim() || !bulkValue.trim()}
                className="text-xs px-3 py-1 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white rounded transition-colors"
              >
                Apply
              </button>
            </div>
          )}
          {removeOpen && (
            <div className="mt-2 flex items-center gap-1.5">
              <select
                value={removePicked}
                onChange={(e) => setRemovePicked(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1 text-xs bg-white border border-neutral-300 rounded text-neutral-900 focus:outline-none focus:border-green-600"
              >
                <option value="">Pick a key to remove…</option>
                {allKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  if (!removePicked) return;
                  onBulkRemove(removePicked);
                  setRemovePicked("");
                }}
                disabled={!removePicked}
                className="text-xs px-3 py-1 bg-red-600 hover:bg-red-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white rounded transition-colors"
              >
                Remove from all
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {staged.map((sf, fi) => (
            <StagedRow
              key={fi}
              fileIdx={fi}
              staged={sf}
              onToggleExpand={onToggleExpand}
              onUpdateTag={onUpdateTag}
              onRemoveTag={onRemoveTag}
            />
          ))}
        </div>

        <div className="px-6 py-4 border-t border-neutral-200/80 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm px-4 py-2 text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={wouldExceed}
            className="text-sm px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            {wouldExceed
              ? "Not enough storage"
              : `Upload ${staged.length} ${staged.length === 1 ? "file" : "files"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

type StagedRowProps = {
  fileIdx: number;
  staged: StagedFile;
  onToggleExpand: (fileIdx: number) => void;
  onUpdateTag: (
    fileIdx: number,
    tagIdx: number,
    next: { key: string; value: string },
  ) => void;
  onRemoveTag: (fileIdx: number, tagIdx: number) => void;
};

/**
 * One row in the review dialog: filename + size + chevron toggle, with the
 * tag editor folded below it. The editor renders one input pair per existing
 * tag plus a trailing blank pair — typing into the trailing pair promotes
 * it into a real tag and a new blank pair appears beneath.
 */
function StagedRow({
  fileIdx,
  staged,
  onToggleExpand,
  onUpdateTag,
  onRemoveTag,
}: StagedRowProps) {
  const rows = [...staged.tags, { key: "", value: "" }];

  return (
    <div className="border border-neutral-200/80 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => onToggleExpand(fileIdx)}
          aria-label={staged.expanded ? "Hide tags" : "Edit tags"}
          className="text-neutral-400 hover:text-neutral-700 transition-colors shrink-0"
        >
          <svg
            className={`w-4 h-4 transition-transform ${
              staged.expanded ? "rotate-90" : ""
            }`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <p className="flex-1 min-w-0 text-sm text-neutral-900 truncate">
          {staged.file.name}
        </p>
        <p className="text-xs text-neutral-500 shrink-0 tabular-nums">
          {formatBytes(staged.file.size)}
        </p>
        {staged.tags.length > 0 && !staged.expanded && (
          <span className="text-[11px] text-neutral-500 shrink-0 bg-neutral-100 rounded-full px-2 py-0.5">
            {staged.tags.length} tag{staged.tags.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {staged.expanded && (
        <div className="px-3 pb-3 pt-1 space-y-1.5 border-t border-neutral-200/60 bg-neutral-50/50">
          {rows.map((row, ti) => {
            const isTrailing = ti === staged.tags.length;
            return (
              <div
                key={`${fileIdx}-${ti}`}
                className="flex items-center gap-1.5"
              >
                <input
                  type="text"
                  value={row.key}
                  onChange={(ev) =>
                    onUpdateTag(fileIdx, ti, {
                      key: ev.target.value,
                      value: row.value,
                    })
                  }
                  placeholder="key"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="w-32 shrink-0 px-2 py-1 text-xs bg-white border border-neutral-300 rounded text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
                />
                <span className="text-xs text-neutral-400">:</span>
                <input
                  type="text"
                  value={row.value}
                  onChange={(ev) =>
                    onUpdateTag(fileIdx, ti, {
                      key: row.key,
                      value: ev.target.value,
                    })
                  }
                  placeholder="value"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="flex-1 min-w-0 px-2 py-1 text-xs bg-white border border-neutral-300 rounded text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-green-600"
                />
                {!isTrailing && (
                  <button
                    type="button"
                    onClick={() => onRemoveTag(fileIdx, ti)}
                    aria-label="Remove tag"
                    className="text-neutral-400 hover:text-red-600 transition-colors text-base leading-none px-1"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
