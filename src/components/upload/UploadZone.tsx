import { encodedSize, type ShardProgress } from "@siafoundation/sia-storage";
import { useRef, useState } from "react";
import { SHARE_VALID_UNTIL, writeSharePost } from "../../lib/atproto";
import { APP_KEY, DATA_SHARDS, PARITY_SHARDS } from "../../lib/constants";
import { expandDataTransferToFiles } from "../../lib/dropzone";
import { generateThumbnail } from "../../lib/preview";
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

export type UploadZoneProps = {
  /** Called after every successful per-file share-record write. Refreshes the feed incrementally. */
  onUploaded?: () => void;
};

/**
 * Compose-only dropzone. Accepts both individual files and dropped folders;
 * recursively flattens folders, batches everything into a single packed Sia
 * upload (which amortizes erasure-coding overhead across small files), then
 * publishes one `app.cumulus.share.post` record per file.
 */
export function UploadZone({ onUploaded }: UploadZoneProps) {
  const sdk = useAuthStore((s) => s.sdk);
  const agent = useAtprotoStore((s) => s.agent);
  const [uploading, setUploading] = useState(false);
  const [activeUpload, setActiveUpload] = useState<UploadProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  async function uploadFiles(files: File[]) {
    if (!sdk || !agent || files.length === 0) return;
    setUploading(true);
    setError(null);

    const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    // Aggregate encoded total — packing collapses per-file overhead, so this
    // overestimates the bytes that hit hosts, but it's the right denominator
    // for a deterministic 0..100% bar.
    const encodedTotal = Number(
      encodedSize(totalBytes, DATA_SHARDS, PARITY_SHARDS),
    );
    setActiveUpload({
      label: files.length === 1 ? files[0].name : `${files.length} files`,
      totalBytes,
      shardsDone: 0,
      bytesUploaded: 0,
      encodedTotal,
      fileCount: files.length,
      finalizedCount: 0,
    });

    try {
      const prepared = await prepareFiles(files);

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
          await writeSharePost(agent, {
            shareUrl,
            siaKey: obj.id(),
            name: meta.name,
            mimeType: meta.type,
            size: meta.size,
            createdAt: new Date(meta.createdAt).toISOString(),
            ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}),
          });

          setActiveUpload((prev) =>
            prev ? { ...prev, finalizedCount: i + 1 } : prev,
          );
          onUploaded?.();
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
    if (files.length > 0) await uploadFiles(files);
  }

  async function handlePicked(fileList: FileList) {
    await uploadFiles(Array.from(fileList));
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
    </div>
  );
}
