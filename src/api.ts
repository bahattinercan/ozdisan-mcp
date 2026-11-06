import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve as resolvePath } from "node:path";
import { DiskCache, MemoryCache } from "./cache.js";
import type { Config, Currency, Language } from "./config.js";
import { CancelledError, currentSignal, HttpClient, isOzdisanHost, OzdisanError, UserInputError } from "./http.js";
import { assertPublicUrl, externalGet } from "./netguard.js";
import { compact, similarity } from "./text.js";
import type {
  RawCategoryNode,
  RawCategorySearchResponse,
  RawDatasheetResolve,
  RawListResponse,
  RawParametricResponse,
  RawProductPage,
  RawQuickSearchResponse,
  RawQuickSearchVariant,
  RawRelationResponse,
  RawTopFilterResponse,
  RawVariantPriceResponse,
} from "./types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface CategoryEntry {
  sequenceId: number;
  name: string;
  slug: string;
  level: number;
  productCount: number;
  path: string[];
  parentSequenceId?: number;
  childCount: number;
}

export interface CategoryIndex {
  roots: RawCategoryNode[];
  bySeq: Map<number, CategoryEntry>;
  nodes: Map<number, RawCategoryNode>;
  totalCount: number;
}

export interface ListRequest {
  page?: number;
  pageSize?: number;
  search?: string;
  currency?: Currency;
  sort?: { key: string; isProp: boolean; isDesc: boolean };
  pricingQuantity?: number;
  valueFilters?: Array<{ propertyId: string; values: string[] }>;
  numericValueFilters?: Array<Record<string, unknown>>;
  filterOptions?: Array<{ code: string; value: string }>;
}

export interface ResolvedProduct {
  erpRefId: string;
  /** Aynı parça numarasına sahip diğer ürünler (farklı üretici / paketleme). */
  otherMatches: Array<{ erpRefId: string; sku: string; description?: string; url: string }>;
}

/** URL veya slug sonundaki "-123456" kimliğini çıkarır. */
export function trailingId(input: string): string | undefined {
  const cleaned = input.split(/[?#]/)[0]?.replace(/\/+$/, "") ?? "";
  const m = cleaned.match(/-(\d+)$/);
  return m?.[1];
}

/** __NEXT_DATA__ içindeki pageProps nesnesini çıkarır. */
export function extractNextData(html: string): Record<string, unknown> | undefined {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) return undefined;
  try {
    const parsed = JSON.parse(m[1]) as { props?: { pageProps?: Record<string, unknown> } };
    return parsed.props?.pageProps;
  } catch {
    return undefined;
  }
}

function flattenTree(roots: RawCategoryNode[]): Pick<CategoryIndex, "bySeq" | "nodes"> {
  const bySeq = new Map<number, CategoryEntry>();
  const nodes = new Map<number, RawCategoryNode>();
  const walk = (node: RawCategoryNode, path: string[], parent?: number, depth = 1) => {
    const p = [...path, node.name];
    bySeq.set(node.sequenceId, {
      sequenceId: node.sequenceId,
      name: node.name,
      slug: node.slug,
      level: node.level ?? depth,
      productCount: node.productCount ?? 0,
      path: p,
      parentSequenceId: parent,
      childCount: node.subCategories?.length ?? 0,
    });
    nodes.set(node.sequenceId, node);
    for (const child of node.subCategories ?? []) walk(child, p, node.sequenceId, depth + 1);
  };
  for (const r of roots) walk(r, []);
  return { bySeq, nodes };
}

/** Kategori ağacından gereksiz alanları (SEO metni vb.) atarak küçültür. */
function slimTree(nodes: RawCategoryNode[] | undefined): RawCategoryNode[] {
  return (nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name,
    slug: n.slug,
    sequenceId: n.sequenceId,
    level: n.level,
    order: n.order,
    productCount: n.productCount,
    subCategories: slimTree(n.subCategories),
  }));
}

