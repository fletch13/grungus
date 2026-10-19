interface Entry {
  controller: AbortController;
  promise: Promise<string | null>;
  url?: string;
  bytes: number;
}

/** Bounded LRU cache. Failures are retryable; eviction cancels downloads and releases blobs. */
export class BlobCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private maxEntries: number;
  private maxBytes: number;
  constructor(maxEntries = 128, maxBytes = 64 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }
  get size(): number { return this.entries.size; }
  get byteLength(): number { return this.bytes; }

  get(key: string, load: (signal: AbortSignal) => Promise<Blob | null>): Promise<string | null> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }
    const entry: Entry = { controller: new AbortController(), promise: Promise.resolve(null), bytes: 0 };
    this.entries.set(key, entry);
    entry.promise = Promise.resolve().then(() => load(entry.controller.signal)).then(blob => {
      if (!blob || this.entries.get(key) !== entry) {
        if (this.entries.get(key) === entry) this.remove(key);
        return null;
      }
      // A single oversized download is never retained.
      if (blob.size > this.maxBytes) { this.remove(key); return null; }
      entry.url = URL.createObjectURL(blob);
      entry.bytes = blob.size;
      this.bytes += blob.size;
      this.trim();
      return this.entries.get(key) === entry ? entry.url : null;
    }).catch(() => {
      if (this.entries.get(key) === entry) this.remove(key);
      return null;
    });
    this.trim();
    return entry.promise;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
    this.bytes -= entry.bytes;
  }
  private trim(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value!);
    }
  }
  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }
}
