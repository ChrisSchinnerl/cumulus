/**
 * Recursively flatten everything in a {@link DataTransfer} drop into a flat
 * `File[]`. Folders are walked depth-first via the `webkitGetAsEntry`
 * filesystem API; non-directory items are returned as-is.
 *
 * Falls back to `DataTransfer.files` when the entry API isn't available
 * (older browsers; rare on a hackathon target).
 */
export async function expandDataTransferToFiles(
  dt: DataTransfer,
): Promise<File[]> {
  const out: File[] = [];
  const entries: FileSystemEntry[] = [];

  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i];
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      entries.push(entry);
    } else {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }

  if (entries.length === 0 && out.length === 0) {
    for (const file of Array.from(dt.files)) out.push(file);
    return out;
  }

  for (const entry of entries) {
    await walkEntry(entry, out);
  }
  return out;
}

async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    out.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return;
    for (const sub of batch) {
      await walkEntry(sub, out);
    }
  }
}