/** Dosya adını güvenli hale getirir: dizin parçalarını ve geçersiz karakterleri atar, uzantıyı korur (varsayılan .pdf). */
export function sanitizeFileName(name: string): string {
  const base = basename(name.replace(/\\/g, "/"))
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  const ext = extname(base);
  const validExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : "";
  const stem = (validExt ? base.slice(0, -ext.length) : base).slice(0, 150).trim() || "datasheet";
  return `${stem}${validExt || ".pdf"}`;
}

export class OzdisanClient {
  readonly http: HttpClient;
  private readonly memory = new MemoryCache(800);
  /** PDF gibi büyük ikili veriler için ayrı ve küçük önbellek. */
  private readonly binaries = new MemoryCache(4);
  private readonly disk: DiskCache;

  constructor(readonly config: Config) {
    this.http = new HttpClient(config);
    this.disk = new DiskCache(config.cacheDir, config.diskCache);
  }

  lang(language?: Language): Language {
    return language ?? this.config.language;
  }

  currency(currency?: Currency): Currency {
    return currency ?? this.config.currency;
  }

  productUrl(fullPath: string | undefined, lang: Language, erpRefId?: string): string {
    const prefix = lang === "en" ? "/en/p/" : "/p/";
    if (fullPath) return `${this.config.baseUrl}${prefix}${fullPath.replace(/^\/?(en\/)?p\//, "")}`;
    return `${this.config.baseUrl}${prefix}urun/urun-${erpRefId ?? ""}`;
  }

  categoryUrl(slug: string, lang: Language): string {
    return `${this.config.baseUrl}${lang === "en" ? "/en" : ""}/ps/${slug}`;
  }

