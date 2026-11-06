import type { OzdisanClient } from "./api.js";
import type { Currency, Language } from "./config.js";
import type {
  RawListResponse,
  RawListVariant,
  RawProductPage,
  RawRelatedVariant,
  RawVariantPriceResponse,
} from "./types.js";

/** Anlamsız özellik değerleri ("None", "N/A", "-") çıktıya eklenmez. */
export function isMeaningful(value: string | undefined | null): value is string {
  if (value === undefined || value === null) return false;
  const v = value.trim();
  return v !== "" && !/^(none|n\/a|na|-|null|undefined)$/i.test(v);
}

export interface PriceBreak {
  qty: number;
  unit_price: number;
}

/** Fiyat kırılımlarına göre belirli bir adetteki birim fiyatı bulur. */
export function unitPriceAt(breaks: PriceBreak[], quantity: number): PriceBreak | undefined {
  const sorted = [...breaks].sort((a, b) => a.qty - b.qty);
  let chosen: PriceBreak | undefined;
  for (const b of sorted) {
    if (quantity >= b.qty) chosen = b;
  }
  return chosen;
}

/** Sipariş adedini minimum sipariş ve katsayı kurallarına göre yukarı yuvarlar. */
export function orderableQuantity(quantity: number, moq = 1, multiple = 1): number {
  const m = Math.max(1, multiple || 1);
  let q = Math.max(quantity, moq || 1);
  if (q % m !== 0) q = Math.ceil(q / m) * m;
  return q;
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Nesnedeki undefined/null/boş dizi/boş nesne alanlarını temizler (token tasarrufu). */
export function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => clean(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw === undefined || raw === null) continue;
      const v = clean(raw);
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
      out[k] = v;
    }
    return out as T;
  }
  return value;
}

export interface ProductSummary {
  product: string;
  part_number: string;
  manufacturer?: string;
  description?: string;
  stock: number;
  upcoming_stock?: number;
  moq?: number;
  order_multiple?: number;
  mpq?: number;
  currency?: string;
  price_breaks?: PriceBreak[];
  price_on_request?: boolean;
  unit_price_for_quantity?: number;
  rohs?: boolean;
  package?: string;
  specs?: Record<string, string>;
  has_datasheet?: boolean;
  url: string;
  image?: string;
}

/** Liste yanıtındaki özellik kimliklerini istenen dildeki adlara eşler. */
export function propertyNameMap(res: Pick<RawListResponse, "propertyFilters" | "tableProperties">): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of res.tableProperties ?? []) map.set(p.propertyId, p.name);
  for (const p of res.propertyFilters ?? []) if (!map.has(p.propertyId)) map.set(p.propertyId, p.name);
  return map;
}

export function summarizeListVariant(
  v: RawListVariant,
  ctx: {
    client: OzdisanClient;
    lang: Language;
    currency: Currency;
    names?: Map<string, string>;
    includeSpecs?: boolean;
    quantity?: number;
  },
): ProductSummary {
  const avail = v.availability ?? {};
  const prices = (v.prices ?? []).map((p) => ({ qty: p.breakQuantity, unit_price: round(p.price, 5) }));
  const showPrice = avail.isShowPrice !== false && prices.length > 0;
  let specs: Record<string, string> | undefined;
  if (ctx.includeSpecs !== false) {
    specs = {};
    for (const p of v.properties ?? []) {
      if (!isMeaningful(p.value)) continue;
      const name = ctx.names?.get(p.id) ?? p.key;
      specs[name] = p.value.trim();
    }
  }
  const summary: ProductSummary = {
    product: v.erpRefId,
    part_number: v.sku,
    manufacturer: v.manufacturer?.name,
    description: v.description?.trim(),
    stock: avail.totalStock ?? 0,
    upcoming_stock: v.upcomingStock || undefined,
    moq: avail.minimumOrderQuantity,
    order_multiple: avail.orderQuantityMultiplier && avail.orderQuantityMultiplier > 1 ? avail.orderQuantityMultiplier : undefined,
    mpq: avail.mpq,
    currency: showPrice ? (v.prices?.[0]?.currencyCode ?? ctx.currency) : undefined,
    price_breaks: showPrice ? prices : undefined,
    price_on_request: showPrice ? undefined : true,
    rohs: v.isRohs,
    package: v.variantPackageType,
    specs,
    has_datasheet: !!v.medias?.pdfPath,
    url: ctx.client.productUrl(v.fullPath, ctx.lang, v.erpRefId),
    image: v.medias?.imagePath,
  };
  if (ctx.quantity && showPrice) {
    const at = unitPriceAt(prices, ctx.quantity);
    if (at) summary.unit_price_for_quantity = at.unit_price;
  }
  return clean(summary);
}

export function summarizeRelatedVariant(
  v: RawRelatedVariant,
  ctx: { client: OzdisanClient; lang: Language; currency: Currency },
): ProductSummary {
  const avail = v.availability ?? {};
  const prices = (v.prices ?? []).map((p) => ({ qty: p.breakQuantity, unit_price: round(p.price, 5) }));
  const showPrice = avail.isShowPrice !== false && prices.length > 0;
  return clean({
    product: v.erpRefId,
    part_number: v.sku,
    manufacturer: v.manufacturer?.name,
    description: v.description?.trim(),
    stock: avail.totalStock ?? 0,
    moq: avail.minimumOrderQuantity,
    mpq: avail.mpq,
    currency: showPrice ? (v.prices?.[0]?.currencyCode ?? ctx.currency) : undefined,
    price_breaks: showPrice ? prices : undefined,
    price_on_request: showPrice ? undefined : true,
    rohs: v.isRohs,
    has_datasheet: !!v.medias?.some((m) => m.field === "Datasheet"),
    url: ctx.client.productUrl(v.fullPath, ctx.lang, v.erpRefId),
  });
}

