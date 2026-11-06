import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { leafHits, trailingId, type CategoryEntry, type OzdisanClient, type ResolvedProduct } from "../api.js";
import type { Currency, Language } from "../config.js";
import { findProperty, resolveFilters, type RangeFilterSpec, type ValueFilterSpec } from "../filters.js";
import { CancelledError, UserInputError } from "../http.js";
import {
  buildProductDetail,
  orderableQuantity,
  propertyNameMap,
  round,
  summarizeListVariant,
  summarizeRelatedVariant,
  unitPriceAt,
  type ProductDetail,
} from "../normalize.js";
import { compact } from "../text.js";
import type { RawListResponse, RawPropertyFilter, RawVariantPriceResponse } from "../types.js";
import { filterSpecSchema, rangeSpecSchema } from "./categories.js";
import {
  categoryInputSchema,
  currencySchema,
  handle,
  languageSchema,
  mapLimit,
  productInputSchema,
  readOnlyAnnotations,
  reportProgress,
  type ToolContext,
} from "./shared.js";

const SORT_KEYS: Record<string, { key: string; isProp: boolean }> = {
  price: { key: "price", isProp: false },
  fiyat: { key: "price", isProp: false },
  stock: { key: "stockQuantity", isProp: false },
  stok: { key: "stockQuantity", isProp: false },
  manufacturer: { key: "manufacturer", isProp: false },
  uretici: { key: "manufacturer", isProp: false },
  moq: { key: "minimumOrderQuantity", isProp: false },
  multiple: { key: "orderQuantityMultiplier", isProp: false },
  status: { key: "productStatus", isProp: true },
  package_type: { key: "packagingType", isProp: true },
};

const sortSchema = z
  .object({
    by: z
      .string()
      .describe("'price', 'stock', 'manufacturer', 'moq' or a sortable property name from get_category_filters (e.g. 'Kapasitans')."),
    order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: asc for price, desc for stock)."),
  })
  .describe("Sorting. Default is the site's default order (usually highest stock first).");

/** Ürün kodu çözümlemesi + detay sayfası + (gerekirse) fiyat + datasheet adresi. */
export async function loadProductDetail(
  client: OzdisanClient,
  input: string,
  lang: Language,
  currency: Currency,
  opts: { datasheet?: boolean } = {},
): Promise<{ detail: ProductDetail; variantId: string; mainCategoryId?: string; otherMatches: ResolvedProduct["otherMatches"] }> {
  const { page, otherMatches } = await client.loadProduct(input, lang);
  const d = page.data;
  const initialHasCurrency = page.initialPrice?.response?.data?.packages?.[0]?.priceBreaks?.[0]?.prices?.some(
    (p) => p.currency === currency,
  );
  let prices: RawVariantPriceResponse | undefined;
  let priceUnavailable = false;
  if (d.availability?.isShowPrice !== false && !initialHasCurrency) {
    // Fiyat sorgusu başarısız olursa ürünü "teklif gerekli" diye göstermek yanlış olur; ayrı bildirilir.
    prices = await client.getVariantPrices(d.id, currency).catch((err) => {
      if (err instanceof CancelledError) throw err;
      priceUnavailable = true;
      return undefined;
    });
  }
  const dsMedia = d.medias?.find((m) => m.field === "Datasheet")?.path;
  const datasheet =
    opts.datasheet !== false && dsMedia ? await client.resolveDatasheetUrl(d.sku, dsMedia).catch(() => undefined) : undefined;
  const detail = buildProductDetail(page, { client, lang, currency, prices, datasheet, priceUnavailable });
  return {
    detail,
    variantId: d.id,
    mainCategoryId: (d.categories?.find((c) => c.isMain) ?? d.categories?.[0])?.id,
    otherMatches,
  };
}

const RELATION_LABELS: Record<string, string> = {
  Substitute: "substitutes",
  Similar: "similar",
  Concomitant: "accessories",
  Parametric: "parametric_matches",
};