  absoluteMediaUrl(path: string | undefined): string | undefined {
    if (!path) return undefined;
    if (/^https?:\/\//i.test(path)) return path;
    const trimmed = path.replace(/^\/+/, "");
    if (trimmed.startsWith("public/")) return `https://cdn.ozdisan.com/${encodeURI(trimmed)}`;
    if (trimmed.includes("/")) return `https://cdn.ozdisan.com/public/${encodeURI(trimmed)}`;
    return `https://cdn.ozdisan.com/public/product/assets/${encodeURIComponent(trimmed)}`;
  }

  // ---------------------------------------------------------------- Kategoriler

  /** Tüm kategori ağacı (ürün sayılarıyla). Bellekte 6 saat, diskte 24 saat saklanır. */
  async getCategoryIndex(language?: Language): Promise<CategoryIndex> {
    const lang = this.lang(language);
    return this.memory.getOrLoad(`tree:${lang}`, 6 * HOUR, async () => {
      const diskKey = `category-tree-${lang}`;
      let raw = await this.disk.get<{ totalCount: number; roots: RawCategoryNode[] }>(diskKey, 24 * HOUR);
      if (!raw || !Array.isArray(raw.roots) || raw.roots.length === 0) {
        const res = await this.http.postJson<RawCategorySearchResponse>(
          "/api/categories/categories",
          { filters: {} },
          { lang },
        );
        raw = { totalCount: res.totalCount ?? 0, roots: slimTree(res.categories) };
        if (raw.roots.length > 0) await this.disk.set(diskKey, raw);
      }
      if (!raw.roots.length) throw new OzdisanError("Kategori ağacı alınamadı.");
      return { roots: raw.roots, totalCount: raw.totalCount, ...flattenTree(raw.roots) };
    });
  }

  /** Arama ifadesine (ve isteğe bağlı üretici/stok filtresine) göre eşleşen kategori ağacı. */
  async searchCategoryTree(
    filters: { search?: string; manufacturerIds?: string[]; filterOptions?: Array<{ code: string; value: string }> },
    language?: Language,
  ): Promise<RawCategorySearchResponse> {
    const lang = this.lang(language);
    const body = { filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== "")) };
    return this.memory.getOrLoad(`catsearch:${lang}:${JSON.stringify(body)}`, 5 * MINUTE, () =>
      this.http.postJson<RawCategorySearchResponse>("/api/categories/categories", body, { lang }),
    );
  }

  /**
   * Kategori girdisini (sıra numarası, slug, URL veya ad) çözümler.
   * Ad ile eşleşme belirsizse adayları listeleyen bir UserInputError fırlatır.
   */
  async resolveCategory(input: string | number, language?: Language): Promise<CategoryEntry> {
    const lang = this.lang(language);
    const index = await this.getCategoryIndex(lang);
    const text = String(input).trim();
    if (!text) throw new UserInputError("Kategori belirtilmedi.");

    // Sayı yalnızca saf sayı, URL veya gerçek bir kategori slug'ı ise kimlik olarak kabul edilir.
    // ("TO-220", "RS-485", "Cat-6" gibi adlar yanlışlıkla 220/485/6 numaralı kategoriye gitmesin.)
    if (/^\d+$/.test(text) && index.bySeq.has(Number(text))) return index.bySeq.get(Number(text))!;
    const id = Number(trailingId(text));
    if (Number.isFinite(id) && index.bySeq.has(id)) {
      const isUrl = /^https?:\/\//i.test(text) || /(^|\/)(en\/)?(ps|c)\//.test(text);
      const slug = text.split(/[?#]/)[0]!.replace(/\/+$/, "").split("/").pop()!.toLowerCase();
      const otherIndex = isUrl ? undefined : await this.getCategoryIndex(lang === "tr" ? "en" : "tr").catch(() => undefined);
      const slugMatches =
        index.bySeq.get(id)!.slug.toLowerCase() === slug || otherIndex?.bySeq.get(id)?.slug.toLowerCase() === slug;
      if (isUrl || slugMatches) return index.bySeq.get(id)!;
    }

    const candidates = this.rankCategories(index, text);
    const top = candidates[0];
    if (top && top.score >= 0.97) return top.entry;

    // Diğer dildeki adlarla da dene (ör. "Microcontrollers" yazıldı ama dil "tr").
    const other: Language = lang === "tr" ? "en" : "tr";
    const otherIndex = await this.getCategoryIndex(other).catch(() => undefined);
    if (otherIndex) {
      const otherTop = this.rankCategories(otherIndex, text)[0];
      if (otherTop && otherTop.score >= 0.97) {
        const same = index.bySeq.get(otherTop.entry.sequenceId);
        if (same) return same;
      }
    }
    const runnerUp = candidates[1]?.score ?? 0;
    if (top && ((top.score >= 0.88 && runnerUp < top.score) || (top.score >= 0.75 && top.score - runnerUp >= 0.12))) {
      return top.entry;
    }

    const suggestions = candidates.slice(0, 8).map((c) => ({
      category: c.entry.slug,
      name: c.entry.name,
      path: c.entry.path.join(" > "),
      product_count: c.entry.productCount,
    }));
    throw new UserInputError(
      suggestions.length
        ? `"${text}" kategorisi kesin olarak bulunamadı. Aşağıdaki adaylardan birinin 'category' (slug) değerini kullanın.`
        : `"${text}" ile eşleşen kategori bulunamadı. search_categories aracıyla arayın.`,
      { suggestions },
    );
  }

  rankCategories(index: CategoryIndex, query: string): Array<{ entry: CategoryEntry; score: number }> {
    const out: Array<{ entry: CategoryEntry; score: number }> = [];
    for (const entry of index.bySeq.values()) {
      const nameScore = similarity(query, entry.name);
      const pathScore = similarity(query, entry.path.join(" ")) * 0.85;
      const slugScore = similarity(query, entry.slug.replace(/-\d+$/, "").replace(/-/g, " ")) * 0.9;
      const score = Math.max(nameScore, pathScore, slugScore);
      if (score >= 0.4) out.push({ entry, score });
    }
    out.sort((a, b) => b.score - a.score || b.entry.productCount - a.entry.productCount || b.entry.level - a.entry.level);
    return out;
  }

  // ---------------------------------------------------------------- Ürün listeleri

  async listProducts(sequenceId: number, req: ListRequest, language?: Language): Promise<RawListResponse> {
    const lang = this.lang(language);
    const body: Record<string, unknown> = {
      type: "GetListData",
      catSequenceId: String(sequenceId),
      pagination: { currentPage: req.page ?? 1, pageSize: req.pageSize ?? 20 },
      sort: req.sort ?? {},
      currencyCode: this.currency(req.currency),
      search: req.search ?? "",
    };
    if (req.pricingQuantity) body.pricingQuantity = req.pricingQuantity;
    if (req.valueFilters?.length) body.valueFilters = req.valueFilters;
    if (req.numericValueFilters?.length) body.numericValueFilters = req.numericValueFilters;
    if (req.filterOptions?.length) body.filterOptions = req.filterOptions;
    const key = `list:${lang}:${JSON.stringify(body)}`;
    return this.memory.getOrLoad(key, 5 * MINUTE, async () => {
      const res = await this.http.postJson<RawListResponse>("/api/ps", body, { lang });
      if (!res?.variantList) throw new OzdisanError("Ürün listesi alınamadı (beklenmeyen yanıt).");
      return res;
    });
  }

  /** Bir kategorinin filtre şeması (özellikler, birimler, tüm seçenekler). 1 saat önbellekte. */
  async getCategoryMeta(sequenceId: number, language?: Language): Promise<RawListResponse> {
    const lang = this.lang(language);
    return this.memory.getOrLoad(`meta:${lang}:${sequenceId}`, HOUR, () =>
      this.listProducts(sequenceId, { page: 1, pageSize: 1 }, lang),
    );
  }

  /** Mevcut filtrelere göre hâlâ seçilebilir olan seçenekleri (isDisabled) döndürür. */
  async getAvailableFilters(
    sequenceId: number,
    filters: Pick<ListRequest, "valueFilters" | "numericValueFilters" | "filterOptions">,
    search: string | undefined,
    language?: Language,
  ): Promise<RawTopFilterResponse> {
    const lang = this.lang(language);
    const body = {
      type: "GetTopFilterData",
      catSequenceId: String(sequenceId),
      filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => Array.isArray(v) && v.length > 0)),
      search: search ?? "",
    };
    return this.memory.getOrLoad(`topfilter:${lang}:${JSON.stringify(body)}`, 10 * MINUTE, () =>
      this.http.postJson<RawTopFilterResponse>("/api/ps", body, { lang }),
    );
  }

  // ---------------------------------------------------------------- Arama

  async quickSearch(text: string, language?: Language): Promise<RawQuickSearchResponse> {
    const lang = this.lang(language);
    const q = text.trim();
    return this.memory.getOrLoad(`quick:${lang}:${q.toLowerCase()}`, 5 * MINUTE, () =>
      this.http.getJson<RawQuickSearchResponse>("/api/layout/header", { lang, query: { text: q } }),
    );
  }

  quickVariantUrl(v: RawQuickSearchVariant, lang: Language): string {
    const slugs = v.category?.slugs ?? [];
    const catSlug =
      slugs.find((s) => s.langCode === lang)?.slug ?? slugs.find((s) => s.isDefault)?.slug ?? v.category?.slug ?? "urun";
    return this.productUrl(`${catSlug}/${v.slug}`, lang);
  }

  /**
   * Ürün girdisini (Özdisan ürün kodu, ürün URL'si veya parça numarası) erpRefId'ye çözer.
   */
  async resolveProduct(input: string, language?: Language, opts: { asPartNumber?: boolean } = {}): Promise<ResolvedProduct> {
    const lang = this.lang(language);
    const text = input.trim();
    if (!text) throw new UserInputError("Ürün belirtilmedi.");
    if (!opts.asPartNumber && /^\d{3,9}$/.test(text)) return { erpRefId: text, otherMatches: [] };
    if (/^https?:\/\//i.test(text) || text.includes("/p/")) {
      const id = trailingId(text);
      if (id) return { erpRefId: id, otherMatches: [] };
    }

    const wanted = compact(text);
    const upper = text.toUpperCase();
    // Önce birebir (büyük/küçük harf duyarsız) eşleşme; yoksa noktalama farklarını yok sayan eşleşme.
    // "MAX232CPE+" ile "MAX232CPE" gibi farklı parçalar varsa birebir olan seçilir.
    const pickExact = <T extends { sku: string }>(items: T[]): T[] => {
      const strict = items.filter((v) => v.sku.trim().toUpperCase() === upper);
      return strict.length ? strict : items.filter((v) => compact(v.sku) === wanted);
    };
    const quick = await this.quickSearch(text, lang);
    const variants = quick.variants ?? [];
    let exact = pickExact(variants);

    let lookupFailed = false;
    if (exact.length === 0) {
      // Hızlı arama ilk 50 sonucu döndürür; tam eşleşme geride kalmışsa kategori içinde ara.
      const tree = await this.searchCategoryTree({ search: text }, lang).catch(() => {
        lookupFailed = true;
        return undefined;
      });
      const leaves = tree ? leafHits(tree.categories).slice(0, 3) : [];
      for (const leaf of leaves) {
        const list = await this.listProducts(leaf.sequenceId, { search: text, pageSize: 100 }, lang).catch(() => {
          lookupFailed = true;
          return undefined;
        });
        const hit = list ? pickExact(list.variantList.data) : [];
        if (hit.length) {
          const [first, ...rest] = hit;
          return {
            erpRefId: first!.erpRefId,
            otherMatches: rest.map((v) => ({
              erpRefId: v.erpRefId,
              sku: v.sku,
              description: v.description,
              url: this.productUrl(v.fullPath, lang),
            })),
          };
        }
      }
    }

    if (exact.length === 0 && lookupFailed) {
      throw new OzdisanError(`"${text}" araması tamamlanamadı (Özdisan geçici olarak yanıt vermedi). Biraz sonra tekrar deneyin.`);
    }
    if (exact.length === 0) {
      const suggestions = variants.slice(0, 8).map((v) => ({
        product: trailingId(v.slug),
        part_number: v.sku,
        description: v.description,
      }));
      throw new UserInputError(
        `"${text}" parça numarasıyla birebir eşleşen ürün bulunamadı.` +
          (suggestions.length ? " Benzer sonuçlardan birinin 'product' kodunu kullanabilirsiniz." : " search_products ile arayın."),
        { suggestions },
      );
    }

    exact = exact.filter((v) => trailingId(v.slug));
    const [first, ...rest] = exact;
    if (!first) throw new UserInputError(`"${text}" için ürün kodu çözümlenemedi.`);
    return {
      erpRefId: trailingId(first.slug)!,
      otherMatches: rest.map((v) => ({
        erpRefId: trailingId(v.slug)!,
        sku: v.sku,
        description: v.description,
        url: this.quickVariantUrl(v, lang),
      })),
    };
  }

  // ---------------------------------------------------------------- Ürün detayı

  /**
   * Ürün girdisini çözer ve detay sayfasını yükler. Tamamen rakamdan oluşan girdi önce Özdisan ürün kodu olarak
   * denenir; böyle bir ürün yoksa parça numarası olarak aranır (ör. Keystone "5001"). Tüm araçlar bunu kullanır.
   */
  async loadProduct(
    input: string,
    language?: Language,
  ): Promise<{ page: RawProductPage & { url: string }; otherMatches: ResolvedProduct["otherMatches"] }> {
    const lang = this.lang(language);
    const resolved = await this.resolveProduct(input, lang);
    try {
      return { page: await this.getProductPage(resolved.erpRefId, lang), otherMatches: resolved.otherMatches };
    } catch (err) {
      if (!(err instanceof UserInputError) || !/^\d+$/.test(input.trim())) throw err;
      const bySku = await this.resolveProduct(input, lang, { asPartNumber: true }).catch(() => undefined);
      if (!bySku || bySku.erpRefId === resolved.erpRefId) throw err;
      return { page: await this.getProductPage(bySku.erpRefId, lang), otherMatches: bySku.otherMatches };
    }
  }

  async getProductPage(erpRefId: string, language?: Language): Promise<RawProductPage & { url: string }> {
    const lang = this.lang(language);
    return this.memory.getOrLoad(`pdp:${lang}:${erpRefId}`, 10 * MINUTE, async () => {
      const path = `${lang === "en" ? "/en" : ""}/p/urun/urun-${encodeURIComponent(erpRefId)}`;
      let page: { text: string; finalUrl: string };
      try {
        page = await this.http.getText(path, { lang });
      } catch (err) {
        if (err instanceof OzdisanError && err.status === 404) {
          throw new UserInputError(`${erpRefId} kodlu ürün Özdisan'da bulunamadı.`);
        }
        throw err;
      }
      const props = extractNextData(page.text) as (RawProductPage & { error?: unknown }) | undefined;
      if (!props?.data?.erpRefId) throw new UserInputError(`${erpRefId} kodlu ürün Özdisan'da bulunamadı.`);
      return { ...props, url: page.finalUrl };
    });
  }

  async getVariantPrices(variantId: string, currency?: Currency): Promise<RawVariantPriceResponse> {
    const cur = this.currency(currency);
    return this.memory.getOrLoad(`price:${variantId}:${cur}`, 10 * MINUTE, () =>
      this.http.postJson<RawVariantPriceResponse>(
        "/api/products/variantPrice",
        { type: "VARIANT_PRICES", id: variantId, currencyCode: cur, countryCode: "TR" },
        { lang: this.config.language },
      ),
    );
  }

  async getRelations(variantId: string, currency?: Currency, language?: Language): Promise<RawRelationResponse> {
    const lang = this.lang(language);
    const cur = this.currency(currency);
    return this.memory.getOrLoad(`rel:${lang}:${cur}:${variantId}`, 10 * MINUTE, () =>
      this.http.postJson<RawRelationResponse>(
        "/api/products/relation",
        { id: variantId, currencyCode: cur, relationTypes: [1, 2, 3], size: 100 },
        { lang },
      ),
    );
  }

  async getParametricAlternatives(
    variantId: string,
    categoryId: string,
    currency?: Currency,
    language?: Language,
  ): Promise<RawParametricResponse> {
    const lang = this.lang(language);
    const cur = this.currency(currency);
    return this.memory.getOrLoad(`param:${lang}:${cur}:${variantId}`, 10 * MINUTE, () =>
      this.http.postJson<RawParametricResponse>(
        "/api/products/relationParametric",
        { variantId, categoryId, currencyCode: cur, countryCode: "TR" },
        { lang },
      ),
    );
  }

  // ---------------------------------------------------------------- Datasheet

  async resolveDatasheetUrl(sku: string, mediaPath?: string): Promise<{ url: string; fileName: string; isExternal: boolean } | undefined> {
    if (mediaPath && /^https?:\/\//i.test(mediaPath)) {
      return { url: mediaPath, fileName: safeDecode(basename(new URL(mediaPath).pathname)), isExternal: !isOzdisanHost(mediaPath) };
    }
    try {
      const res = await this.memory.getOrLoad(`ds:${sku}`, HOUR, () =>
        this.http.postJson<RawDatasheetResolve>("/api/pdf/resolve", { sku, field: "Datasheet" }, { lang: this.config.language }),
      );
      const expected = mediaPath ? basename(mediaPath) : undefined;
      // Aynı parça numarası farklı üreticilerde bulunabilir; çözülen dosya ürünün kendi dosyası değilse ürünün yolunu kullan.
      const mismatch = expected && res?.fileName && res.fileName !== expected && !res.isExternal;
      if (res?.url && !mismatch) return { url: res.url, fileName: res.fileName || `${sku}.pdf`, isExternal: !!res.isExternal };
    } catch {
      // aşağıdaki yedek yönteme düş
    }
    if (mediaPath) {
      const url = this.absoluteMediaUrl(mediaPath);
      if (url) return { url, fileName: basename(mediaPath), isExternal: false };
    }
    return undefined;
  }

  /**
   * Bir dosya adresini açar. Özdisan dışındaki adreslerde yönlendirmeler tek tek takip edilir ve her adımda
   * hedefin yerel/özel ağda olmadığı (DNS dahil) doğrulanır.
   */
  async openBinary(url: string): Promise<{ res: Response; finalUrl: string }> {
    const timeoutMs = Math.max(this.config.timeoutMs, 60_000);
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      let res: Response;
      if (isOzdisanHost(current)) {
        res = await this.http.fetchRaw(current, {
          lang: this.config.language,
          accept: "application/pdf,*/*",
          timeoutMs,
          redirect: "manual",
        });
      } else {
        // Özdisan dışı adres: ad ve IP denetimi + bağlantı anında (DNS rebinding'e karşı) adres denetimi.
        const target = await assertPublicUrl(current);
        const outer = currentSignal();
        const timeout = AbortSignal.timeout(timeoutMs);
        try {
          res = await externalGet(target, {
            headers: { "User-Agent": this.config.userAgent, Accept: "application/pdf,*/*" },
            timeoutMs,
            signal: outer ? AbortSignal.any([timeout, outer]) : timeout,
          });
        } catch (err) {
          if (outer?.aborted) throw new CancelledError();
          if (err instanceof UserInputError) throw err;
          throw new OzdisanError(`Datasheet adresine ulaşılamadı: ${err instanceof Error ? err.message : String(err)}`, undefined, current);
        }
        if (!res.ok && !(res.status >= 300 && res.status < 400)) {
          await res.body?.cancel().catch(() => undefined);
          throw new OzdisanError(`Datasheet adresi HTTP ${res.status} döndürdü.`, res.status, current);
        }
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new OzdisanError(`Yönlendirme hedefi yok (HTTP ${res.status}).`, res.status, current);
        current = new URL(location, current).toString();
        continue;
      }
      return { res, finalUrl: current };
    }
    throw new OzdisanError("Çok fazla yönlendirme.", undefined, url);
  }

  /** Yanıtı boyut sınırıyla okur; sınır aşılınca bağlantıyı keser. İlk baytların PDF olduğunu doğrular. */
  private async readPdfBody(res: Response, url: string, sink?: (chunk: Uint8Array) => Promise<void>): Promise<{ bytes: number; data?: Uint8Array }> {
    const limit = this.config.maxDownloadBytes;
    const declared = Number(res.headers.get("content-length"));
    const contentType = res.headers.get("content-type") ?? "";
    const reject = async (err: Error) => {
      await res.body?.cancel().catch(() => undefined);
      throw err;
    };
    if (Number.isFinite(declared) && declared > limit) {
      await reject(new UserInputError(`Dosya çok büyük (${Math.round(declared / 1024 / 1024)} MB). Sınır: OZDISAN_MAX_DOWNLOAD_MB.`));
    }
    if (/text\/html/i.test(contentType)) {
      await reject(new UserInputError(`Datasheet bağlantısı PDF yerine bir web sayfası döndürüyor (muhtemelen üretici sitesine yönlendiriyor): ${url}`));
    }
    if (!res.body) throw new OzdisanError("Yanıt gövdesi boş geldi.", res.status, url);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let header = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new UserInputError("Dosya boyutu sınırı aşıldı (OZDISAN_MAX_DOWNLOAD_MB).");
        if (header.length < 1024) {
          // PDF imzası ("%PDF") ilk 1024 bayt içinde olmalıdır.
          header += new TextDecoder("latin1").decode(value.subarray(0, 1024 - header.length));
          if (header.length >= 1024 && !header.includes("%PDF")) {
            throw new UserInputError(`Bağlantı bir PDF dosyası döndürmedi: ${url}`);
          }
        }
        if (sink) await sink(value);
        else chunks.push(value);
      }
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      if (currentSignal()?.aborted) throw new CancelledError();
      if (err instanceof UserInputError || err instanceof OzdisanError) throw err;
      throw new OzdisanError(`İndirme yarıda kesildi: ${err instanceof Error ? err.message : String(err)}`, res.status, url);
    }
    if (!header.includes("%PDF")) throw new UserInputError(`Bağlantı bir PDF dosyası döndürmedi: ${url}`);
    if (sink) return { bytes };
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const c of chunks) {
      data.set(c, offset);
      offset += c.byteLength;
    }
    return { bytes, data };
  }

  private readonly downloadsInFlight = new Map<string, Promise<{ path: string; bytes: number; cached: boolean }>>();

  /** Bir PDF'i boyut sınırıyla indirir; aynı geçerli dosya zaten varsa tekrar indirmez. */
  async downloadFile(
    url: string,
    directory: string,
    fileName: string,
    opts: { overwrite?: boolean } = {},
  ): Promise<{ path: string; bytes: number; cached: boolean }> {
    const dir = resolvePath(directory);
    // İndirilen içerik her zaman PDF olarak doğrulanır; uzantı da her zaman .pdf olur.
    const target = join(dir, sanitizeFileName(fileName).replace(/\.[^.]*$/, "") + ".pdf");
    const running = this.downloadsInFlight.get(target);
    if (running) return running;
    const job = (async () => {
      await mkdir(dir, { recursive: true });
      if (!opts.overwrite) {
        const existing = await stat(target).catch(() => undefined);
        if (existing?.isFile() && existing.size > 0 && (await hasPdfHeader(target))) {
          return { path: target, bytes: existing.size, cached: true };
        }
      }
      const { res, finalUrl } = await this.openBinary(url);
      const tmp = join(dir, `.${randomUUID()}.part`);
      const handle = await open(tmp, "wx");
      try {
        const { bytes } = await this.readPdfBody(res, finalUrl, async (chunk) => {
          await handle.write(chunk);
        });
        await handle.close();
        await rename(tmp, target);
        return { path: target, bytes, cached: false };
      } catch (err) {
        await handle.close().catch(() => undefined);
        await rm(tmp, { force: true });
        throw err;
      }
    })();
    this.downloadsInFlight.set(target, job);
    try {
      return await job;
    } finally {
      this.downloadsInFlight.delete(target);
    }
  }

  /** Datasheet'i belleğe indirir (metin çıkarma için). */
  async fetchBinary(url: string): Promise<Uint8Array> {
    return this.binaries.getOrLoad(`bin:${url}`, 30 * MINUTE, async () => {
      const { res, finalUrl } = await this.openBinary(url);
      const { data } = await this.readPdfBody(res, finalUrl);
      return data!;
    });
  }
}

/** Dosyanın ilk baytlarının PDF imzası taşıyıp taşımadığını kontrol eder. */
async function hasPdfHeader(path: string): Promise<boolean> {
  const fh = await open(path, "r").catch(() => undefined);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    return buf.subarray(0, bytesRead).toString("latin1").includes("%PDF");
  } finally {
    await fh.close();
  }
}

/** URI çözümlemesi başarısız olursa ham metni döndürür. */
export function safeDecode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/** Arama sonucu kategori ağacındaki yaprak (alt kategorisi olmayan) düğümleri ürün sayısına göre sıralar. */
export function leafHits(nodes: RawCategoryNode[], path: string[] = []): Array<{ sequenceId: number; name: string; slug: string; count: number; path: string[] }> {
  const out: Array<{ sequenceId: number; name: string; slug: string; count: number; path: string[] }> = [];
  for (const n of nodes) {
    const p = [...path, n.name];
    if (n.subCategories?.length) out.push(...leafHits(n.subCategories, p));
    else if ((n.productCount ?? 0) > 0) out.push({ sequenceId: n.sequenceId, name: n.name, slug: n.slug, count: n.productCount ?? 0, path: p });
  }
  return out.sort((a, b) => b.count - a.count);
}
