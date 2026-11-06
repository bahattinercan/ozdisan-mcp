import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { leafHits, type CategoryEntry, type CategoryIndex } from "../api.js";
import type { Language } from "../config.js";
import { findProperty, isNumericProperty, propertyUnits, resolveFilters } from "../filters.js";
import { UserInputError } from "../http.js";
import { compact, fold } from "../text.js";
import type { RawCategoryNode, RawPropertyFilter } from "../types.js";
import {
  categoryInputSchema,
  handle,
  languageSchema,
  readOnlyAnnotations,
  type ToolContext,
} from "./shared.js";

export const filterSpecSchema = z.object({
  property: z
    .string()
    .describe("Property name (Turkish or English, e.g. 'Kılıf / Kasa' or 'Package / Case') or property id from get_category_filters."),
  values: z.array(z.string()).min(1).describe("One or more option values exactly as listed by get_category_filters (OR within a property)."),
  match: z
    .enum(["exact", "contains"])
    .optional()
    .describe("'exact' (default) or 'contains' to include every option containing the text (e.g. 'SOT23' → SOT23-3, SOT23-5...)."),
});

export const rangeSpecSchema = z.object({
  property: z
    .string()
    .describe(
      "Numeric property name or id (e.g. 'Çıkış Akımı' / 'Output Current'). Matching uses the site's semantics: products whose value " +
        "or value range (e.g. adjustable '1.2 to 37 V') overlaps [min, max] are included.",
    ),
  min: z.number().optional().describe("Lower bound (inclusive)."),
  max: z.number().optional().describe("Upper bound (inclusive)."),
  unit: z
    .string()
    .optional()
    .describe("Unit symbol for min/max as listed in get_category_filters (e.g. 'mA', 'kHz', 'µF', 'V'). If omitted, the property's base SI unit is used (A, Hz, F, V, Ω, B...)."),
});

function entryOut(e: CategoryEntry) {
  return {
    category: e.slug,
    name: e.name,
    path: e.path.join(" > "),
    level: e.level,
    product_count: e.productCount,
    has_subcategories: e.childCount > 0,
  };
}

function nodeOut(node: RawCategoryNode, depth: number): Record<string, unknown> {
  const children = node.subCategories ?? [];
  return {
    category: node.slug,
    name: node.name,
    product_count: node.productCount,
    subcategory_count: children.length || undefined,
    subcategories: depth > 1 && children.length ? children.map((c) => nodeOut(c, depth - 1)) : undefined,
  };
}

async function rankBothLanguages(
  ctx: ToolContext,
  query: string,
  lang: Language,
): Promise<Array<{ entry: CategoryEntry; score: number }>> {
  const primary = await ctx.client.getCategoryIndex(lang);
  const otherLang: Language = lang === "tr" ? "en" : "tr";
  const other: CategoryIndex | undefined = await ctx.client.getCategoryIndex(otherLang).catch(() => undefined);
  const scores = new Map<number, number>();
  for (const r of ctx.client.rankCategories(primary, query)) scores.set(r.entry.sequenceId, r.score);
  if (other) {
    for (const r of ctx.client.rankCategories(other, query)) {
      scores.set(r.entry.sequenceId, Math.max(scores.get(r.entry.sequenceId) ?? 0, r.score * 0.98));
    }
  }
  return [...scores.entries()]
    .map(([seq, score]) => ({ entry: primary.bySeq.get(seq)!, score }))
    .filter((x) => x.entry)
    .sort((a, b) => b.score - a.score || b.entry.productCount - a.entry.productCount || b.entry.level - a.entry.level);
}

function summarizeProperty(p: RawPropertyFilter, maxValues: number, valueQuery?: string, available?: Set<string>) {
  const all = (p.values ?? (p as unknown as { options?: RawPropertyFilter["values"] }).options ?? []).filter(
    (v) => !available || available.has(v.value),
  );
  let values = all.map((v) => v.value);
  if (valueQuery) {
    const fq = fold(valueQuery);
    const cq = compact(valueQuery);
    values = values.filter((v) => fold(v).includes(fq) || (cq && compact(v).includes(cq)));
  }
  const numeric = isNumericProperty(p);
  return {
    name: p.name,
    id: p.propertyId,
    type: numeric ? "numeric" : "text",
    units: numeric ? propertyUnits(p).map((u) => u.unit.symbol) : undefined,
    option_count: values.length,
    options: values.slice(0, maxValues),
    more_options: values.length > maxValues ? values.length - maxValues : undefined,
  };
}