async function loadAlternatives(
  client: OzdisanClient,
  variantId: string,
  mainCategoryId: string | undefined,
  lang: Language,
  currency: Currency,
  types: string[],
  limit: number,
) {
  const wantRelations = types.some((t) => t !== "parametric");
  let failed = false;
  const soft = <T>(p: Promise<T>) =>
    p.catch((err) => {
      if (err instanceof CancelledError) throw err;
      failed = true;
      return undefined;
    });
  const [rel, param] = await Promise.all([
    wantRelations ? soft(client.getRelations(variantId, currency, lang)) : undefined,
    types.includes("parametric") && mainCategoryId
      ? soft(client.getParametricAlternatives(variantId, mainCategoryId, currency, lang))
      : undefined,
  ]);
  const groups: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const typeKey: Record<string, string> = { substitute: "Substitute", similar: "Similar", accessory: "Concomitant" };
  const wanted = new Set(types.map((t) => typeKey[t]).filter(Boolean));
  for (const r of rel?.relations ?? []) {
    if (!wanted.has(r.relationType)) continue;
    const label = RELATION_LABELS[r.relationType] ?? r.relationType;
    groups[label] ??= [];
    counts[label] = (counts[label] ?? 0) + 1;
    if (groups[label]!.length < limit) groups[label]!.push(summarizeRelatedVariant(r.relatedVariant, { client, lang, currency }));
  }
  if (param?.data?.relations?.length) {
    const label = RELATION_LABELS.Parametric!;
    counts[label] = param.data.totalCount ?? param.data.relations.length;
    groups[label] = param.data.relations
      .slice(0, limit)
      .map((r) => summarizeRelatedVariant(r.relatedVariant, { client, lang, currency }));
  }
  return { groups, counts, failed };
}

/** Kullanıcının verdiği özellik adlarını, gerekirse diğer dildeki adlarla da arayarak kimliğe çevirir. */
async function normalizePropertyNames<T extends { property: string }>(
  client: OzdisanClient,
  sequenceId: number,
  primary: RawPropertyFilter[],
  lang: Language,
  specs: T[] | undefined,
): Promise<T[] | undefined> {
  if (!specs?.length) return specs;
  let otherProps: RawPropertyFilter[] | undefined;
  const out: T[] = [];
  for (const spec of specs) {
    if (findProperty(primary, spec.property)) {
      out.push(spec);
      continue;
    }
    otherProps ??= (await client.getCategoryMeta(sequenceId, lang === "tr" ? "en" : "tr").catch(() => undefined))?.propertyFilters ?? [];
    const alt = findProperty(otherProps, spec.property);
    out.push(alt ? { ...spec, property: alt.propertyId } : spec);
  }
  return out;
}

function resolveSort(
  sort: { by: string; order?: "asc" | "desc" } | undefined,
  props: RawPropertyFilter[],
  meta: RawListResponse,
): { key: string; isProp: boolean; isDesc: boolean } | undefined {
  if (!sort) return undefined;
  const k = compact(sort.by);
  const fixed = SORT_KEYS[k] ?? SORT_KEYS[sort.by.toLowerCase()];
  if (fixed) return { ...fixed, isDesc: sort.order ? sort.order === "desc" : fixed.key === "stockQuantity" };
  const prop = findProperty(props, sort.by);
  if (!prop || prop.propertyId === "Manufacturer") {
    if (prop?.propertyId === "Manufacturer") return { key: "manufacturer", isProp: false, isDesc: sort.order === "desc" };
    throw new UserInputError(`"${sort.by}" ile sıralama yapılamıyor.`, {
      sort_options: ["price", "stock", "manufacturer", "moq", ...sortablePropertyNames(meta)],
    });
  }
  return { key: prop.propertyId, isProp: true, isDesc: sort.order === "desc" };
}

/** Kategoride sıralanabilir teknik özelliklerin adları. */
export function sortablePropertyNames(meta: Pick<RawListResponse, "tableProperties">): string[] {
  return (meta.tableProperties ?? []).filter((t) => t.isSortable && t.propertyId !== "Tags").map((t) => t.name);
}

function listResult(
  res: RawListResponse,
  ctx: { client: OzdisanClient; lang: Language; currency: Currency; includeSpecs?: boolean; quantity?: number },
) {
  const names = propertyNameMap(res);
  return res.variantList.data.map((v) =>
    summarizeListVariant(v, { client: ctx.client, lang: ctx.lang, currency: ctx.currency, names, includeSpecs: ctx.includeSpecs, quantity: ctx.quantity }),
  );
}

