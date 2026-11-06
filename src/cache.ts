import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Basit, süreli (TTL) ve boyut sınırlı (LRU) bellek önbelleği.
 * Aynı anahtara eşzamanlı gelen istekler tek bir isteğe indirgenir.
 */
export class MemoryCache {
  private readonly store = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries = 500) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // LRU: son kullanılanı sona taşı
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const promise = (async () => {
      try {
        // Yükleyici senkron hata fırlatsa bile kayıt inflight'a eklendikten sonra temizlensin.
        const value = await Promise.resolve().then(loader);
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Büyük ve seyrek değişen veriler (ör. kategori ağacı) için JSON disk önbelleği.
 * Hatalar sessizce yutulur; disk önbelleği yalnızca hızlandırıcıdır.
 */
export class DiskCache {
  constructor(
    private readonly dir: string,
    private readonly enabled: boolean,
  ) {}

  private pathFor(key: string): string {
    const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
    const safe = key.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
    return join(this.dir, `${safe}-${hash}.json`);
  }

  async get<T>(key: string, maxAgeMs: number): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      const parsed = JSON.parse(raw) as { savedAt: number; value: T };
      if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > maxAgeMs) return undefined;
      return parsed.value;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (!this.enabled) return;
    try {
      await mkdir(this.dir, { recursive: true });
      const target = this.pathFor(key);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ savedAt: Date.now(), value }), "utf8");
      await rename(tmp, target);
    } catch {
      // disk önbelleği isteğe bağlıdır
    }
  }
}