/** Fiyat API yanıtından istenen para birimindeki kırılımları çıkarır. */
export function priceBreaksFrom(
  res: RawVariantPriceResponse | undefined,
  currency: Currency,
): { packaging?: string; breaks: PriceBreak[]; breaks_with_vat: PriceBreak[] } | undefined {
  const pkg = res?.data?.packages?.[0];
  if (!pkg) return undefined;
  const breaks: PriceBreak[] = [];
  const withVat: PriceBreak[] = [];
  for (const b of pkg.priceBreaks ?? []) {
    const p = b.prices.find((x) => x.currency === currency);
    if (!p) continue;
    breaks.push({ qty: b.breakQuantity, unit_price: round(p.price, 5) });
    if (typeof p.extendedPrice === "number" && typeof p.totalPrice === "number" && p.totalPrice > 0) {
      withVat.push({ qty: b.breakQuantity, unit_price: round((p.price * p.extendedPrice) / p.totalPrice, 5) });
    }
  }
  if (!breaks.length) return undefined;
  return { packaging: pkg.packaging, breaks, breaks_with_vat: withVat };
}

export interface ProductDetail {
  product: string;
  part_number: string;
  manufacturer?: string;
  description?: string;
  detailed_description?: string;
  status?: string;
  rohs?: boolean;
  category?: { name: string; category: string; path: string[] };
  stock: number;
  upcoming_stock?: number;
  lead_time?: string;
  moq?: number;
  order_multiple?: number;
  mpq?: number;
  package?: string;
  pricing: Record<string, unknown>;
  /** Anlamlı özelliği olmayan ürünlerde bulunmaz. */
  specs?: Record<string, string>;
  datasheet_url?: string;
  datasheet_file?: string;
  image?: string;
  other_media?: Array<{ type: string; url: string }>;
  tags?: string[];
  url: string;
}

export function buildProductDetail(
  page: RawProductPage & { url: string },
  extras: {
    client: OzdisanClient;
    lang: Language;
    currency: Currency;
    prices?: RawVariantPriceResponse;
    datasheet?: { url: string; fileName: string };
    /** Fiyat sorgusu geçici olarak başarısız olduysa true (ürün "teklif gerekli" diye gösterilmez). */
    priceUnavailable?: boolean;
  },
): ProductDetail {
  const d = page.data;
  const avail = d.availability ?? {};
  const mainCat = d.categories?.find((c) => c.isMain) ?? d.categories?.[0];
  const specs: Record<string, string> = {};
  for (const p of d.properties ?? []) if (isMeaningful(p.value)) specs[p.name] = p.value.trim();

  const priceRes = extras.prices ?? page.initialPrice?.response;
  const priced = avail.isShowPrice !== false ? priceBreaksFrom(priceRes, extras.currency) : undefined;
  const pricing: Record<string, unknown> = extras.priceUnavailable
    ? { currency: extras.currency, price_unavailable: true, note: "Fiyat bilgisi şu an alınamadı (geçici hata); biraz sonra tekrar deneyin." }
    : priced
    ? {
        currency: extras.currency,
        vat_included: false,
        price_breaks: priced.breaks,
        note: "Fiyatlar KDV hariç birim fiyatlardır; liste fiyatıdır, kurumsal (B2B) fiyatlar farklı olabilir.",
      }
    : { price_on_request: true, note: "Bu ürün için fiyat sitede gösterilmiyor; Özdisan'dan teklif isteyin." };

  const media = d.medias ?? [];
  const image = media.find((m) => m.field === "Picture")?.path;
  const others = media
    .filter((m) => m.field !== "Picture" && m.field !== "Datasheet")
    .map((m) => ({ type: m.field, url: extras.client.absoluteMediaUrl(m.path) ?? m.path }));
  const tags = (d.tags ?? [])
    .map((t) => (typeof t === "string" ? t : t.name))
    .filter((t): t is string => !!t);

  return clean({
    product: d.erpRefId,
    part_number: d.sku,
    manufacturer: d.manufacturer?.name,
    description: d.description?.trim(),
    detailed_description:
      d.detailedDescription && d.detailedDescription.trim() !== d.manufacturer?.name ? d.detailedDescription.trim() : undefined,
    status: d.productStatus,
    rohs: d.isRohs,
    category: mainCat
      ? { name: mainCat.name, category: mainCat.slug, path: (page.breadcrumbData ?? []).map((b) => b.name) }
      : undefined,
    stock: avail.totalStock ?? 0,
    upcoming_stock: d.upcomingStock || undefined,
    lead_time: d.leadTime || undefined,
    moq: avail.minimumOrderQuantity,
    order_multiple: avail.orderQuantityMultiplier && avail.orderQuantityMultiplier > 1 ? avail.orderQuantityMultiplier : undefined,
    mpq: avail.mpq,
    package: d.variantPackageType,
    pricing,
    specs,
    datasheet_url: extras.datasheet?.url,
    datasheet_file: extras.datasheet?.fileName,
    image: extras.client.absoluteMediaUrl(image),
    other_media: others,
    tags,
    url: page.url,
  });
}