export function registerCategoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_categories",
    {
      title: "Kategori ara",
      description:
        "Find Özdisan product categories by name or by what they contain. Matches Turkish and English category names " +
        "(e.g. 'mosfet', 'lineer regülatör', 'linear voltage regulator', 'MLCC', 'mikrodenetleyici'), and also lists the categories " +
        "whose products match the text. Use the returned 'category' slug with get_category_filters and filter_products. " +
        "Prefer the most specific (deepest) category for parametric filtering.",
      inputSchema: {
        query: z.string().min(1).describe("Category name or component type to look for."),
        limit: z.number().int().min(1).max(30).optional().describe("Maximum number of categories to return (default 10)."),
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async ({ query, limit, language }) => {
      const lang = ctx.client.lang(language);
      const max = limit ?? 10;
      const [ranked, productHits] = await Promise.all([
        rankBothLanguages(ctx, query, lang),
        ctx.client.searchCategoryTree({ search: query }, lang).catch(() => undefined),
      ]);
      const byName = ranked.filter((r) => r.score >= 0.55).slice(0, max).map((r) => ({ ...entryOut(r.entry), match_score: Math.round(r.score * 100) / 100 }));
      const leaves = productHits ? leafHits(productHits.categories).slice(0, max) : [];
      return {
        query,
        categories_by_name: byName,
        categories_with_matching_products: leaves.map((l) => ({
          category: l.slug,
          name: l.name,
          path: l.path.join(" > "),
          matching_products: l.count,
        })),
        total_matching_products: productHits?.totalCount,
        next_step:
          byName.length || leaves.length
            ? "Call get_category_filters with a 'category' slug to see its parametric filters, then filter_products."
            : "No category found. Try a broader or English/Turkish synonym, or use search_products.",
      };
    }),
  );

  server.registerTool(
    "browse_categories",
    {
      title: "Kategori ağacında gez",
      description:
        "Browse the Özdisan category tree (5 main groups → thousands of sub-categories, ~1M products). " +
        "Without 'category' returns the top-level groups; with 'category' returns that category's sub-categories. " +
        "Every node includes its product count and a 'category' slug usable in other tools.",
      inputSchema: {
        category: categoryInputSchema.optional(),
        depth: z.number().int().min(1).max(3).optional().describe("How many levels of sub-categories to include (default 1)."),
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async ({ category, depth, language }) => {
      const lang = ctx.client.lang(language);
      const index = await ctx.client.getCategoryIndex(lang);
      const d = depth ?? 1;
      if (!category) {
        return {
          total_products: index.totalCount,
          categories: index.roots.map((r) => nodeOut(r, d)),
        };
      }
      const entry = await ctx.client.resolveCategory(category, lang);
      const node = index.nodes.get(entry.sequenceId);
      const children = node?.subCategories ?? [];
      return {
        category: entryOut(entry),
        url: ctx.client.categoryUrl(entry.slug, lang),
        subcategories: children.map((c) => nodeOut(c, d)),
        note: children.length
          ? undefined
          : "This is a leaf category. Use get_category_filters and filter_products to list its products.",
      };
    }),
  );

  server.registerTool(
    "get_category_filters",
    {
      title: "Kategori filtrelerini getir",
      description:
        "List the parametric filters of a category: every technical property (e.g. package, voltage, current, capacitance, " +
        "tolerance), its type (numeric/text), units and selectable option values, plus manufacturers and stock/RoHS/document flags. " +
        "Use it before filter_products to pick exact option values. Pass 'property' to see all options of one property, " +
        "'value_query' to search inside options, and optionally the current filters to see only the options still available.",
      inputSchema: {
        category: categoryInputSchema,
        property: z.string().optional().describe("Only show this property (name or id) with all of its options."),
        value_query: z.string().optional().describe("Only show options containing this text (e.g. 'SOT23', '3.3 V')."),
        max_values: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Max options listed per property (default 25, or 300 when 'property' is given)."),
        filters: z.array(filterSpecSchema).optional().describe("Current value filters; options are then limited to those still available."),
        ranges: z.array(rangeSpecSchema).optional().describe("Current numeric range filters."),
        manufacturers: z.array(z.string()).optional().describe("Current manufacturer filter."),
        query: z.string().optional().describe("Current keyword search inside the category."),
        language: languageSchema,
      },
      annotations: readOnlyAnnotations,
    },
    handle(async (args) => {
      const lang = ctx.client.lang(args.language);
      const entry = await ctx.client.resolveCategory(args.category, lang);
      const meta = await ctx.client.getCategoryMeta(entry.sequenceId, lang);
      const props = meta.propertyFilters ?? [];
      if (!props.length) {
        throw new UserInputError(
          `"${entry.name}" kategorisinin doğrudan filtrelenebilir ürünü yok. Alt kategorilerinden birini seçin (browse_categories).`,
          { subcategories: (await ctx.client.getCategoryIndex(lang)).nodes.get(entry.sequenceId)?.subCategories?.slice(0, 30).map((c) => ({ category: c.slug, name: c.name, product_count: c.productCount })) },
        );
      }

      let available: Map<string, Set<string>> | undefined;
      let totalAfterFilters: number | undefined;
      const hasCurrent = !!(args.filters?.length || args.ranges?.length || args.manufacturers?.length || args.query);
      let applied: string[] | undefined;
      if (hasCurrent) {
        const resolved = resolveFilters(meta, {
          filters: args.filters,
          ranges: args.ranges,
          manufacturers: args.manufacturers,
        });
        applied = resolved.applied;
        const top = await ctx.client.getAvailableFilters(
          entry.sequenceId,
          { valueFilters: resolved.valueFilters, numericValueFilters: resolved.numericValueFilters },
          args.query,
          lang,
        );
        totalAfterFilters = top.totalCount;
        available = new Map(
          (top.propertyFilters ?? []).map((p) => [p.propertyId, new Set((p.values ?? []).filter((v) => !v.isDisabled).map((v) => v.value))]),
        );
      }

      if (args.property) {
        const prop = findProperty(props, args.property);
        if (!prop) {
          throw new UserInputError(`Bu kategoride "${args.property}" özelliği yok.`, {
            available_properties: props.map((p) => p.name),
          });
        }
        return {
          category: entryOut(entry),
          applied_filters: applied,
          matching_products: totalAfterFilters,
          property: summarizeProperty(prop, args.max_values ?? 300, args.value_query, available?.get(prop.propertyId)),
        };
      }

      const maxValues = args.max_values ?? 25;
      const sortable = (meta.tableProperties ?? []).filter((t) => t.isSortable && t.propertyId !== "Tags").map((t) => t.name);
      return {
        category: entryOut(entry),
        url: ctx.client.categoryUrl(entry.slug, lang),
        total_products: meta.variantList.totalCount,
        applied_filters: applied,
        matching_products: totalAfterFilters,
        flags: {
          in_stock: "Only products in stock",
          has_upcoming_stock: "Only products with incoming stock",
          rohs: "true = RoHS compliant, false = non-RoHS",
          has_datasheet: "Only products with a datasheet",
          discounted: "Only discounted/campaign products",
        },
        sort_by: ["price", "stock", "manufacturer", "moq", ...sortable],
        properties: props
          .map((p) => summarizeProperty(p, maxValues, args.value_query, available?.get(p.propertyId)))
          .filter((p) => !args.value_query || p.option_count > 0),
        usage:
          "filter_products: filters=[{property, values}] for text options (exact values from 'options'), " +
          "ranges=[{property, min, max, unit}] for numeric properties, manufacturers=[...] for brands.",
      };
    }),
  );
}
