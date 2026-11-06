import { AsyncLocalStorage } from "node:async_hooks";
import type { Config, Language } from "./config.js";

export class OzdisanError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "OzdisanError";
  }
}

/** Kullanıcıya gösterilebilecek, girdi kaynaklı hatalar (ör. ürün bulunamadı). */
export class UserInputError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "UserInputError";
  }
}

/** İstemci aracı çağrısını iptal ettiğinde fırlatılır. */
export class CancelledError extends Error {
  constructor() {
    super("İstek istemci tarafından iptal edildi.");
    this.name = "CancelledError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bir araç çağrısı boyunca geçerli olan iptal sinyali (MCP istemcisinden gelir). */
const requestContext = new AsyncLocalStorage<{ signal?: AbortSignal }>();

export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ signal }, fn);
}

export function currentSignal(): AbortSignal | undefined {
  return requestContext.getStore()?.signal;
}

export function throwIfCancelled(): void {
  if (currentSignal()?.aborted) throw new CancelledError();
}

export function isOzdisanHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "ozdisan.com" || h.endsWith(".ozdisan.com");
  } catch {
    return false;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

export interface FetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  lang: Language;
  accept?: string;
  timeoutMs?: number;
  /** "manual" ise 3xx yanıtları takip edilmeden döndürülür (yönlendirmeleri tek tek denetlemek için). */
  redirect?: "follow" | "manual";
}

/**
 * Siteye nazik davranan HTTP istemcisi:
 * - eşzamanlı istek sınırı ve istekler arası minimum bekleme
 * - zaman aşımı ve istemci iptaline uyum
 * - 429/5xx ve bağlantı hatalarında üstel geri çekilmeyle yeniden deneme (zaman aşımında yeniden denemez)
 */
export class HttpClient {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private nextSlotAt = 0;

  constructor(private readonly config: Config) {}

  private async acquire(): Promise<void> {
    if (this.active >= this.config.maxConcurrency) {
      // Slot, release() tarafından doğrudan bu bekleyene devredilir (active sayısı değişmez).
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    const now = Date.now();
    const wait = Math.max(0, this.nextSlotAt - now);
    this.nextSlotAt = Math.max(now, this.nextSlotAt) + this.config.minIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }

  url(path: string, query?: Record<string, string | number | undefined>): string {
    const u = new URL(path.startsWith("http") ? path : `${this.config.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private headers(lang: Language, extra?: Record<string, string>): Record<string, string> {
    return {
      "User-Agent": this.config.userAgent,
      "Accept-Language": lang,
      Accept: "application/json, text/html;q=0.9, */*;q=0.8",
      ...extra,
    };
  }

  /** İstek gönderir; başarılı yanıtı döndürür, başarısızlıkta OzdisanError fırlatır. */
  async fetchRaw(url: string, init: FetchOptions): Promise<Response> {
    const maxAttempts = 3;
    const timeoutMs = init.timeoutMs ?? this.config.timeoutMs;
    const trusted = isOzdisanHost(url);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfCancelled();
      await this.acquire();
      try {
        throwIfCancelled();
        const extra: Record<string, string> = {};
        if (init.body !== undefined) extra["Content-Type"] = "application/json";
        if (init.accept) extra.Accept = init.accept;
        const outer = currentSignal();
        const timeout = AbortSignal.timeout(timeoutMs);
        const res = await fetch(url, {
          method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
          headers: this.headers(init.lang, extra),
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          redirect: init.redirect ?? "follow",
          signal: outer ? AbortSignal.any([timeout, outer]) : timeout,
        });
        if (res.ok) return res;
        if (init.redirect === "manual" && res.status >= 300 && res.status < 400) return res;
        const retryable = res.status === 429 || res.status >= 500;
        // Özdisan dışı adreslerin yanıt gövdesi modele aktarılmaz.
        const text = trusted ? await res.text().catch(() => "") : (await res.body?.cancel().catch(() => undefined), "");
        lastError = new OzdisanError(
          `${trusted ? "Özdisan isteği" : "İstek"} başarısız oldu (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
          res.status,
          url,
        );
        if (!retryable) throw lastError;
        const retryAfter = Number(res.headers.get("retry-after"));
        if (attempt < maxAttempts) {
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 600 * 2 ** attempt);
        }
      } catch (err) {
        if (err instanceof OzdisanError && err.status !== undefined && err.status < 500 && err.status !== 429) throw err;
        if (err instanceof CancelledError || currentSignal()?.aborted) throw new CancelledError();
        // Zaman aşımında yeniden denemek toplam süreyi katlar; doğrudan bildir.
        if (isTimeout(err)) {
          throw new OzdisanError(`${trusted ? "Özdisan sunucusu" : "Sunucu"} ${Math.round(timeoutMs / 1000)} sn içinde yanıt vermedi.`, undefined, url);
        }
        lastError = err;
        if (attempt < maxAttempts) await sleep(600 * 2 ** attempt);
      } finally {
        this.release();
      }
    }
    if (lastError instanceof OzdisanError) throw lastError;
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new OzdisanError(`${trusted ? "Özdisan sunucusuna" : "Sunucuya"} ulaşılamadı: ${reason}`, undefined, url);
  }

  /** Yanıt gövdesini metin olarak okur; okuma sırasında oluşan zaman aşımı/iptal hatalarını anlaşılır hale getirir. */
  async readText(res: Response, url: string): Promise<string> {
    try {
      return await res.text();
    } catch (err) {
      if (currentSignal()?.aborted) throw new CancelledError();
      throw new OzdisanError(`Yanıt okunamadı: ${err instanceof Error ? err.message : String(err)}`, res.status, url);
    }
  }

  private parseJson<T>(text: string, res: Response, url: string): T {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OzdisanError(`Özdisan beklenmeyen bir yanıt döndürdü: ${text.slice(0, 200)}`, res.status, url);
    }
  }

  async getJson<T>(path: string, opts: { lang: Language; query?: Record<string, string | number | undefined> }): Promise<T> {
    const url = this.url(path, opts.query);
    const res = await this.fetchRaw(url, { lang: opts.lang });
    return this.parseJson<T>(await this.readText(res, url), res, url);
  }

  async postJson<T>(path: string, body: unknown, opts: { lang: Language }): Promise<T> {
    const url = this.url(path);
    const res = await this.fetchRaw(url, { method: "POST", body, lang: opts.lang });
    return this.parseJson<T>(await this.readText(res, url), res, url);
  }

  async getText(path: string, opts: { lang: Language }): Promise<{ text: string; finalUrl: string }> {
    const url = this.url(path);
    const res = await this.fetchRaw(url, { lang: opts.lang, accept: "text/html,application/xhtml+xml" });
    return { text: await this.readText(res, url), finalUrl: res.url || url };
  }
}