function categoryOut(e: CategoryEntry) {
  return { category: e.slug, name: e.name, path: e.path.join(" > ") };
}

export function registerProductTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;

  // ------------------------------------------------------------------ search_products
  server.registerTool(
    "search_products",
    {
      title: "Ürün ara",
      description:
        "Keyword / part-number search across all ~1M Özdisan products (e.g. 'STM32F103', 'LM317', 'NE555', '10uF 0805', 'ESP32'). " +
        "Returns how many matches each category has, the best matching products with stock, starting price (VAT excluded) and key specs, " +
        "and quick matches from other categories. Pass 'category' to search only inside one category. " +
        "For parametric selection (e.g. 'LDO 3.3V 500mA SOT-23') prefer search_categories → get_category_filters → filter_products.",
      inputSchema: {
        query: z.string().min(1).describe("Part number, partial part number or keywords."),
        category: categoryInputSchema.optional(),
        in_stock: z.boolean().optional().describe("Only products in stock."),
        page_size: z.number().int().min(1).max(50).optional().describe("Number of detailed products to return (default 10)."),
        include_specs: z.boolean().optional().describe("Include technical specs for each product (default true)."),
        currency: currencySchema,
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async ({ query, category, in_stock, page_size, include_specs, currency, language }) => {
      const lang = client.lang(language);
      const cur = client.currency(currency);
      const pageSize = page_size ?? 10;
      const filterOptions = in_stock ? [{ code: "stockingOptions", value: "InStock" }] : undefined;

      if (category) {
        const entry = await client.resolveCategory(category, lang);
        const res = await client.listProducts(entry.sequenceId, { search: query, pageSize, currency: cur, filterOptions }, lang);
        return {
          query,
          category: categoryOut(entry),
          total_matches: res.variantList.totalCount,
          products: listResult(res, { client, lang, currency: cur, includeSpecs: include_specs }),
          more: res.variantList.totalCount > pageSize ? "Use filter_products with query + page to see more or to filter further." : undefined,
        };
      }

      const [quick, tree] = await Promise.all([
        client.quickSearch(query, lang).catch(() => undefined),
        client.searchCategoryTree({ search: query, filterOptions }, lang).catch(() => undefined),
      ]);
      const leaves = tree ? leafHits(tree.categories) : [];
      const top = leaves[0];
      let products: unknown[] = [];
      let topSeq: number | undefined;
      if (top) {
        topSeq = top.sequenceId;
        const res = await client.listProducts(top.sequenceId, { search: query, pageSize, currency: cur, filterOptions }, lang);
        products = listResult(res, { client, lang, currency: cur, includeSpecs: include_specs });
      }
      const exactId = tree?.redirectVariantUrl ? trailingId(tree.redirectVariantUrl) : undefined;
      const shown = new Set((products as Array<{ product: string }>).map((p) => p.product));
      const quickMatches = (quick?.variants ?? [])
        .filter((v) => !shown.has(trailingId(v.slug) ?? ""))
        .filter((v) => (topSeq === undefined ? true : !v.category?.slug?.endsWith(`-${topSeq}`)))
        .slice(0, 15)
        .map((v) => ({
          product: trailingId(v.slug),
          part_number: v.sku,
          description: v.description?.trim(),
          category: v.category?.slug,
          url: client.quickVariantUrl(v, lang),
        }));

      if (!leaves.length && !quickMatches.length) {
        return {
          query,
          total_matches: 0,
          message:
            "Hiç ürün bulunamadı. Daha kısa bir parça numarası, farklı bir yazım ya da İngilizce/Türkçe eşanlamlı deneyin; " +
            "parametrik arama için search_categories kullanın.",
        };
      }
      const noStockMatch = in_stock && !leaves.length;
      return {
        query,
        total_matches: tree?.totalCount ?? quickMatches.length,
        exact_match_product: exactId,
        categories: leaves.slice(0, 12).map((l) => ({ category: l.slug, name: l.name, path: l.path.join(" > "), matches: l.count })),
        products_from_category: top ? { category: top.slug, name: top.name, matches: top.count } : undefined,
        products,
        other_quick_matches: quickMatches,
        note: noStockMatch
          ? "Stokta eşleşen ürün yok. 'other_quick_matches' stok filtresi uygulanmadan bulunan eşleşmelerdir (stokta olmayabilir); " +
            "stoktaki muadiller için get_alternatives kullanın."
          : quickMatches.length
            ? "'other_quick_matches' entries are fuzzy matches without stock/price info; use get_product for details."
            : undefined,
        hint:
          leaves.length > 1
            ? "Matches span several categories. Call search_products again with 'category' or use filter_products to narrow down."
            : undefined,
      };
    }),
  );

  // ------------------------------------------------------------------ filter_products
  server.registerTool(
    "filter_products",
    {
      title: "Parametrik ürün filtrele",
      description:
        "Parametric product search inside a category, like the filter panel on ozdisan.com. Combine property filters " +
        "(exact option values from get_category_filters), numeric ranges with units, manufacturers, stock/RoHS/datasheet flags, " +
        "keyword, sorting and pagination. Returns products with stock, MOQ, the price break(s) relevant to 'quantity' " +
        "(VAT excluded; get_product returns the full price table) and specs. " +
        "Multiple values for the same property are OR'ed; different properties are AND'ed.",
      inputSchema: {
        category: categoryInputSchema,
        query: z.string().optional().describe("Optional keyword / part number filter inside the category."),
        filters: z.array(filterSpecSchema).optional(),
        ranges: z.array(rangeSpecSchema).optional(),
        manufacturers: z.array(z.string()).optional().describe("Manufacturer names as listed in get_category_filters (e.g. ['STM', 'TEXAS'])."),
        in_stock: z.boolean().optional().describe("Only products in stock."),
        has_upcoming_stock: z.boolean().optional().describe("Only products with incoming stock."),
        rohs: z.boolean().optional().describe("true: only RoHS compliant, false: only non-RoHS."),
        has_datasheet: z.boolean().optional().describe("Only products that have a datasheet."),
        discounted: z.boolean().optional().describe("Only discounted / campaign products."),
        sort: sortSchema.optional(),
        quantity: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Planned order quantity; adds 'unit_price_for_quantity' using the price breaks."),
        page: z.number().int().min(1).optional().describe("Page number (default 1)."),
        page_size: z.number().int().min(1).max(100).optional().describe("Products per page (default 20, max 100)."),
        include_specs: z.boolean().optional().describe("Include technical specs per product (default true)."),
        currency: currencySchema,
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async (args) => {
      const lang = client.lang(args.language);
      const cur = client.currency(args.currency);
      const entry = await client.resolveCategory(args.category, lang);
      const meta = await client.getCategoryMeta(entry.sequenceId, lang);
      const props = meta.propertyFilters ?? [];
      if (!props.length && (args.filters?.length || args.ranges?.length)) {
        throw new UserInputError(`"${entry.name}" kategorisinde filtrelenebilir özellik yok; daha alt bir kategori seçin.`);
      }
      const filters = await normalizePropertyNames<ValueFilterSpec>(client, entry.sequenceId, props, lang, args.filters);
      const ranges = await normalizePropertyNames<RangeFilterSpec>(client, entry.sequenceId, props, lang, args.ranges);
      const resolved = resolveFilters(meta, {
        filters,
        ranges,
        manufacturers: args.manufacturers,
        flags: {
          in_stock: args.in_stock,
          has_upcoming_stock: args.has_upcoming_stock,
          rohs: args.rohs,
          has_datasheet: args.has_datasheet,
          discounted: args.discounted,
        },
      });
      // Sabit anahtarlar (price, stock...) önce denenir; yalnızca özellik adları dil eşlemesinden geçer.
      const isFixedSort = !!args.sort && !!(SORT_KEYS[compact(args.sort.by)] ?? SORT_KEYS[args.sort.by.toLowerCase()]);
      const sortSpec = args.sort
        ? isFixedSort
          ? { ...args.sort, property: args.sort.by }
          : (await normalizePropertyNames(client, entry.sequenceId, props, lang, [{ ...args.sort, property: args.sort.by }]))?.[0]
        : undefined;
      const sort = resolveSort(sortSpec ? { by: sortSpec.property, order: sortSpec.order } : undefined, props, meta);
      const pageSize = args.page_size ?? 20;
      const res = await client.listProducts(
        entry.sequenceId,
        {
          page: args.page ?? 1,
          pageSize,
          search: args.query,
          currency: cur,
          sort,
          pricingQuantity: args.quantity,
          valueFilters: resolved.valueFilters,
          numericValueFilters: resolved.numericValueFilters,
          filterOptions: resolved.filterOptions,
        },
        lang,
      );
      const vl = res.variantList;
      return {
        category: { ...categoryOut(entry), url: client.categoryUrl(entry.slug, lang) },
        applied_filters: [...(args.query ? [`Arama: ${args.query}`] : []), ...resolved.applied],
        sort: args.sort,
        total_matches: vl.totalCount,
        page: vl.pageNumber,
        total_pages: vl.totalPages,
        currency: cur,
        products: listResult(res, { client, lang, currency: cur, includeSpecs: args.include_specs, quantity: args.quantity }),
        note:
          vl.totalCount === 0
            ? "Hiç ürün eşleşmedi. Filtreleri gevşetin; get_category_filters'a mevcut filtreleri vererek hâlâ seçilebilir değerleri görebilirsiniz."
            : vl.pageNumber < vl.totalPages
              ? `More results: page=${vl.pageNumber + 1}.`
              : undefined,
      };
    }),
  );

  // ------------------------------------------------------------------ get_product
  server.registerTool(
    "get_product",
    {
      title: "Ürün detayı",
      description:
        "Full details of one product: manufacturer, part number, description, lifecycle status, RoHS, category path, all technical " +
        "specs, stock, incoming stock, lead time, MOQ / order multiple / MPQ, quantity price breaks (VAT excluded), datasheet URL, " +
        "image and product page URL. Optionally includes substitutes / similar products / accessories.",
      inputSchema: {
        product: productInputSchema,
        include_alternatives: z.boolean().optional().describe("Also return substitute, similar and accessory products (default false)."),
        currency: currencySchema,
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async ({ product, include_alternatives, currency, language }) => {
      const lang = client.lang(language);
      const cur = client.currency(currency);
      const loaded = await loadProductDetail(client, product, lang, cur);
      let alternatives;
      if (include_alternatives) {
        alternatives = await loadAlternatives(client, loaded.variantId, loaded.mainCategoryId, lang, cur, ["substitute", "similar", "accessory"], 5);
      }
      return {
        ...loaded.detail,
        alternatives: alternatives?.groups,
        alternative_counts: alternatives?.counts,
        alternatives_note: alternatives?.failed ? "Muadil bilgisi alınamadı (geçici hata)." : undefined,
        other_products_with_same_part_number: loaded.otherMatches,
      };
    }),
  );

  // ------------------------------------------------------------------ get_alternatives
  server.registerTool(
    "get_alternatives",
    {
      title: "Muadil / benzer ürünler",
      description:
        "Find replacement options for a product: 'substitute' (drop-in equivalents / muadil), 'similar' (benzer), " +
        "'accessory' (complementary products), and 'parametric' (other products in the same category with the same key specs). " +
        "Useful when a part is out of stock, end-of-life or too expensive.",
      inputSchema: {
        product: productInputSchema,
        types: z
          .array(z.enum(["substitute", "similar", "accessory", "parametric"]))
          .optional()
          .describe("Which relation types to return (default: all)."),
        limit: z.number().int().min(1).max(50).optional().describe("Max products per relation type (default 10)."),
        currency: currencySchema,
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async ({ product, types, limit, currency, language }) => {
      const lang = client.lang(language);
      const cur = client.currency(currency);
      const { page } = await client.loadProduct(product, lang);
      const d = page.data;
      const mainCat = (d.categories?.find((c) => c.isMain) ?? d.categories?.[0])?.id;
      const wanted = types?.length ? types : ["substitute", "similar", "accessory", "parametric"];
      const { groups, counts, failed } = await loadAlternatives(client, d.id, mainCat, lang, cur, wanted, limit ?? 10);
      const empty = Object.keys(groups).length === 0;
      return {
        product: d.erpRefId,
        part_number: d.sku,
        manufacturer: d.manufacturer?.name,
        stock: d.availability?.totalStock ?? 0,
        counts,
        ...groups,
        note:
          empty && failed
            ? "Muadil bilgisi şu an alınamadı (Özdisan geçici olarak yanıt vermedi). Biraz sonra tekrar deneyin."
            : empty
              ? "Özdisan bu ürün için tanımlı muadil/benzer ürün listelemiyor. Aynı kategoride filter_products ile benzer özellikte ürün arayabilirsiniz."
              : failed
                ? "Bazı muadil listeleri alınamadı; sonuç eksik olabilir."
                : undefined,
      };
    }),
  );

  // ------------------------------------------------------------------ compare_products
  server.registerTool(
    "compare_products",
    {
      title: "Ürünleri karşılaştır",
      description:
        "Compare 2-10 products side by side: specs aligned by property (with the properties that differ highlighted), " +
        "stock, MOQ, lead time and price at a given quantity.",
      inputSchema: {
        products: z.array(productInputSchema).min(2).max(10).describe("Products to compare (product codes, URLs or part numbers)."),
        quantity: z.number().int().min(1).optional().describe("Quantity used to pick the unit price (default 1)."),
        currency: currencySchema,
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async ({ products, quantity, currency, language }, extra) => {
      const lang = client.lang(language);
      const cur = client.currency(currency);
      const qty = quantity ?? 1;
      const loaded = await mapLimit(
        products,
        3,
        async (p) => {
          try {
            return { input: p, detail: (await loadProductDetail(client, p, lang, cur, { datasheet: true })).detail };
          } catch (err) {
            if (err instanceof CancelledError) throw err;
            return { input: p, error: err instanceof Error ? err.message : String(err) };
          }
        },
        (done, total) => reportProgress(extra, done, total),
      );
      const seen = new Set<string>();
      const duplicates: string[] = [];
      const found = loaded
        .filter((l): l is { input: string; detail: ProductDetail } => "detail" in l && !!l.detail)
        .filter((l) => {
          if (seen.has(l.detail.product)) {
            duplicates.push(l.input);
            return false;
          }
          seen.add(l.detail.product);
          return true;
        });
      const specNames: string[] = [];
      for (const f of found) for (const k of Object.keys(f.detail.specs ?? {})) if (!specNames.includes(k)) specNames.push(k);
      const specs: Record<string, Array<string | null>> = {};
      const differing: string[] = [];
      for (const name of specNames) {
        const row = found.map((f) => f.detail.specs?.[name] ?? null);
        specs[name] = row;
        if (new Set(row.map((v) => v ?? "")).size > 1) differing.push(name);
      }
      return {
        columns: found.map((f) => {
          const breaks = (f.detail.pricing.price_breaks as Array<{ qty: number; unit_price: number }> | undefined) ?? [];
          const orderQty = orderableQuantity(qty, f.detail.moq, f.detail.order_multiple);
          const at = unitPriceAt(breaks, orderQty);
          return {
            product: f.detail.product,
            part_number: f.detail.part_number,
            manufacturer: f.detail.manufacturer,
            description: f.detail.description,
            category: f.detail.category?.name,
            status: f.detail.status,
            stock: f.detail.stock,
            lead_time: f.detail.lead_time,
            moq: f.detail.moq,
            unit_price: at ? at.unit_price : undefined,
            price_on_request: breaks.length ? undefined : true,
            datasheet_url: f.detail.datasheet_url,
            url: f.detail.url,
          };
        }),
        currency: cur,
        quantity: qty,
        specs,
        differing_specs: differing,
        not_found: loaded.filter((l) => "error" in l).map((l) => ({ input: l.input, error: (l as { error: string }).error })),
        duplicates_skipped: duplicates,
      };
    }),
  );

  // ------------------------------------------------------------------ check_bom
  server.registerTool(
    "check_bom",
    {
      title: "BOM (malzeme listesi) kontrolü",
      description:
        "Check a bill of materials against Özdisan: for each line resolves the part, applies MOQ / order multiple, picks the " +
        "price break for the quantity, checks stock (and lead time when stock is short), flags end-of-life or price-on-request " +
        "parts and returns line totals plus the BOM total (VAT excluded). Up to 60 lines per call (about 1 s per line); " +
        "split larger BOMs into several calls.",
      inputSchema: {
        items: z
          .array(
            z.object({
              part: productInputSchema,
              quantity: z.number().int().min(1).describe("Required quantity."),
              reference: z.string().optional().describe("Optional designator / note (e.g. 'U1', 'R1-R8')."),
            }),
          )
          .min(1)
          .max(60),
        boards: z.number().int().min(1).optional().describe("Multiply every quantity by this number of boards (default 1)."),
        currency: currencySchema,
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async ({ items, boards, currency, language }, extra) => {
      const lang = client.lang(language);
      const cur = client.currency(currency);
      const multiplier = boards ?? 1;
      const lines = await mapLimit(items, 3, async (item) => {
        const needed = item.quantity * multiplier;
        try {
          const { detail, otherMatches } = await loadProductDetail(client, item.part, lang, cur, { datasheet: false });
          const breaks = (detail.pricing.price_breaks as Array<{ qty: number; unit_price: number }> | undefined) ?? [];
          let orderQty = orderableQuantity(needed, detail.moq, detail.order_multiple);
          let at = unitPriceAt(breaks, orderQty);
          const issues: string[] = [];
          if (!at && breaks.length) {
            // Sitedeki fiyat tablosu istenen adetten büyük bir kırılımla başlıyor.
            const first = [...breaks].sort((a, b) => a.qty - b.qty)[0]!;
            orderQty = orderableQuantity(Math.max(orderQty, first.qty), detail.moq, detail.order_multiple);
            at = unitPriceAt(breaks, orderQty) ?? first;
            issues.push(`Fiyat ${first.qty} adetten başlıyor; ${orderQty} adet üzerinden hesaplandı`);
          }
          if (detail.stock < orderQty) {
            issues.push(
              detail.stock === 0
                ? `Stokta yok${detail.lead_time ? ` (tedarik süresi: ${detail.lead_time})` : ""}`
                : `Stok yetersiz: ${detail.stock} adet var${detail.lead_time ? `, kalanı için tedarik süresi ${detail.lead_time}` : ""}`,
            );
          }
          if (orderQty > needed && !issues.some((i) => i.startsWith("Fiyat "))) issues.push(`MOQ/katsayı nedeniyle ${orderQty} adet sipariş edilmeli`);
          if (detail.status && !/^active$/i.test(detail.status) && detail.status !== "-") issues.push(`Ürün durumu: ${detail.status}`);
          if (detail.pricing.price_unavailable) issues.push("Fiyat bilgisi şu an alınamadı (geçici hata)");
          else if (!breaks.length) issues.push("Fiyat sitede yok, teklif gerekli");
          const otherListings = detail.stock < orderQty && otherMatches.length ? otherMatches.map((m) => m.erpRefId) : undefined;
          if (otherListings) issues.push(`Aynı parça numarasıyla ${otherListings.length} başka ilan var (other_listings)`);
          return {
            reference: item.reference,
            input: item.part,
            product: detail.product,
            part_number: detail.part_number,
            manufacturer: detail.manufacturer,
            description: detail.description,
            required_qty: needed,
            order_qty: orderQty,
            stock: detail.stock,
            unit_price: at?.unit_price,
            line_total: at ? round(at.unit_price * orderQty, 2) : undefined,
            status: issues.length ? "warning" : "ok",
            issues,
            other_listings: otherListings,
            url: detail.url,
          };
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          const details = err instanceof UserInputError ? (err.details as { suggestions?: unknown } | undefined) : undefined;
          return {
            reference: item.reference,
            input: item.part,
            required_qty: needed,
            status: "not_found",
            issues: [err instanceof Error ? err.message : String(err)],
            suggestions: details?.suggestions,
          };
        }
      }, (done, total) => reportProgress(extra, done, total, `${done}/${total} kalem kontrol edildi`));
      const total = lines.reduce((s, l) => s + (("line_total" in l && l.line_total) || 0), 0);
      return {
        currency: cur,
        boards: multiplier,
        total_excl_vat: round(total, 2),
        summary: {
          lines: lines.length,
          ok: lines.filter((l) => l.status === "ok").length,
          warnings: lines.filter((l) => l.status === "warning").length,
          not_found: lines.filter((l) => l.status === "not_found").length,
          priced_lines: lines.filter((l) => "line_total" in l && l.line_total !== undefined).length,
        },
        lines,
        note: "Toplam yalnızca fiyatı görünen kalemleri içerir; fiyatlar KDV hariç liste fiyatlarıdır.",
      };
    }),
  );
}
