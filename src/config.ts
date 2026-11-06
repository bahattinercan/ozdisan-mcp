import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Language = "tr" | "en";
export type Currency = "TRY" | "USD" | "EUR";

export const LANGUAGES: readonly Language[] = ["tr", "en"];
export const CURRENCIES: readonly Currency[] = ["TRY", "USD", "EUR"];

export const VERSION = "0.1.0";
export const REPO_URL = "https://github.com/mert-ozkul/ozdisan-mcp";

export interface Config {
  /** Özdisan web sitesinin kök adresi. */
  baseUrl: string;
  /** Kategori/özellik adlarının dili. */
  language: Language;
  /** Fiyatların varsayılan para birimi. */
  currency: Currency;
  /** Datasheet'lerin indirileceği klasör. */
  downloadDir: string;
  /** Kategori ağacı gibi büyük verilerin disk önbelleği. */
  cacheDir: string;
  /** Disk önbelleğini kapatmak için false. */
  diskCache: boolean;
  /** Tek bir HTTP isteğinin zaman aşımı (ms). */
  timeoutMs: number;
  /** Ardışık iki isteğin başlangıcı arasındaki en kısa süre (ms). */
  minIntervalMs: number;
  /** Aynı anda en fazla kaç istek gönderileceği. */
  maxConcurrency: number;
  /** İndirilecek dosya boyutu sınırı (bayt). */
  maxDownloadBytes: number;
  userAgent: string;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envChoice<T extends string>(name: string, choices: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const match = choices.find((c) => c.toLowerCase() === raw.toLowerCase());
  return match ?? fallback;
}

/** Baştaki "~" işaretini ev dizinine açar ve yolu mutlak hale getirir. Göreli yolları reddeder. */
export function expandPath(input: string, label = "Yol"): string {
  let p = input.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) {
    throw new Error(`${label} mutlak bir yol olmalı (ör. /Users/ad/Datasheets veya ~/Datasheets): "${input}"`);
  }
  return p;
}

function envPath(name: string, fallback: () => string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback();
  try {
    return expandPath(raw, name);
  } catch {
    process.stderr.write(`ozdisan-mcp: ${name} mutlak bir yol değil ("${raw}"), varsayılan kullanılıyor.\n`);
    return fallback();
  }
}

function defaultDownloadDir(): string {
  const downloads = join(homedir(), "Downloads");
  if (existsSync(downloads)) return join(downloads, "ozdisan-datasheets");
  return join(homedir(), "ozdisan-datasheets");
}

function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, "ozdisan-mcp");
  const home = homedir();
  if (home) return join(home, ".cache", "ozdisan-mcp");
  return join(tmpdir(), "ozdisan-mcp-cache");
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const config: Config = {
    baseUrl: (process.env.OZDISAN_BASE_URL?.trim() || "https://www.ozdisan.com").replace(/\/+$/, ""),
    language: envChoice("OZDISAN_LANG", LANGUAGES, "tr"),
    currency: envChoice("OZDISAN_CURRENCY", CURRENCIES, "TRY"),
    downloadDir: envPath("OZDISAN_DOWNLOAD_DIR", defaultDownloadDir),
    cacheDir: envPath("OZDISAN_CACHE_DIR", defaultCacheDir),
    diskCache: process.env.OZDISAN_DISK_CACHE !== "0" && process.env.OZDISAN_DISK_CACHE !== "false",
    timeoutMs: envInt("OZDISAN_TIMEOUT_MS", 30_000, 2_000, 180_000),
    minIntervalMs: envInt("OZDISAN_MIN_INTERVAL_MS", 250, 0, 10_000),
    maxConcurrency: envInt("OZDISAN_MAX_CONCURRENCY", 2, 1, 6),
    maxDownloadBytes: envInt("OZDISAN_MAX_DOWNLOAD_MB", 50, 1, 500) * 1024 * 1024,
    userAgent: `ozdisan-mcp/${VERSION} (local MCP server; ${REPO_URL})`,
  };
  return { ...config, ...overrides };
}
